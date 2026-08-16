package borgo

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/textproto"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestServerConfigDefaults(t *testing.T) {
	srv, err := newServer("3501", http.NewServeMux())
	if err != nil {
		t.Fatal(err)
	}
	if srv.Addr != ":3501" {
		t.Errorf("addr: %s", srv.Addr)
	}
	if srv.ReadHeaderTimeout != 5*time.Second {
		t.Errorf("read header timeout: %v", srv.ReadHeaderTimeout)
	}
	if srv.IdleTimeout != 2*time.Minute {
		t.Errorf("idle timeout: %v", srv.IdleTimeout)
	}
	// wall-clock deadlines on the whole request would kill sse streams
	if srv.ReadTimeout != 0 || srv.WriteTimeout != 0 {
		t.Errorf("read/write timeouts must default to 0: %v %v", srv.ReadTimeout, srv.WriteTimeout)
	}
}

func TestServerConfigEnvOverrides(t *testing.T) {
	t.Setenv("BORGO_READ_HEADER_TIMEOUT", "11s")
	t.Setenv("BORGO_READ_TIMEOUT", "30s")
	t.Setenv("BORGO_WRITE_TIMEOUT", "45s")
	t.Setenv("BORGO_IDLE_TIMEOUT", "0")
	srv, err := newServer("3501", nil)
	if err != nil {
		t.Fatal(err)
	}
	if srv.ReadHeaderTimeout != 11*time.Second || srv.ReadTimeout != 30*time.Second ||
		srv.WriteTimeout != 45*time.Second || srv.IdleTimeout != 0 {
		t.Errorf("overrides not applied: %+v", srv)
	}
}

// a malformed timeout is a value the caller can act on. It used to panic, and a
// panic in here is a panic out of ServeContext: the library taking down the
// process that hosts it, which is the one thing it promises never to do
func TestServerConfigRejectsGarbage(t *testing.T) {
	t.Setenv("BORGO_READ_HEADER_TIMEOUT", "fast")
	srv, err := newServer("3501", nil)
	if err == nil {
		t.Fatalf("BORGO_READ_HEADER_TIMEOUT=fast was accepted: %+v", srv)
	}
	if !strings.Contains(err.Error(), "BORGO_READ_HEADER_TIMEOUT") {
		t.Fatalf("error does not name the variable: %v", err)
	}
	if srv != nil {
		t.Fatalf("a refused configuration still returned a server: %+v", srv)
	}
}

func TestSlowHeadersAreCutOff(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.Config.ReadHeaderTimeout = 150 * time.Millisecond
	srv.Start()
	defer srv.Close()

	c, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// a slowloris client: opens the request and never finishes the headers
	fmt.Fprint(c, "GET / HTTP/1.1\r\nHost: x\r\n")
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 1)
	start := time.Now()
	_, readErr := c.Read(buf)
	if readErr == nil {
		t.Fatal("connection must be closed, got data")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("connection not cut off by the header timeout (waited %v)", elapsed)
	}
}

// the whole Serve chain: the deadline reset has to reach the real connection
// through the recovery and gzip wrappers
func TestSSEOutlivesWriteTimeout(t *testing.T) {
	srv := httptest.NewUnstartedServer(recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stream, err := SSE(w, r)
		if err != nil {
			return
		}
		for i := 0; i < 3; i++ {
			time.Sleep(200 * time.Millisecond)
			if stream.Send("tick", i) != nil {
				return
			}
		}
	}))))
	// far shorter than the stream: without the deadline reset in SSE the
	// connection dies before the second event
	srv.Config.WriteTimeout = 100 * time.Millisecond
	srv.Start()
	defer srv.Close()

	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	events := 0
	scanner := bufio.NewScanner(res.Body)
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "event: tick") {
			events++
		}
	}
	if events != 3 {
		t.Fatalf("want 3 events through the write timeout, got %d", events)
	}
}

// net/http lets a handler send 1xx informational responses before the real
// one; held back by a wrapper they would arrive after the body, and early
// hints exist precisely to arrive first
func TestEarlyHintsReachTheClientBeforeTheBody(t *testing.T) {
	body := make(chan struct{})
	srv := httptest.NewServer(recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Link", "</app.js>; rel=preload; as=script")
		w.WriteHeader(http.StatusEarlyHints)
		w.Header().Del("Link")
		select {
		case <-body:
		case <-time.After(5 * time.Second): // never wedge the server's Close
		}
		WriteJSON(w, http.StatusTeapot, map[string]string{"ok": "yes"})
	}))))
	defer srv.Close()

	hints := make(chan string, 4)
	trace := &httptrace.ClientTrace{Got1xxResponse: func(code int, h textproto.MIMEHeader) error {
		if code == http.StatusEarlyHints {
			hints <- h.Get("Link")
		}
		return nil
	}}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(context.Background(), trace), http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan *http.Response, 1)
	go func() {
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Error(err)
			close(done)
			return
		}
		done <- res
	}()

	select {
	case link := <-hints:
		if !strings.Contains(link, "/app.js") {
			t.Errorf("early hints arrived without their Link header: %q", link)
		}
	case <-time.After(3 * time.Second):
		t.Error("no early hints before the handler wrote its body")
	}
	close(body)

	res, ok := <-done
	if !ok {
		t.FailNow()
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusTeapot {
		t.Fatalf("final status = %d, want the handler's 418", res.StatusCode)
	}
	if payload, _ := io.ReadAll(res.Body); !strings.Contains(string(payload), `"ok":"yes"`) {
		t.Errorf("body = %q", payload)
	}
}

