package borgo

import (
	"bytes"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// /ws on the public port is the relay's, behind the guards every other path
// has: the app's middleware, the shared session answer, and the security
// headers on the 101. borgo.Push from the api reaches the socket in-process.
func TestFrontServesTheRelayOnWsAndPushReachesIt(t *testing.T) {
	resetTopicChecks(t)
	t.Setenv("SESSION_SECRET", checkSecret)
	CanSubscribe(func(r *http.Request, topic string) bool {
		s, ok := GetSession[testSession](r)
		return ok && topic == "user:"+s.User
	})
	security, err := securityFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	// the server's own config, as mountRelay hands it over
	relay := newWSRelay(wsRelayOptions{security: security})
	withProcessRelay(t, relay)
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the render service was asked for %s", r.URL.Path)
		w.WriteHeader(500)
	}))
	defer renderer.Close()
	renderURL, _ := url.Parse(renderer.URL)
	front := httptest.NewServer(newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, security: security, ws: relay}, renderURL, testInternalKey, time.Second))
	defer front.Close()
	cookie := setAndExtract(t, testSession{User: "ada"}, time.Hour)
	handshake := func(topic string) []byte {
		return []byte("GET /ws?topics=" + topic + " HTTP/1.1\r\nHost: app.test\r\nOrigin: http://app.test\r\n" +
			"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
			"Cookie: " + cookie.Name + "=" + cookie.Value + "\r\n\r\n")
	}
	p := dialWSRaw(t, front.URL, handshake("user:ada"))
	if p.res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("answered %d", p.res.StatusCode)
	}
	for _, kv := range staticSecurity {
		if got := p.res.Header.Get(kv[0]); got != kv[1] {
			t.Errorf("the 101 carries %s: %q, want %q", kv[0], got, kv[1])
		}
	}
	p.awaitCount("user:ada", 1, 2*time.Second)
	if err := Push("user:ada", "hello", 1); err != nil {
		t.Fatal(err)
	}
	if got := p.nextEvent(2 * time.Second); got != `{"topic":"user:ada","event":"hello","data":1}` {
		t.Fatalf("got %s", got)
	}
	// another user's topic: refused with the session the front verified
	q := dialWSRaw(t, front.URL, handshake("user:bob"))
	q.closed(wsCloseOriginRefused, "CanSubscribe", time.Second)
	// the dot-segment spelling never reaches the relay through the front:
	// the canonical rule every page is under answers a 308 to /ws first,
	// query kept, and the render service - which fails this test if asked -
	// is not consulted. The api-only port has no canonical rule, and judges
	// the spelling itself (TestApiAloneServesTheRelayOnWs)
	d := dialWSRaw(t, front.URL, bytes.Replace(handshake("user:ada"), []byte("GET /ws?"), []byte("GET /x/../ws?"), 1))
	if d.res.StatusCode != http.StatusPermanentRedirect || d.res.Header.Get("Location") != "/ws?topics=user:ada" {
		t.Fatalf("/x/../ws answered %d, Location %q", d.res.StatusCode, d.res.Header.Get("Location"))
	}
}

// an api with no pages serves the relay on the same port, behind the same
// guards, and nothing routes /ws around them
func TestApiAloneServesTheRelayOnWs(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(admitAll)
	relay := newWSRelay(wsRelayOptions{})
	withProcessRelay(t, relay)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/hello", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("hi")) })
	srv := httptest.NewServer(apiOnlyHandler(nil, 1<<20, nil, mux, relay))
	defer srv.Close()
	p := joinRelay(t, srv.URL, "topics=a")
	p.awaitCount("a", 1, 2*time.Second)
	if err := Push("a", "e", "x"); err != nil {
		t.Fatal(err)
	}
	if got := p.nextEvent(2 * time.Second); got != `{"topic":"a","event":"e","data":"x"}` {
		t.Fatalf("got %s", got)
	}
	// and the api is still the api
	res, err := http.Get(srv.URL + "/api/hello")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("/api/hello: %v %v", res, err)
	}
	// a socket over the dot-segment spelling of /ws is judged as /ws: the
	// relay, not the api's 404
	conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.Write([]byte("GET /x/../ws?topics=a HTTP/1.1\r\nHost: app.test\r\nOrigin: http://app.test\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"))
	buf := make([]byte, 64)
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _ := conn.Read(buf)
	if !strings.HasPrefix(string(buf[:n]), "HTTP/1.1 101") {
		t.Fatalf("/x/../ws answered %q", buf[:n])
	}
}

// a raw handshake on a path of the caller's spelling, with extra header lines
func wsHandshakeOn(path string, extra ...string) []byte {
	lines := append([]string{"GET " + path + " HTTP/1.1", "Host: app.test", "Origin: http://app.test",
		"Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"}, extra...)
	return []byte(strings.Join(lines, "\r\n") + "\r\n\r\n")
}

