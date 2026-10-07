package borgo

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testInternalKey = "0123456789abcdef0123456789abcdef"

// a renderer that records what reached it and answers with a marker
func fakeRenderer(t *testing.T, seen *http.Header) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if seen != nil {
			*seen = r.Header.Clone()
			seen.Set("X-Test-Host", r.Host)
			seen.Set("X-Test-Path", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-Borgo-Cache", "miss")
		// never set by the real render service; the front must not relay
		// them if it ever were
		w.Header().Set(internalKeyHeader, "leak")
		w.Header().Set(sessionHeader, "leak")
		w.WriteHeader(200)
		io.WriteString(w, "<html>rendered "+r.URL.Path+"</html>")
	}))
}

func apiUnderTest() http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/hello", func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, 200, map[string]string{"message": "hello"})
	})
	api.HandleFunc("POST /api/tasks", func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, 201, map[string]string{"created": "yes"})
	})
	api.HandleFunc("GET /healthz", healthz)
	return Middleware(api)
}

// every peer trusted, as the tests before step 2a assumed
var trustAll = func() []*net.IPNet {
	_, v4, _ := net.ParseCIDR("0.0.0.0/0")
	_, v6, _ := net.ParseCIDR("::/0")
	return []*net.IPNet{v4, v6}
}()

func frontUnderTest(t *testing.T, renderer *httptest.Server, csrf bool) http.Handler {
	t.Helper()
	return frontWith(t, renderer, frontOptions{csrf: csrf, trusted: trustAll})
}

func frontWith(t *testing.T, renderer *httptest.Server, opts frontOptions) http.Handler {
	t.Helper()
	u, err := url.Parse(renderer.URL)
	if err != nil {
		t.Fatal(err)
	}
	return newFrontHandler(apiUnderTest(), opts, u, testInternalKey, time.Second)
}

func TestFrontAnswersApiInProcess(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)

	w := httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/api/hello", nil))
	if w.Code != 200 || strings.Contains(w.Body.String(), "rendered") {
		t.Fatalf("/api/hello: %d %s", w.Code, w.Body.String())
	}
	if seen != nil {
		t.Fatal("an in-process path was forwarded")
	}
	// /healthz is the front's own: it PROBES the render service and reports it
	w = httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "\"render\":\"reachable\"") {
		t.Fatalf("/healthz: %d %s", w.Code, w.Body.String())
	}
	// a dot-segment spelling is decided on its cleaned form and lands on the
	// mux, which answers the canonical spelling with net/http's own redirect
	seen = nil
	w = httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/x/../api/hello", nil))
	if w.Code != 307 || w.Header().Get("Location") != "/api/hello" {
		t.Fatalf("/x/../api/hello: %d %q", w.Code, w.Header().Get("Location"))
	}
	if seen != nil {
		t.Fatal("an in-process path was forwarded")
	}
}

func TestFrontForwardsPagesWithTheBootKey(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)

	req := httptest.NewRequest("GET", "http://app.example/about?x=1", nil)
	req.Host = "app.example"
	// a client presenting the internal names must not get them through
	req.Header.Set(internalKeyHeader, "forged")
	req.Header.Set(sessionHeader, "forged")
	w := httptest.NewRecorder()
	front.ServeHTTP(w, req)

	if w.Code != 200 || !strings.Contains(w.Body.String(), "rendered /about") {
		t.Fatalf("page not forwarded: %d %s", w.Code, w.Body.String())
	}
	if got := seen.Get(internalKeyHeader); got != testInternalKey {
		t.Errorf("renderer saw key %q, want this boot's", got)
	}
	if got := seen.Get(sessionHeader); got != "" {
		t.Errorf("a forged session header reached the renderer: %q", got)
	}
	if got := seen.Get("X-Test-Host"); got != "app.example" {
		t.Errorf("renderer saw Host %q, want the browser's", got)
	}
	if got := seen.Get("X-Forwarded-Host"); got != "app.example" {
		t.Errorf("X-Forwarded-Host %q", got)
	}
	if got := w.Header().Get("X-Borgo-Cache"); got != "miss" {
		t.Errorf("renderer's headers did not reach the client: %q", got)
	}
	// and the names stay between the processes in the other direction too
	for _, name := range []string{internalKeyHeader, sessionHeader} {
		if got := w.Header().Get(name); got != "" {
			t.Errorf("response header %s reached the client: %q", name, got)
		}
	}
}