// a panic after early hints: the response is not committed yet, so the
// recovery still owns it
func TestPanicAfterEarlyHintsIsStillA500(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	// httptest.ResponseRecorder cannot model a 1xx, so this one needs a real
	// connection
	srv := httptest.NewServer(recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusEarlyHints)
		panic("after the hints")
	}))))
	defer srv.Close()

	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", res.StatusCode)
	}
	var body map[string]string
	payload, _ := io.ReadAll(res.Body)
	if json.Unmarshal(payload, &body) != nil || body["error"] == "" {
		t.Fatalf("body = %q, want a json error", payload)
	}
}

// a ResponseRecorder has no connection to condemn, so the half of the fix that
// matters most is checked where it takes effect: net/http reads Connection from
// the header map it is handed, and if the recovery cleared it the socket goes
// back to the keep-alive pool the handler had just written it off
func TestPanicKeepsConnectionCloseOnTheWire(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	srv := httptest.NewServer(Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Connection", "close")
		panic("boom")
	})))
	defer srv.Close()

	c, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	// no Connection header of our own: only the handler's may close this
	if _, err := io.WriteString(c, "GET /api/x HTTP/1.1\r\nHost: x\r\nAccept-Encoding: gzip\r\n\r\n"); err != nil {
		t.Fatal(err)
	}

	br := bufio.NewReader(c)
	res, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", res.StatusCode)
	}
	if !res.Close {
		t.Error("the 500 kept the connection alive; the handler asked for it to close")
	}
	if got := res.Header.Get("Vary"); got != "Accept-Encoding" {
		t.Errorf("Vary = %q on the wire, want Accept-Encoding", got)
	}
	if _, err := br.ReadByte(); err != io.EOF {
		t.Errorf("read after the 500 = %v, want EOF from a closed connection", err)
	}
}

// every browser sends Accept-Encoding: gzip, so the response buffer is in the
// path of a real request
func gzipRequest() *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	return r
}