// every spelling that cleans to /ws is judged by the app's middleware first,
// on both ports, and a name that merely starts with /ws is not the relay's
func TestWsSitsBehindTheAppMiddlewareOnBothPorts(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(admitAll)
	relay := newWSRelay(wsRelayOptions{})
	withProcessRelay(t, relay)
	probe := &probeMiddleware{}
	app := probe.app("/ws")
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer renderer.Close()
	renderURL, _ := url.Parse(renderer.URL)
	front := httptest.NewServer(newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, app: app, ws: relay}, renderURL, testInternalKey, time.Second))
	defer front.Close()
	api := httptest.NewServer(apiOnlyHandler(nil, 1<<20, app, http.NewServeMux(), relay))
	defer api.Close()
	spellings := []string{"/ws", "/ws/", "//ws", "/./ws", "/x/../ws", "/%77s", "/ws%2F"}
	ports := []struct{ name, base string }{{"front", front.URL}, {"api", api.URL}}
	for _, port := range ports {
		for _, path := range spellings {
			p := dialWSRaw(t, port.base, wsHandshakeOn(path+"?topics=a", "X-Block: 1"))
			if p.res.StatusCode == http.StatusSwitchingProtocols {
				t.Errorf("%s: %s reached the relay around the app's middleware", port.name, path)
			}
		}
		p := dialWSRaw(t, port.base, wsHandshakeOn("/wsx?topics=a"))
		if p.res.StatusCode == http.StatusSwitchingProtocols {
			t.Errorf("%s: /wsx reached the relay", port.name)
		}
	}
	if atomic.LoadInt32(&probe.seen) == 0 {
		t.Fatal("the app's middleware never ran")
	}
	// the api-only port has no canonical rule and admits every spelling once
	// the middleware does; the front answers 308 to the aliases, and its
	// /ws is TestFrontServesTheRelayOnWsAndPushReachesIt
	for _, path := range spellings {
		p := dialWSRaw(t, api.URL, wsHandshakeOn(path+"?topics=a"))
		if p.res.StatusCode != http.StatusSwitchingProtocols {
			t.Errorf("api: %s answered %d", path, p.res.StatusCode)
		}
	}
}

// one handshake over several topics reads the session once, on both ports:
// the check runs a single time for the request, as it does for a page
func TestWsHandshakeSharesOneSessionCheck(t *testing.T) {
	resetTopicChecks(t)
	t.Setenv("SESSION_SECRET", checkSecret)
	var checks int32
	withCheck(t, func(*http.Request, SessionInfo) bool {
		atomic.AddInt32(&checks, 1)
		return true
	})
	CanSubscribe(func(r *http.Request, topic string) bool {
		_, ok := GetSession[testSession](r)
		return ok
	})
	security, err := securityFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	relay := newWSRelay(wsRelayOptions{security: security})
	withProcessRelay(t, relay)
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the render service was asked for %s", r.URL.Path)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer renderer.Close()
	renderURL, _ := url.Parse(renderer.URL)
	front := httptest.NewServer(newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, security: security, ws: relay}, renderURL, testInternalKey, time.Second))
	defer front.Close()
	api := httptest.NewServer(apiOnlyHandler(security, 1<<20, nil, http.NewServeMux(), relay))
	defer api.Close()
	cookie := setAndExtract(t, testSession{User: "ada"}, time.Hour)
	for i, port := range []struct{ name, base string }{{"front", front.URL}, {"api", api.URL}} {
		atomic.StoreInt32(&checks, 0)
		p := dialWSRaw(t, port.base, wsHandshakeOn("/ws?topics=a,b,c", "Cookie: "+cookie.Name+"="+cookie.Value))
		if p.res.StatusCode != http.StatusSwitchingProtocols {
			t.Fatalf("%s: answered %d", port.name, p.res.StatusCode)
		}
		// the socket of the port before stays subscribed, hence the count
		p.awaitCount("a", i+1, 2*time.Second)
		if got := atomic.LoadInt32(&checks); got != 1 {
			t.Errorf("%s: the session was checked %d times for one handshake", port.name, got)
		}
	}
}

// the relay Serve mounts takes its trusted proxies from the environment:
// behind a proxy terminating TLS an https Origin is judged against the scheme
// the proxy forwarded, and against the bare connection's once no proxy is
// trusted
func TestMountedRelayTrustsProxiesFromEnv(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(admitAll)
	forwarded := bytes.Replace(wsHandshakeOn("/ws?topics=a", "X-Forwarded-Proto: https"),
		[]byte("Origin: http://app.test"), []byte("Origin: https://app.test"), 1)
	for _, tc := range []struct {
		proxies  string
		admitted bool
	}{{"", true}, {"none", false}} {
		t.Run("BORGO_TRUSTED_PROXIES="+tc.proxies, func(t *testing.T) {
			t.Setenv("BORGO_TRUSTED_PROXIES", tc.proxies)
			withProcessRelay(t, nil)
			relay, err := mountRelay(nil)
			if err != nil {
				t.Fatal(err)
			}
			srv := httptest.NewServer(relay)
			defer srv.Close()
			p := dialWSRaw(t, srv.URL, forwarded)
			if p.res.StatusCode != http.StatusSwitchingProtocols {
				t.Fatalf("answered %d", p.res.StatusCode)
			}
			if tc.admitted {
				p.awaitCount("a", 1, 2*time.Second)
			} else {
				p.closed(wsCloseOriginRefused, "origin", time.Second)
			}
		})
	}
}