// behind a tls-terminating proxy the render service must still see the
// scheme the browser used, or every websocket origin is refused; and the
// client chain a proxy built is kept, with this hop appended
func TestFrontKeepsTheForwardedChainItWasHanded(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)

	req := httptest.NewRequest("GET", "/live", nil)
	req.RemoteAddr = "10.0.0.5:4444"
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	front.ServeHTTP(httptest.NewRecorder(), req)

	if got := seen.Get("X-Forwarded-Proto"); got != "https" {
		t.Errorf("X-Forwarded-Proto %q, want the scheme the proxy in front saw", got)
	}
	if got := seen.Get("X-Forwarded-For"); got != "203.0.113.9, 10.0.0.5" {
		t.Errorf("X-Forwarded-For %q, want the chain with this hop appended", got)
	}

	// and with nothing in front, the facts are this connection's
	seen = nil
	bare := httptest.NewRequest("GET", "/live", nil)
	bare.RemoteAddr = "10.0.0.5:4444"
	front.ServeHTTP(httptest.NewRecorder(), bare)
	if got := seen.Get("X-Forwarded-Proto"); got != "http" {
		t.Errorf("X-Forwarded-Proto %q with no proxy in front", got)
	}
	if got := seen.Get("X-Forwarded-For"); got != "10.0.0.5" {
		t.Errorf("X-Forwarded-For %q with no proxy in front", got)
	}
}

func TestFrontForwardsAVerifiedSessionAsAFact(t *testing.T) {
	t.Setenv("SESSION_SECRET", "a-test-secret-of-at-least-32-bytes-long")
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)

	issued := httptest.NewRecorder()
	if err := SetSession(issued, map[string]any{"userId": 7, "role": "admin"}, time.Hour); err != nil {
		t.Fatal(err)
	}
	cookie := issued.Result().Cookies()[0]

	req := httptest.NewRequest("GET", "/app", nil)
	req.AddCookie(cookie)
	front.ServeHTTP(httptest.NewRecorder(), req)
	raw, err := base64.RawURLEncoding.DecodeString(seen.Get(sessionHeader))
	if err != nil {
		t.Fatalf("session header is not base64url: %v", err)
	}
	if string(raw) != `{"role":"admin","userId":7}` {
		t.Errorf("session payload %s", raw)
	}
	// the wire form, byte for byte: unpadded base64url. session-context.test.ts
	// decodes this same literal on the render side, so the two halves are
	// pinned to one encoding rather than each to its own
	if got := seen.Get(sessionHeader); got != "eyJyb2xlIjoiYWRtaW4iLCJ1c2VySWQiOjd9" {
		t.Errorf("session header on the wire %q", got)
	}

	// tampered: no fact travels, and the cookie is not the render service's
	// to judge
	bad := httptest.NewRequest("GET", "/app", nil)
	bad.AddCookie(&http.Cookie{Name: cookie.Name, Value: cookie.Value[:len(cookie.Value)-2] + "xx"})
	seen = nil
	front.ServeHTTP(httptest.NewRecorder(), bad)
	if got := seen.Get(sessionHeader); got != "" {
		t.Errorf("a tampered cookie produced a session header: %q", got)
	}

	// expired: signed by this server, and still no fact
	stale := httptest.NewRecorder()
	if err := SetSession(stale, map[string]any{"userId": 7}, -time.Hour); err != nil {
		t.Fatal(err)
	}
	expired := httptest.NewRequest("GET", "/app", nil)
	expired.AddCookie(stale.Result().Cookies()[0])
	seen = nil
	front.ServeHTTP(httptest.NewRecorder(), expired)
	if got := seen.Get(sessionHeader); got != "" {
		t.Errorf("an expired cookie produced a session header: %q", got)
	}
}