func TestRecoverMiddleware(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	t.Run("a panic before any write is a json 500", func(t *testing.T) {
		rec := httptest.NewRecorder()
		recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			panic("boom")
		}))).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/x", nil))

		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
		var body map[string]string
		if json.Unmarshal(rec.Body.Bytes(), &body) != nil || body["error"] == "" {
			t.Fatalf("body = %q, want a json error", rec.Body)
		}
		if strings.Contains(rec.Body.String(), "boom") {
			t.Error("the panic value must not reach the client")
		}
	})

	t.Run("a panic mid-body is a 500, not a truncated 200", func(t *testing.T) {
		rec := httptest.NewRecorder()
		recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Length", "2000")
			w.Write([]byte(`{"items":[1,2,3`))
			panic("mid body")
		}))).ServeHTTP(rec, gzipRequest())

		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("body = %q, want a whole json error (%v)", rec.Body, err)
		}
		// a Content-Length left over from the abandoned body would make
		// net/http cut the connection on a response that is now well formed
		if got, want := rec.Header().Get("Content-Length"), strconv.Itoa(rec.Body.Len()); got != want {
			t.Errorf("Content-Length = %s, want %s", got, want)
		}
	})

	t.Run("a panic past the buffer leaves the committed bytes alone", func(t *testing.T) {
		rec := httptest.NewRecorder()
		recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(strings.Repeat("x", 2*gzipMinBytes)))
			panic("late")
		}))).ServeHTTP(rec, gzipRequest())

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want the committed 200", rec.Code)
		}
		if rec.Body.Len() == 0 {
			t.Error("the committed body vanished")
		}
	})

	t.Run("the abandoned response's headers do not ride on the 500", func(t *testing.T) {
		t.Setenv("SESSION_SECRET", "a-secret-that-is-at-least-32-bytes")
		rec := httptest.NewRecorder()
		recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			Cache(w, time.Hour)
			w.Header().Set("Etag", `"v1"`)
			if err := SetSession(w, map[string]string{"user": "luigi"}, time.Hour); err != nil {
				t.Fatal(err)
			}
			panic("after the headers")
		}))).ServeHTTP(rec, gzipRequest())

		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
		for _, header := range []string{"Cache-Control", "Etag", "Set-Cookie"} {
			// a cached 500, or a session handed out by a request that failed
			if got := rec.Header().Get(header); got != "" {
				t.Errorf("500 carries %s: %q", header, got)
			}
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", ct)
		}
	})

	// the direction: what describes the connection survives a response being
	// replaced. Vary is set by gzipMiddleware for every request, and it is what
	// tells a shared cache the reply was negotiated - a blanket clear took it
	// off the 500. Both encodings are checked because a panic before the
	// response buffer fills starts no gzip, so the 500 is uncompressed for the
	// client that asked for gzip too, and the clear reached both of them.
	t.Run("the 500 keeps Vary", func(t *testing.T) {
		for _, accept := range []string{"", "gzip"} {
			rec := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodGet, "/api/x", nil)
			if accept != "" {
				r.Header.Set("Accept-Encoding", accept)
			}
			Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				panic("boom")
			})).ServeHTTP(rec, r)

			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("Accept-Encoding %q: status = %d, want 500", accept, rec.Code)
			}
			if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
				t.Errorf("Accept-Encoding %q: 500 Vary = %q, want Accept-Encoding", accept, got)
			}
		}
	})

	t.Run("the 500 keeps the handler's own Vary and Connection", func(t *testing.T) {
		rec := httptest.NewRecorder()
		recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Vary", "Cookie")
			w.Header().Set("Connection", "close")
			w.Header().Set("Etag", `"v1"`)
			w.Header().Set("Trailer", "Cache-Control")
			panic("after the headers")
		}))).ServeHTTP(rec, gzipRequest())

		if got := rec.Header().Get("Vary"); got != "Cookie" {
			t.Errorf("Vary = %q, want the handler's Cookie", got)
		}
		if got := rec.Header().Get("Connection"); got != "close" {
			t.Errorf("Connection = %q: a connection the handler condemned went back to the pool", got)
		}
		// framing and validators belong to the response that died
		for _, header := range []string{"Etag", "Trailer"} {
			if got := rec.Header().Get(header); got != "" {
				t.Errorf("500 carries %s: %q", header, got)
			}
		}
	})

	t.Run("ErrAbortHandler stays a panic", func(t *testing.T) {
		defer func() {
			if r := recover(); r != http.ErrAbortHandler {
				t.Fatalf("recovered %v, want ErrAbortHandler to pass through", r)
			}
		}()
		recoverMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			panic(http.ErrAbortHandler)
		})).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	})

	t.Run("streaming still flushes through the wrapper", func(t *testing.T) {
		rec := httptest.NewRecorder()
		recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			stream, err := SSE(w, r)
			if err != nil {
				t.Error(err)
				return
			}
			if err := stream.Send("tick", 1); err != nil {
				t.Error(err)
			}
		}))).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/events", nil))

		if !rec.Flushed {
			t.Error("flush did not reach the recorder")
		}
		if !strings.Contains(rec.Body.String(), "event: tick") {
			t.Errorf("body = %q", rec.Body)
		}
	})
}

// serveOn starts srv on a loopback port and returns its base url
func serveOn(t *testing.T, srv *http.Server) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go srv.Serve(ln)
	return "http://" + ln.Addr().String()
}

// latchOf returns the stream-shutdown latch armed for srv. A stream finds it
// through its own request; a test holding only the server looks it up here.
func latchOf(t *testing.T, srv *http.Server) <-chan struct{} {
	t.Helper()
	v, ok := streamLatches.Load(srv)
	if !ok {
		t.Fatal("no stream latch is armed for this server")
	}
	return v.(*streamLatch).done
}

// pingStream keeps an event stream open until the run serving it shuts down.
func pingStream(w http.ResponseWriter, r *http.Request) {
	stream, err := SSE(w, r)
	if err != nil {
		return
	}
	for {
		select {
		case <-stream.Done():
			return
		case <-time.After(20 * time.Millisecond):
			if stream.Ping() != nil {
				return
			}
		}
	}
}

// readingStream opens a stream against base and returns a channel that closes
// when the stream ends.
func readingStream(t *testing.T, base string) <-chan struct{} {
	t.Helper()
	res, err := http.Get(base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		io.Copy(io.Discard, res.Body)
	}()
	return ended
}

// waitListening blocks until something accepts connections on port. It dials
// rather than asking /healthz on purpose: an http client of its own would
// leave idle connections, and their goroutines, behind a test that counts them.
func waitListening(t *testing.T, port string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		c, err := net.DialTimeout("tcp", "127.0.0.1:"+port, 200*time.Millisecond)
		if err == nil {
			c.Close()
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("nothing came up on :%s (%v)", port, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// freePort grabs a loopback port and lets it go, so the caller can bind it.
func freePort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	_, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return port
}

// serveContext snapshots the route registry and latches `served`; a test that
// runs it must hand the registry back, or every later Handle call panics.
func restoreRegistry(t *testing.T) {
	t.Helper()
	routesMu.Lock()
	prev := served
	routesMu.Unlock()
	t.Cleanup(func() {
		routesMu.Lock()
		served = prev
		routesMu.Unlock()
	})
}

// refusal runs ServeContext and returns the error it refused to start with,
// failing unless that error names want. The run gets a context this can cancel
// because a refusal that regresses does not return at all: ServeContext blocks
// on a server that came up, and the test then hangs until the package timeout
// ten minutes away and reports it as a timeout rather than as the guard that
// went missing. Found by mutation - the harness spent ten minutes on it.
func refusal(t *testing.T, want string) error {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- ServeContext(ctx) }()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("ServeContext returned %v, want a refusal naming %s", err, want)
		}
		return err
	case <-time.After(15 * time.Second):
		cancel()
		<-done
		t.Fatalf("ServeContext served instead of refusing %s", want)
		return nil
	}
}

// assertRegistryUsable registers a route and fails if Handle refuses it. A run
// that came back as a refusal never mounted anything, so the caller it handed
// that refusal to must still be able to build the app it was refused for -
// otherwise "fix the env and retry" only half works, and the half that does not
// is a panic. The pattern carries the test name because patternCheck, the mux
// borgo validates against, has no way to unregister.
func assertRegistryUsable(t *testing.T) {
	t.Helper()
	pattern := "GET /" + t.Name()
	defer func() {
		routesMu.Lock()
		delete(routes, pattern)
		routesMu.Unlock()
		if r := recover(); r != nil {
			t.Errorf("Handle refused after a run that never served: %v", r)
		}
	}()
	Handle(pattern, func(http.ResponseWriter, *http.Request) {})
}

// Serve calls log.Fatal and never returns, so nothing could start the api from
// a test or embed it in a larger program. ServeContext has to actually come
// back, and leave the port behind it.
func TestServeContextReturnsAndReleasesPort(t *testing.T) {
	restoreRegistry(t)
	var logs strings.Builder
	log.SetOutput(&logs)
	defer log.SetOutput(os.Stderr)

	port := freePort(t)
	t.Setenv("API_PORT", port)
	t.Setenv("SESSION_SECRET", "") // the startup warning must still fire

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- ServeContext(ctx) }()

	// the server is really listening: its own /healthz answers
	base := "http://127.0.0.1:" + port
	deadline := time.Now().Add(10 * time.Second)
	var res *http.Response
	for {
		var err error
		res, err = http.Get(base + "/healthz")
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("ServeContext never came up on :%s (%v)", port, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || !strings.Contains(string(body), `"status":"ok"`) {
		t.Fatalf("/healthz = %d %s", res.StatusCode, body)
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("ServeContext returned %v, want nil on a cancelled context", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("ServeContext did not return after its context was cancelled")
	}

	// the port is free again: the whole point of returning. It must be the
	// same wildcard address the server binds - windows grants a loopback bind
	// next to a live wildcard one, which would make this assertion vacuous
	ln, err := net.Listen("tcp", ":"+port)
	if err != nil {
		t.Fatalf("port %s still held after ServeContext returned: %v", port, err)
	}
	ln.Close()

	// behaviour Serve had and ServeContext must keep
	if !strings.Contains(logs.String(), "SESSION_SECRET") {
		t.Errorf("the session-secret warning did not fire: %q", logs.String())
	}
}

// a listener that cannot start was a log.Fatal; now it is a value the caller
// can act on
func TestServeContextReturnsListenerErrors(t *testing.T) {
	restoreRegistry(t)
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	// hold the port so ListenAndServe cannot have it. It has to be the same
	// address the server asks for - windows happily grants a wildcard bind
	// next to a loopback-specific one
	port := freePort(t)
	ln, err := net.Listen("tcp", ":"+port)
	if err != nil {
		t.Skipf("could not hold :%s to create the conflict: %v", port, err)
	}
	defer ln.Close()
	t.Setenv("API_PORT", port)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel() // never leave a server behind if the listener did start
	done := make(chan error, 1)
	go func() { done <- ServeContext(ctx) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("ServeContext returned nil for a port already in use")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("ServeContext blocked on a listener that could not start")
	}
	// the bind happens before the registry is mounted, so this refusal costs
	// the caller nothing either
	assertRegistryUsable(t)
}

// API_PORT was the one variable nobody parsed: it went into the server's Addr
// as it stood and net refused it from inside ListenAndServe, which is after the
// registry has been closed. Every one of these came back as a value and bricked
// Handle on the way.
func TestServeContextRefusesAMalformedPort(t *testing.T) {
	restoreRegistry(t)
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	for _, v := range []string{"nope", "65536", "-1", "1.5", "0x10", ":38503", " ", "38503 ", "8080;ls", "+80", strings.Repeat("9", 5000)} {
		t.Setenv("API_PORT", v)
		refusal(t, "API_PORT")
	}
	assertRegistryUsable(t)
}

// the whole contract in one run: the refusal comes back as a value, the caller
// fixes the environment, registers the route it was building, retries - and the
// route is served. Every piece of this was measured broken: the retry latched
// the registry, so Handle panicked, and the route that survived a recover() was
// never mounted.
func TestARefusedRunCanBeFixedAndRetried(t *testing.T) {
	restoreRegistry(t)
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	t.Setenv("API_PORT", "nope")
	refusal(t, "API_PORT")

	pattern := "GET /" + t.Name()
	defer func() {
		routesMu.Lock()
		delete(routes, pattern)
		routesMu.Unlock()
	}()
	Handle(pattern, func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]string{"retried": "yes"})
	})

	port := freePort(t)
	t.Setenv("API_PORT", port)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- ServeContext(ctx) }()
	waitListening(t, port)

	res, err := http.Get("http://127.0.0.1:" + port + "/" + t.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("the route registered between the refusal and the retry answered %d", res.StatusCode)
	}

	cancel()
	if err := <-done; err != nil {
		t.Fatalf("the retry returned %v", err)
	}
}