// in dev the fast-refresh channel is the one internal name a browser may
// reach, answered by this process as an event stream and never forwarded;
// its pokes are the internal listener's, and every other internal name is
// nothing, in dev as in production
func TestFrontAnswersTheDevChannelInDevOnly(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	dev := httptest.NewServer(frontWith(t, renderer, frontOptions{trusted: trustAll, dev: true, devCh: newDevChannel()}))
	defer dev.Close()
	res, err := http.Get(dev.URL + "/__borgo/dev")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "text/event-stream" || seen != nil {
		t.Errorf("dev channel in dev: %d %q forwarded=%v", res.StatusCode, res.Header.Get("Content-Type"), seen != nil)
	}
	for _, p := range []string{"/__borgo/dev/reload", "/__borgo/dev/css", "/__borgo/dev/js", "/__borgo/routes", "/__borgo/render"} {
		seen = nil
		r, err := http.Post(dev.URL+p, "application/json", nil)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		if r.StatusCode != 404 || seen != nil {
			t.Errorf("%s in dev: %d forwarded=%v", p, r.StatusCode, seen != nil)
		}
	}
	// production, and the two halves of the decision apart: a channel with
	// no dev flag, a dev flag with no channel - neither is the stream
	for name, opts := range map[string]frontOptions{
		"production":            {trusted: trustAll},
		"a channel but not dev": {trusted: trustAll, devCh: newDevChannel()},
		"dev but no channel":    {trusted: trustAll, dev: true},
	} {
		seen = nil
		w := httptest.NewRecorder()
		frontWith(t, renderer, opts).ServeHTTP(w, httptest.NewRequest("GET", "/__borgo/dev", nil))
		if w.Code != 404 || seen != nil {
			t.Errorf("dev channel, %s: %d forwarded=%v", name, w.Code, seen != nil)
		}
	}
}

func TestFrontInternalNamesAreNotPublic(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)

	// the dot-segment spellings are the ones that passed a prefix test and
	// were normalised into the internal name at the far end
	for _, path := range []string{"/__borgo/routes", "/__borgo", "/x/../__borgo/routes", "/./__borgo/dev", "//__borgo/routes", "/__borgo/dev/../routes"} {
		w := httptest.NewRecorder()
		front.ServeHTTP(w, httptest.NewRequest("POST", path, strings.NewReader(`{}`)))
		if w.Code != 404 {
			t.Errorf("%s on the public port answered %d", path, w.Code)
		}
	}
	if seen != nil {
		t.Fatalf("an internal name was forwarded as %q", seen.Get("X-Test-Path"))
	}
}