// and a port it can serve is still served, leading zeros and all
func TestServeContextTakesEveryPortNetTakes(t *testing.T) {
	for _, v := range []string{"0", "3501", "08080", "65535"} {
		t.Setenv("API_PORT", v)
		port, err := envPort()
		if err != nil {
			t.Fatalf("API_PORT=%q was refused: %v", v, err)
		}
		if port != v {
			t.Fatalf("API_PORT=%q came back as %q", v, port)
		}
	}
}

// BORGO_PARENT_PID was silently no watch at all for anything that is not a pid,
// and the default nobody chose is the orphaned api this variable exists to
// prevent - on windows, holding the port until someone finds it in the task
// manager
func TestServeContextRefusesAMalformedParentPID(t *testing.T) {
	restoreRegistry(t)
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	for _, v := range []string{"notapid", " ", "0", "-1", "1.5", "0x10", "99999999999999999999"} {
		t.Setenv("API_PORT", freePort(t))
		t.Setenv("BORGO_PARENT_PID", v)
		refusal(t, "BORGO_PARENT_PID")
	}
	assertRegistryUsable(t)
}

// a supervisor that is already gone used to be found by the watch instead: the
// run mounted, shut down before serving one request, and returned nil - an
// abort reported to its caller as a clean start
func TestServeContextRefusesAnAlreadyDeadParent(t *testing.T) {
	restoreRegistry(t)
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	port := freePort(t)
	t.Setenv("API_PORT", port)
	t.Setenv("BORGO_PARENT_PID", strconv.Itoa(exitedChildPID(t)))

	refusal(t, "has already exited")
	ln, lnErr := net.Listen("tcp", ":"+port)
	if lnErr != nil {
		t.Fatalf("port %s left bound by a run that refused to start: %v", port, lnErr)
	}
	ln.Close()
	assertRegistryUsable(t)
}

// exitedChildPID runs this test binary with a filter that matches no test and
// reaps it, so the pid names a process that is certainly gone: on unix an
// unreaped child is a zombie the probe still reads as alive.
func exitedChildPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	if err := cmd.Start(); err != nil {
		t.Skipf("could not start a child to kill: %v", err)
	}
	pid := cmd.Process.Pid
	if err := cmd.Wait(); err != nil {
		t.Skipf("the child exited with %v", err)
	}
	return pid
}

// the timeout matrix is still read before the banner, so a typo fails the boot
// rather than half-configuring the server - but it comes back as a value. This
// test asserted the panic once, which is the opposite of what ServeContext
// documents: a panic here unwinds through the embedder, past its deferred
// cleanup, and kills whatever else that process was running.
func TestServeContextStillValidatesTimeouts(t *testing.T) {
	restoreRegistry(t)
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	port := freePort(t)
	t.Setenv("BORGO_IDLE_TIMEOUT", "soon")
	t.Setenv("API_PORT", port)

	refusal(t, "BORGO_IDLE_TIMEOUT")
	ln, lnErr := net.Listen("tcp", ":"+port)
	if lnErr != nil {
		t.Fatalf("port %s left bound by a run that refused to start: %v", port, lnErr)
	}
	ln.Close()
	assertRegistryUsable(t)
}

// the grace period is read on the same path and refused the same way
func TestServeContextRefusesAMalformedGrace(t *testing.T) {
	restoreRegistry(t)
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	t.Setenv("BORGO_SHUTDOWN_TIMEOUT", "-1s")
	t.Setenv("API_PORT", freePort(t))

	refusal(t, "BORGO_SHUTDOWN_TIMEOUT")
	assertRegistryUsable(t)
}

func TestShutdownEndsEventStreams(t *testing.T) {
	handlerReturned := make(chan struct{})
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerReturned)
		pingStream(w, r)
	})}
	armStreamShutdown(srv)

	res, err := http.Get(serveOn(t, srv))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	start := time.Now()
	shutdown(srv, 10*time.Second)
	// without the shutdown signal the stream would hold the connection for
	// the whole grace period
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("shutdown waited %v on an open event stream", elapsed)
	}
	select {
	case <-handlerReturned:
	case <-time.After(3 * time.Second):
		t.Fatal("stream handler never returned")
	}
}

// net/http runs OnShutdown hooks as `go f()` and Shutdown does not wait for
// them, so a hook registered by one server can still be pending when the next
// one starts. It must end the streams of the run that registered it and no
// other: a hook that reads the package latch when it fires cancels whichever
// run is live at that moment, and the server that just started then answers
// every SSE request with an already-finished stream, for its whole life, while
// /healthz stays green and the browser reconnects forever.
func TestShutdownHookCancelsOnlyItsOwnRun(t *testing.T) {
	prev := &http.Server{}
	armStreamShutdown(prev)
	prevStreams := latchOf(t, prev)

	next := &http.Server{}
	armStreamShutdown(next)
	nextStreams := latchOf(t, next)

	if prevStreams == nextStreams {
		t.Fatal("the second run reused the first run's latch")
	}

	// the previous run's hook fires late, after the next run armed its latch
	if err := prev.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-prevStreams:
	case <-nextStreams:
		t.Fatal("a pending hook from the previous server cancelled the new server's stream latch: every stream that server serves would end at once")
	case <-time.After(10 * time.Second):
		t.Fatal("the shutdown hook never ended the streams of the run that registered it")
	}
	select {
	case <-nextStreams:
		t.Fatal("a pending hook from the previous server cancelled the new server's stream latch: every stream that server serves would end at once")
	default:
	}

	// and the live run's own hook still works
	if err := next.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-nextStreams:
	case <-time.After(10 * time.Second):
		t.Fatal("the current run's own shutdown hook did not end its streams")
	}
}

// The sequential case above is only half of it: runs overlap, and one package
// global cannot hold two of them. Arming happens before the bind, so a second
// ServeContext that never got its port - the likeliest overlap of all, a
// restart racing the process it is replacing - still replaced the live
// server's latch. Every stream that server opened afterwards then watched a
// latch its own Shutdown does not trip, and the shutdown sat out the whole
// BORGO_SHUTDOWN_TIMEOUT waiting for streams that would never end.
func TestAFailedRunDoesNotTakeOverTheLiveRunsStreams(t *testing.T) {
	restoreRegistry(t)
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	live := &http.Server{Handler: http.HandlerFunc(pingStream)}
	armStreamShutdown(live)
	base := serveOn(t, live)
	defer live.Close()

	// the overlapping run: hold its port so it cannot bind, exactly as a
	// restart racing the instance it replaces
	busy := freePort(t)
	ln, err := net.Listen("tcp", ":"+busy)
	if err != nil {
		t.Skipf("could not hold :%s to create the conflict: %v", busy, err)
	}
	defer ln.Close()
	t.Setenv("API_PORT", busy)
	t.Setenv("SESSION_SECRET", "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	failed := make(chan error, 1)
	go func() { failed <- ServeContext(ctx) }()
	select {
	case err := <-failed:
		if err == nil {
			t.Fatal("the second run bound a port that was already taken")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the overlapping run never returned")
	}

	// a stream the live server opens after that failed run
	ended := readingStream(t, base)

	start := time.Now()
	shutdown(live, 10*time.Second)
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("the live server's shutdown waited %v on its own event stream: a run that never bound had taken its stream latch", elapsed)
	}
	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("the live server's shutdown never ended the stream it was serving")
	}
}