func TestFrontRunsTheCsrfCheckBunUsedToRun(t *testing.T) {
	renderer := fakeRenderer(t, nil)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, true)

	post := func(cookie, header string) int {
		req := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		if header != "" {
			req.Header.Set(csrfHeader, header)
		}
		w := httptest.NewRecorder()
		front.ServeHTTP(w, req)
		return w.Code
	}
	if got := post("", ""); got != 201 {
		t.Errorf("a cookie-less client (curl, a mobile app) answered %d", got)
	}
	if got := post("borgo_csrf=tok", ""); got != 403 {
		t.Errorf("a browser with the cookie and no header answered %d", got)
	}
	if got := post("borgo_csrf=tok", "wrong"); got != 403 {
		t.Errorf("a wrong header answered %d", got)
	}
	if got := post("borgo_csrf=tok; borgo_csrf=other", "tok"); got != 403 {
		t.Errorf("disagreeing duplicate cookies answered %d", got)
	}
	if got := post("borgo_csrf=tok", "tok"); got != 201 {
		t.Errorf("the echoed token answered %d", got)
	}
	// safe methods are never asked
	req := httptest.NewRequest("GET", "/api/hello", nil)
	req.Header.Set("Cookie", "borgo_csrf=tok")
	w := httptest.NewRecorder()
	front.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Errorf("a GET with the cookie and no header answered %d", w.Code)
	}
	// and the internal listener, which only the render service reaches with
	// the browser's cookies re-sent by a loader, is not guarded
	internal := requireInternalKey(testInternalKey, apiUnderTest())
	req = httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{}`))
	req.Header.Set("Cookie", "borgo_csrf=tok")
	req.Header.Set(internalKeyHeader, testInternalKey)
	w = httptest.NewRecorder()
	internal.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Errorf("the internal listener ran the csrf check: %d", w.Code)
	}
}

func TestFrontSaysWhenTheRendererIsDown(t *testing.T) {
	renderer := fakeRenderer(t, nil)
	renderer.Close() // the address is known and nothing listens
	front := frontUnderTest(t, renderer, false)

	w := httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/about", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("renderer down answered %d", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Error("a 503 must say when to come back")
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("the refusal page is served without nosniff")
	}
	if !strings.Contains(w.Body.String(), "the api is up") {
		t.Errorf("the page does not say what still works: %q", w.Body.String())
	}

	// and the api is, in fact, up
	w = httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/api/hello", nil))
	if w.Code != 200 {
		t.Fatalf("api answered %d with the renderer down", w.Code)
	}
}

func TestFrontRendererTimeoutIs504(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(2 * time.Second):
		case <-r.Context().Done():
		}
	}))
	defer slow.Close()
	u, _ := url.Parse(slow.URL)
	front := newFrontHandler(Middleware(http.NewServeMux()), frontOptions{}, u, testInternalKey, 50*time.Millisecond)

	w := httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/slow", nil))
	if w.Code != http.StatusGatewayTimeout {
		t.Fatalf("a renderer past its header deadline answered %d", w.Code)
	}
}

func TestInternalListenerRequiresTheBootKey(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })
	guarded := requireInternalKey(testInternalKey, inner)

	for _, tc := range []struct {
		key  string
		want int
	}{
		{"", 403},
		{"wrong", 403},
		{testInternalKey + "x", 403},
		{testInternalKey, 204},
	} {
		req := httptest.NewRequest("GET", "/api/hello", nil)
		if tc.key != "" {
			req.Header.Set(internalKeyHeader, tc.key)
		}
		w := httptest.NewRecorder()
		guarded.ServeHTTP(w, req)
		if w.Code != tc.want {
			t.Errorf("key %q: %d, want %d", tc.key, w.Code, tc.want)
		}
	}
}

func TestFrontModeRefusesAnUnusableEnvironment(t *testing.T) {
	// no renderer named: an api serving its own port, not a refusal
	t.Setenv("BORGO_RENDER_URL", "")
	if u, err := renderURL(); u != nil || err != nil {
		t.Errorf("an api with no render service: %v %v", u, err)
	}
	t.Setenv("BORGO_INTERNAL_KEY", "short")
	if _, err := internalKey(); err == nil || !strings.Contains(err.Error(), "BORGO_INTERNAL_KEY") {
		t.Errorf("a short key was accepted: %v", err)
	}
	t.Setenv("BORGO_INTERNAL_KEY", testInternalKey)
	for _, bad := range []string{"127.0.0.1:3600", "http://127.0.0.1:3600/render", "http://user:pw@127.0.0.1:3600", "ftp://x"} {
		t.Setenv("BORGO_RENDER_URL", bad)
		if _, err := renderURL(); err == nil {
			t.Errorf("BORGO_RENDER_URL=%q was accepted", bad)
		}
	}
	t.Setenv("BORGO_RENDER_URL", "http://127.0.0.1:3600/")
	u, err := renderURL()
	if err != nil || u.String() != "http://127.0.0.1:3600" {
		t.Errorf("a trailing slash is a host: %v %v", u, err)
	}
	t.Setenv("PORT", "80;ls")
	if _, err := envPublicPort(); err == nil {
		t.Error("PORT=80;ls was read as a port")
	}
}

// a public port cannot believe a header anyone on the internet can write:
// the forwarded chain and scheme are kept only from a trusted peer
func TestFrontBelievesForwardedHeadersFromTrustedPeersOnly(t *testing.T) {
	_, lan, _ := net.ParseCIDR("10.0.0.0/8")
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontWith(t, renderer, frontOptions{trusted: []*net.IPNet{lan}})

	forwarded := func(peer string) http.Header {
		req := httptest.NewRequest("GET", "/live", nil)
		req.RemoteAddr = peer
		req.Header.Set("X-Forwarded-Proto", "https")
		req.Header.Set("X-Forwarded-For", "203.0.113.9")
		req.Header.Set("Forwarded", "for=203.0.113.9")
		seen = nil
		front.ServeHTTP(httptest.NewRecorder(), req)
		return seen
	}
	got := forwarded("10.0.0.5:4444")
	if got.Get("X-Forwarded-Proto") != "https" || got.Get("X-Forwarded-For") != "203.0.113.9, 10.0.0.5" {
		t.Errorf("a trusted proxy's facts were not kept: %v", got)
	}
	got = forwarded("198.51.100.7:4444")
	if got.Get("X-Forwarded-Proto") != "http" || got.Get("X-Forwarded-For") != "198.51.100.7" {
		t.Errorf("an internet client's claims were believed: proto %q for %q", got.Get("X-Forwarded-Proto"), got.Get("X-Forwarded-For"))
	}
	if got.Get("Forwarded") != "" {
		t.Errorf("an internet client's Forwarded header reached the renderer: %q", got.Get("Forwarded"))
	}

	// nobody trusted: the loopback peer is a client like any other
	front = frontWith(t, renderer, frontOptions{trusted: nil})
	got = forwarded("127.0.0.1:4444")
	if got.Get("X-Forwarded-Proto") != "http" {
		t.Errorf(`with "none" the loopback peer was believed: %q`, got.Get("X-Forwarded-Proto"))
	}
}

func TestTrustedProxiesGrammar(t *testing.T) {
	t.Setenv("BORGO_TRUSTED_PROXIES", "")
	nets, err := trustedProxies()
	if err != nil || !peerTrusted("127.0.0.1:1", nets) || !peerTrusted("[::1]:1", nets) || !peerTrusted("192.168.1.9:1", nets) || peerTrusted("8.8.8.8:1", nets) {
		t.Errorf("the default is loopback and the private ranges: %v %v", nets, err)
	}
	t.Setenv("BORGO_TRUSTED_PROXIES", "none")
	if nets, err = trustedProxies(); err != nil || nets != nil {
		t.Errorf(`"none" must trust nobody: %v %v`, nets, err)
	}
	t.Setenv("BORGO_TRUSTED_PROXIES", "203.0.113.4, 2001:db8::/32")
	nets, err = trustedProxies()
	if err != nil || !peerTrusted("203.0.113.4:80", nets) || peerTrusted("203.0.113.5:80", nets) || !peerTrusted("[2001:db8::9]:80", nets) {
		t.Errorf("a list of an address and a cidr: %v %v", nets, err)
	}
	for _, bad := range []string{"nginx", "10.0.0.0/33", "203.0.113.4,"[:len("203.0.113.4,")-1] + ",x"} {
		t.Setenv("BORGO_TRUSTED_PROXIES", bad)
		if _, err := trustedProxies(); err == nil {
			t.Errorf("BORGO_TRUSTED_PROXIES=%q was accepted", bad)
		}
	}
}

// the cap bun applied to every body it read, counted as read: a chunked
// body that declares nothing still cannot pass it
func TestFrontCountsThePublicBodyAgainstMaxBody(t *testing.T) {
	renderer := fakeRenderer(t, nil)
	defer renderer.Close()
	api := http.NewServeMux()
	api.HandleFunc("POST /api/echo", func(w http.ResponseWriter, r *http.Request) {
		body, err := Bind[map[string]string](r)
		if err != nil {
			BindError(w, err)
			return
		}
		WriteJSON(w, 200, body)
	})
	u, _ := url.Parse(renderer.URL)
	front := newFrontHandler(Middleware(api), frontOptions{maxBody: 64, trusted: trustAll}, u, testInternalKey, time.Second)

	small := httptest.NewRequest("POST", "/api/echo", strings.NewReader(`{"a":"b"}`))
	small.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	front.ServeHTTP(w, small)
	if w.Code != 200 {
		t.Fatalf("a body under the cap answered %d", w.Code)
	}
	big := httptest.NewRequest("POST", "/api/echo", strings.NewReader(`{"a":"`+strings.Repeat("x", 100)+`"}`))
	big.Header.Set("Content-Type", "application/json")
	big.ContentLength = -1 // chunked: nothing declared, only counted
	w = httptest.NewRecorder()
	front.ServeHTTP(w, big)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("a chunked body over the cap answered %d", w.Code)
	}
}

func TestMaxBodyGrammar(t *testing.T) {
	t.Setenv("BORGO_MAX_BODY", "")
	if n, err := envMaxBody(); err != nil || n != defaultMaxBody {
		t.Errorf("default: %d %v", n, err)
	}
	t.Setenv("BORGO_MAX_BODY", "0")
	if n, err := envMaxBody(); err != nil || n != 0 {
		t.Errorf("0 is no limit: %d %v", n, err)
	}
	for _, bad := range []string{"0.5", "-1", "1e6", "10MB", " 5"} {
		t.Setenv("BORGO_MAX_BODY", bad)
		if _, err := envMaxBody(); err == nil {
			t.Errorf("BORGO_MAX_BODY=%q was accepted", bad)
		}
	}
}

func TestPublicServerHasDeadlinesUnlessTheOperatorSetThem(t *testing.T) {
	t.Setenv("BORGO_READ_TIMEOUT", "")
	t.Setenv("BORGO_WRITE_TIMEOUT", "")
	srv, err := newServer("0", nil)
	if err != nil {
		t.Fatal(err)
	}
	publicTimeouts(srv)
	if srv.ReadTimeout != defaultPublicTimeout || srv.WriteTimeout != defaultPublicTimeout {
		t.Errorf("public deadlines %v/%v, want %v", srv.ReadTimeout, srv.WriteTimeout, defaultPublicTimeout)
	}
	t.Setenv("BORGO_WRITE_TIMEOUT", "0")
	srv, _ = newServer("0", nil)
	publicTimeouts(srv)
	if srv.WriteTimeout != 0 || srv.ReadTimeout != defaultPublicTimeout {
		t.Errorf("an operator's explicit 0 was overridden: %v/%v", srv.ReadTimeout, srv.WriteTimeout)
	}
}

// every response written on the public port carries the headers, the
// proxy's own refusals and the renderer's answers alike
func TestFrontPutsSecurityHeadersOnWhatItAuthors(t *testing.T) {
	t.Setenv("BORGO_SECURITY_HEADERS", "")
	t.Setenv("BORGO_CSP", "")
	cfg, _ := securityFromEnv()
	renderer := fakeRenderer(t, nil)
	defer renderer.Close()
	front := frontWith(t, renderer, frontOptions{security: cfg, trusted: trustAll})

	for _, path := range []string{"/api/hello", "/api/nope", "/__borgo/routes", "/about"} {
		w := httptest.NewRecorder()
		front.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("X-Frame-Options") != "DENY" {
			t.Errorf("%s (%d): static headers missing: %v", path, w.Code, w.Header())
		}
	}
	// the renderer's page is html without a csp of its own here, so this side's applies
	w := httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/about", nil))
	if w.Header().Get("Content-Security-Policy") != cspDefault {
		t.Errorf("proxied html without a csp: %q", w.Header().Get("Content-Security-Policy"))
	}

	renderer.Close()
	w = httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/about", nil))
	if w.Code != 503 || w.Header().Get("X-Frame-Options") != "DENY" {
		t.Errorf("the proxy's own 503 went out bare: %d %v", w.Code, w.Header())
	}
}

// A peer address that is not an IP is a peer this process cannot place, and
// the only safe answer is "not trusted": what trust buys is believing the
// client facts in X-Forwarded-*, and believing them from an address we
// cannot compare against a CIDR is believing anyone. A unix socket and a
// Windows named pipe both arrive here as a RemoteAddr that does not parse.
// The verifier of this phase inverted this branch and no test noticed.
func TestPeerTrustedFailsClosedOnAnAddressItCannotPlace(t *testing.T) {
	_, all, _ := net.ParseCIDR("0.0.0.0/0")
	_, v6, _ := net.ParseCIDR("::/0")
	widest := []*net.IPNet{all, v6}

	unplaceable := []string{
		"",                // no peer at all
		"@",               // a linux abstract socket
		"/tmp/borgo.sock", // a unix socket
		`\.\pipe\borgo`,   // a windows named pipe
		"not-an-ip:443",   // a name where an address belongs
		"localhost:3000",  // resolvable, but not an address
		"[::1",            // a malformed v6 literal
		"192.168.1.999:1", // out of range
	}
	for _, addr := range unplaceable {
		if peerTrusted(addr, widest) {
			t.Errorf("%q was trusted against the widest possible list", addr)
		}
	}

	// and the guard is not simply refusing everything: a real peer inside
	// the list is still trusted, in both families, with and without a port
	for _, addr := range []string{"10.0.0.4:51000", "10.0.0.4", "[2001:db8::1]:443", "2001:db8::1"} {
		if !peerTrusted(addr, widest) {
			t.Errorf("%q was not trusted, and it is inside the list", addr)
		}
	}
	// an empty list trusts nobody, whatever the address
	if peerTrusted("10.0.0.4:51000", nil) {
		t.Error("an empty trust list trusted a peer")
	}
}

// The security headers are applied by authorship, on the whole public port -
// and an upgrade was the one response that escaped, because ReverseProxy
// hijacks the connection and writes the 101 to the socket itself, past the
// wrapper that would have added them. Found by the verifier of phase 1 and
// left documented for an hour, which is not the same as fixed.
func TestTheHandshakeCarriesTheSecurityHeadersToo(t *testing.T) {
	// a render service that upgrades, as the topic relay does
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(internalKeyHeader) != testInternalKey {
			w.WriteHeader(403)
			return
		}
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
	}))
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	security, err := securityFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	front := httptest.NewServer(newFrontHandler(
		apiUnderTest(),
		frontOptions{trusted: trustAll, security: security},
		u, testInternalKey, time.Second,
	))
	defer front.Close()

	// the handshake has to be spoken by hand: the client must not follow or
	// buffer, so the 101's own header block is what we read
	conn, err := net.Dial("tcp", strings.TrimPrefix(front.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "GET /ws HTTP/1.1\r\nHost: app.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("the upgrade answered %d", res.StatusCode)
	}
	for _, kv := range staticSecurity {
		if got := res.Header.Get(kv[0]); got != kv[1] {
			t.Errorf("the handshake carries %s: %q, want %q", kv[0], got, kv[1])
		}
	}
	// and no csp: a 101 has no content type, and a policy on a socket is
	// noise a client has to parse
	if csp := res.Header.Get("Content-Security-Policy"); csp != "" {
		t.Errorf("the handshake carries a csp: %q", csp)
	}
}

// BORGO_RENDER_TIMEOUT is the operator's deadline for a render, and a shared
// render is a render. The cache's own client had it hardcoded at 30s while
// the proxy read the variable: the transport's header wait was shared, so a
// render that never answered WAS cut - but one that answered its headers and
// then stalled ran to 30 seconds, on a request the visitor was waiting for.
// Found by the verifier of this phase.
func TestTheSharedRenderHonoursTheOperatorsDeadline(t *testing.T) {
	var cut chan struct{}
	var shared, own int32
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == routesPath {
			w.Header().Set(bootHeader, "1")
			json.NewEncoder(w).Encode(map[string]any{"boot": 1, "routes": []map[string]any{
				{"pattern": "/slow", "seconds": 60, "tags": []string{}},
			}})
			return
		}
		// headers at once, then a stall: the transport's header deadline
		// cannot see this, so only the client's whole-request deadline can
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(200)
		io.WriteString(w, "<html>")
		http.NewResponseController(w).Flush()
		if r.Header.Get(sharedRenderHeader) == "1" {
			atomic.AddInt32(&shared, 1)
			// the shared render waits to be cut, and says when it was
			select {
			case <-r.Context().Done():
				close(cut)
			case <-time.After(5 * time.Second):
			}
			return
		}
		atomic.AddInt32(&own, 1)
		time.Sleep(300 * time.Millisecond)
		io.WriteString(w, "streamed</html>")
	}))
	defer renderer.Close()
	cut = make(chan struct{})
	u, _ := url.Parse(renderer.URL)
	pages := newIsr(nil, nil, func(string) {})
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: pages}, u, testInternalKey, 200*time.Millisecond)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "http://app.example/slow", nil)
	req.Host = "app.example"
	front.ServeHTTP(w, req)

	// the shared render was abandoned at the operator's deadline, not at 30s
	select {
	case <-cut:
	case <-time.After(2 * time.Second):
		t.Fatal("the shared render was not cut at the deadline the front was given")
	}
	// and the visitor still gets their page: their own render streams for
	// longer than the deadline, which is what a header-only deadline on the
	// hop exists to allow
	if w.Code != 200 || !strings.Contains(w.Body.String(), "streamed") {
		t.Errorf("the visitor got %d %q", w.Code, w.Body.String())
	}
	if w.Header().Get(cacheStateHeader) != "bypass" {
		t.Errorf("the visitor's answer is marked %q", w.Header().Get(cacheStateHeader))
	}
	if atomic.LoadInt32(&shared) != 1 || atomic.LoadInt32(&own) != 1 {
		t.Errorf("shared=%d own=%d", shared, own)
	}
}

// The policy table is reloaded when the render service's boot stamp changes.
// That stamp was only read from responses the PROXY carried, so a render
// service restarted under a live front was never noticed as long as traffic
// was answered from the cache or from a shared render: new pages never
// became cacheable and changed tags dropped the wrong set, forever. Found by
// the verifier of this phase.
func TestASharedRenderNoticesTheRenderServiceRestarting(t *testing.T) {
	svc := &fakeRenderService{boot: 1}
	renderer := httptest.NewServer(svc.handler())
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	pages := newIsr(nil, nil, func(string) {})
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: pages}, u, testInternalKey, time.Second)
	get := func(p string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "http://app.example"+p, nil)
		req.Host = "app.example"
		w := httptest.NewRecorder()
		front.ServeHTTP(w, req)
		return w
	}

	// a cacheable page, answered by a shared render: the proxy carries nothing
	if state := get("/news").Header().Get(cacheStateHeader); state != "miss" {
		t.Fatalf("the first request: %q", state)
	}
	if tables := atomic.LoadInt32(&svc.tables); tables != 1 {
		t.Fatalf("%d policy tables read at boot", tables)
	}

	// the render service restarts, and the only traffic is a shared render
	atomic.StoreInt64(&svc.boot, 2)
	pages.invalidatePath("/news")
	get("/news")

	// the stamp it answered with is a new boot, so the table is asked again -
	// on the NEXT request, since the lookup happens before the render that
	// carried the stamp. What matters is that it is asked at all
	get("/news")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && atomic.LoadInt32(&svc.tables) < 2 {
		time.Sleep(time.Millisecond)
	}
	if tables := atomic.LoadInt32(&svc.tables); tables != 2 {
		t.Errorf("the policy table was read %d times: a restart under a live front went unnoticed", tables)
	}
}

// a page request's api calls reach the internal listener from the render
// service on loopback: the front hands the render service the address it
// saw, whatever a client claimed, and the internal listener - past the key,
// never before - makes it the api's RemoteAddr (found by the audit of phase 7)
func TestTheAPISeesThePageRequestsClientThroughTheRenderService(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)
	req := httptest.NewRequest("GET", "/login", nil)
	req.RemoteAddr = "203.0.113.7:5151"
	req.Header.Set(peerHeader, "6.6.6.6:1")
	front.ServeHTTP(httptest.NewRecorder(), req)
	if got := seen.Get(peerHeader); got != "203.0.113.7:5151" {
		t.Errorf("render service told %q, want the connection's own address", got)
	}

	var remote string
	var leaked string
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		remote, leaked = r.RemoteAddr, r.Header.Get(peerHeader)
		w.WriteHeader(204)
	})
	guarded := requireInternalKey(testInternalKey, inner)
	for _, tc := range []struct {
		key, peer, want string
		code            int
	}{
		{testInternalKey, "203.0.113.7:5151", "203.0.113.7:5151", 204},
		{testInternalKey, "[2001:db8::1]:443", "[2001:db8::1]:443", 204},
		{testInternalKey, "not an address", "127.0.0.1:9", 204},
		{testInternalKey, "", "127.0.0.1:9", 204},
		{"wrong", "203.0.113.7:5151", "", 403},
	} {
		remote, leaked = "", ""
		r := httptest.NewRequest("POST", "/api/login", nil)
		r.RemoteAddr = "127.0.0.1:9"
		r.Header.Set(internalKeyHeader, tc.key)
		if tc.peer != "" {
			r.Header.Set(peerHeader, tc.peer)
		}
		w := httptest.NewRecorder()
		guarded.ServeHTTP(w, r)
		if w.Code != tc.code || remote != tc.want || leaked != "" {
			t.Errorf("key %q peer %q: %d, RemoteAddr %q, header left %q", tc.key, tc.peer, w.Code, remote, leaked)
		}
	}
}