// The other side of the overlap: when the second run stops, its hook must not
// end the streams of the server still serving. It did - the hook tripped the
// latch that run had armed, which by then was the one the live server's
// streams were watching - and that server went on answering every SSE request
// with an already-finished stream while /healthz stayed green and browsers
// reconnected forever. Verbatim the failure armStreamShutdown's comment says
// it fixed, reached by overlap instead of by sequence.
func TestAnOverlappingRunsShutdownLeavesTheLiveRunsStreamsAlone(t *testing.T) {
	restoreRegistry(t)
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	live := &http.Server{Handler: http.HandlerFunc(pingStream)}
	armStreamShutdown(live)
	base := serveOn(t, live)
	defer live.Close()

	// a second run, on its own port, while the first is serving
	port := freePort(t)
	t.Setenv("API_PORT", port)
	t.Setenv("SESSION_SECRET", "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	second := make(chan error, 1)
	go func() { second <- ServeContext(ctx) }()
	waitListening(t, port)

	// a stream opened on the live server while both runs are up
	ended := readingStream(t, base)

	cancel()
	select {
	case err := <-second:
		if err != nil {
			t.Fatalf("the second run returned %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the second run never returned")
	}

	select {
	case <-ended:
		t.Fatal("the overlapping run's shutdown ended a stream the live server was serving: that server would answer every later stream already-finished, with the api healthy")
	case <-time.After(500 * time.Millisecond):
	}

	// and the live server can still end it, so nothing was disarmed either
	shutdown(live, 10*time.Second)
	select {
	case <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("the live server's own shutdown did not end its stream")
	}
}

// warnSessionSecret called log.Fatalf from inside serveContext, so a short
// SESSION_SECRET took the process down: deferred cleanup unrun, sibling
// servers dead, a test binary killed mid-run. The refusal stands - it is an
// error now, and Serve is the one that turns it into an exit. If this
// regresses the whole test binary exits 1 here rather than reporting a
// failure, which is the point.
func TestServeContextRefusesAShortSecretWithoutExiting(t *testing.T) {
	restoreRegistry(t)
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	port := freePort(t)
	t.Setenv("API_PORT", port)
	t.Setenv("SESSION_SECRET", "too-short-to-sign-with")

	refusal(t, "SESSION_SECRET")
	// and it refused before binding, so the caller can fix the env and retry
	ln, lnErr := net.Listen("tcp", ":"+port)
	if lnErr != nil {
		t.Fatalf("port %s left bound by a run that refused to start: %v", port, lnErr)
	}
	ln.Close()
	// retrying ServeContext was only half of "the caller can retry": the run
	// latched the registry on its way to the refusal, so the next Handle
	// panicked with "registered after borgo.Serve" for a server that never was
	assertRegistryUsable(t)
}

// waitParentExit has no timeout of its own: on windows it blocks inside
// WaitForSingleObject holding a kernel handle on the parent, on unix in a
// poll. Without a way to end it the goroutine stays parked for the life of the
// process, and ServeContext exists to be called repeatedly.
func TestWaitParentExitIsCancellable(t *testing.T) {
	stop := make(chan struct{})
	returned := make(chan bool, 1)
	// this process is a parent that will not exit while the test runs
	go func() { returned <- waitParentExit(os.Getpid(), stop) }()

	select {
	case exited := <-returned:
		t.Fatalf("waitParentExit returned %v for a process that is still running", exited)
	case <-time.After(500 * time.Millisecond):
	}

	close(stop)
	select {
	case exited := <-returned:
		// serveContext reads that as "parent process exited" and shuts down
		if exited {
			t.Fatal("a cancelled watch reported the parent as exited")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("waitParentExit ignored its stop: the watcher stays parked for the life of the process, on windows pinning a handle on the parent")
	}
}

// and serveContext really ends the watcher it started: five runs used to leave
// five blocked goroutines, one process handle each on windows
func TestServeContextLeavesNoParentWatcherBehind(t *testing.T) {
	restoreRegistry(t)
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	// a parent that never exits, so a watcher only ends if its run ends it
	t.Setenv("BORGO_PARENT_PID", strconv.Itoa(os.Getpid()))
	t.Setenv("SESSION_SECRET", "")

	before := settledGoroutines()
	const runs = 5
	for range runs {
		port := freePort(t)
		t.Setenv("API_PORT", port)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- ServeContext(ctx) }()
		waitListening(t, port)
		cancel()
		if err := <-done; err != nil {
			t.Fatalf("run returned %v", err)
		}
	}

	// the watchers are cancelled, not joined, so give them a moment to unwind
	deadline := time.Now().Add(15 * time.Second)
	for {
		if leaked := runtime.NumGoroutine() - before; leaked <= 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d goroutines parked after %d ServeContext runs (%d before, %d now): each run leaves its parent watcher blocked forever",
				runtime.NumGoroutine()-before, runs, before, runtime.NumGoroutine())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// settledGoroutines is the goroutine count once whatever ran before this test
// has finished unwinding.
func settledGoroutines() int {
	lowest := runtime.NumGoroutine()
	for range 20 {
		time.Sleep(50 * time.Millisecond)
		if n := runtime.NumGoroutine(); n < lowest {
			lowest = n
		}
	}
	return lowest
}

func TestShutdownCutsRequestsPastTheGrace(t *testing.T) {
	stuck := make(chan struct{})
	defer close(stuck)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-stuck
	})}
	base := serveOn(t, srv)

	inFlight := make(chan struct{})
	go func() {
		defer close(inFlight)
		res, err := http.Get(base)
		if err == nil {
			res.Body.Close()
		}
	}()
	time.Sleep(100 * time.Millisecond)

	start := time.Now()
	shutdown(srv, 200*time.Millisecond)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("a stuck handler blocked shutdown for %v", elapsed)
	}
	select {
	case <-inFlight:
	case <-time.After(3 * time.Second):
		t.Fatal("the cut connection left its client hanging")
	}
}

func TestShutdownGraceIsConfigurable(t *testing.T) {
	t.Setenv("BORGO_SHUTDOWN_TIMEOUT", "3s")
	got, err := envDuration("BORGO_SHUTDOWN_TIMEOUT", 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if got != 3*time.Second {
		t.Fatalf("grace = %v, want 3s", got)
	}
}

// jsonRequest is what a client that says what it is sending posts.
func jsonRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestBindCapsBodies(t *testing.T) {
	type payload struct {
		Data string `json:"data"`
	}
	big := `{"data":"` + strings.Repeat("x", bindLimit) + `"}`
	small := `{"data":"ok"}`

	t.Run("oversized body is a 413", func(t *testing.T) {
		r := jsonRequest(big)
		_, err := Bind[payload](r)
		if err == nil {
			t.Fatal("want error for oversized body")
		}
		w := httptest.NewRecorder()
		BindError(w, err)
		if w.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("want 413, got %d", w.Code)
		}
	})

	t.Run("small body decodes", func(t *testing.T) {
		v, err := Bind[payload](jsonRequest(small))
		if err != nil || v.Data != "ok" {
			t.Fatalf("bind failed: %v %+v", err, v)
		}
	})

	t.Run("malformed body is a 400", func(t *testing.T) {
		_, err := Bind[payload](jsonRequest("not json"))
		w := httptest.NewRecorder()
		BindError(w, err)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d", w.Code)
		}
	})

	t.Run("BindMax overrides the cap", func(t *testing.T) {
		if _, err := BindMax[payload](jsonRequest(big), int64(len(big))+1); err != nil {
			t.Fatalf("raised cap must decode: %v", err)
		}
		if _, err := BindMax[payload](jsonRequest(small), 4); err == nil {
			t.Fatal("tiny cap must reject")
		}
		if _, err := BindMax[payload](jsonRequest(big), 0); err != nil {
			t.Fatalf("0 disables the cap: %v", err)
		}
	})

	// the padding pushes the body past the limit, but the JSON value itself
	// completed inside it, so the decoder reports the overflow from Token()
	// rather than from Decode(). Discarding that error - it used to be
	// replaced by a plain "unexpected data after JSON body" - lost the
	// *http.MaxBytesError BindError matches on, and an oversized body was
	// answered 400 "unexpected data" instead of the documented 413.
	t.Run("a body that overflows after a complete value is still a 413", func(t *testing.T) {
		for _, pad := range []string{strings.Repeat(" ", 4<<10), strings.Repeat("\n", 4<<10)} {
			r := jsonRequest(`{"username":"a","password":"b"}` + pad)
			_, err := BindMax[Credentials](r, 64)
			if err == nil {
				t.Fatal("want an error for a body past the limit")
			}
			var tooLarge *http.MaxBytesError
			if !errors.As(err, &tooLarge) {
				t.Errorf("err = %v (%T), want it to carry *http.MaxBytesError", err, err)
			}
			w := httptest.NewRecorder()
			BindError(w, err)
			if w.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("want 413, got %d: %s", w.Code, w.Body)
			}
		}
	})

	// trailing junk that fits inside the limit is still a plain 400
	t.Run("trailing data inside the limit is a 400", func(t *testing.T) {
		_, err := BindMax[payload](jsonRequest(small+` {"data":"again"}`), 1<<20)
		if err == nil {
			t.Fatal("want an error for two values in one body")
		}
		w := httptest.NewRecorder()
		BindError(w, err)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d", w.Code)
		}
	})
}

// The Content-Type check is the only barrier Bind puts between a handler and a
// cross-site POST, and it was not one: a request with no Content-Type at all
// was accepted. `fetch(url, {method:"POST", body: new Blob([json], {type:""})})`
// sends exactly that from any origin and is not preflighted, so the header has
// to be required rather than merely validated when present.
func TestBindRequiresAJSONContentType(t *testing.T) {
	type payload struct {
		Data string `json:"data"`
	}
	const body = `{"data":"ok"}`

	t.Run("no Content-Type is a 415", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		_, err := Bind[payload](r)
		if !errors.Is(err, errContentType) {
			t.Fatalf("a request with no Content-Type bound: %v", err)
		}
		w := httptest.NewRecorder()
		BindError(w, err)
		if w.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("want 415, got %d", w.Code)
		}
	})

	for _, ct := range []string{
		"application/x-www-form-urlencoded", // what `curl -d` actually sends
		"multipart/form-data; boundary=x",
		"text/plain",
		"application/jsonx",
		"", // an empty but present header
		"application/json; charset",
	} {
		t.Run("rejected: "+ct, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
			r.Header["Content-Type"] = []string{ct}
			if _, err := Bind[payload](r); !errors.Is(err, errContentType) {
				t.Fatalf("Content-Type %q bound: %v", ct, err)
			}
		})
	}

	for _, ct := range []string{
		"application/json",
		"application/json; charset=utf-8",
		"Application/JSON",
	} {
		t.Run("accepted: "+ct, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
			r.Header.Set("Content-Type", ct)
			v, err := Bind[payload](r)
			if err != nil || v.Data != "ok" {
				t.Fatalf("Content-Type %q rejected: %v %+v", ct, err, v)
			}
		})
	}
}
