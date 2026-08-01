package borgo

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/textproto"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestServerConfigDefaults(t *testing.T) {
	srv := newServer("3501", http.NewServeMux())
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
	srv := newServer("3501", nil)
	if srv.ReadHeaderTimeout != 11*time.Second || srv.ReadTimeout != 30*time.Second ||
		srv.WriteTimeout != 45*time.Second || srv.IdleTimeout != 0 {
		t.Errorf("overrides not applied: %+v", srv)
	}
}

func TestServerConfigRejectsGarbage(t *testing.T) {
	t.Setenv("BORGO_READ_HEADER_TIMEOUT", "fast")
	defer func() {
		if r := recover(); r == nil || !strings.Contains(fmt.Sprint(r), "BORGO_READ_HEADER_TIMEOUT") {
			t.Fatalf("want actionable panic, got %v", r)
		}
	}()
	newServer("3501", nil)
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

// the shutdown signal is process-wide; re-arm it afterwards so the rest of the
// package still sees live streams
func isolateShutdownSignal(t *testing.T) {
	t.Helper()
	armShutdown()
	t.Cleanup(armShutdown)
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

// Serve calls log.Fatal and never returns, so nothing could start the api from
// a test or embed it in a larger program. ServeContext has to actually come
// back, and leave the port behind it.
func TestServeContextReturnsAndReleasesPort(t *testing.T) {
	isolateShutdownSignal(t)
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
	isolateShutdownSignal(t)
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
}

// the timeout matrix is still read - and still read before the banner, so a
// typo fails the boot rather than half-configuring the server
func TestServeContextStillValidatesTimeouts(t *testing.T) {
	restoreRegistry(t)
	t.Setenv("BORGO_IDLE_TIMEOUT", "soon")
	t.Setenv("API_PORT", freePort(t))
	defer func() {
		if r := recover(); r == nil || !strings.Contains(fmt.Sprint(r), "BORGO_IDLE_TIMEOUT") {
			t.Fatalf("want a panic naming the variable, got %v", r)
		}
	}()
	ServeContext(context.Background())
}

func TestShutdownEndsEventStreams(t *testing.T) {
	isolateShutdownSignal(t)

	handlerReturned := make(chan struct{})
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerReturned)
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
	})}
	srv.RegisterOnShutdown(signalShutdown)

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

func TestShutdownCutsRequestsPastTheGrace(t *testing.T) {
	isolateShutdownSignal(t)

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
	if got := envDuration("BORGO_SHUTDOWN_TIMEOUT", 10*time.Second); got != 3*time.Second {
		t.Fatalf("grace = %v, want 3s", got)
	}
}

func TestBindCapsBodies(t *testing.T) {
	type payload struct {
		Data string `json:"data"`
	}
	big := `{"data":"` + strings.Repeat("x", bindLimit) + `"}`
	small := `{"data":"ok"}`

	t.Run("oversized body is a 413", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(big))
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
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(small))
		v, err := Bind[payload](r)
		if err != nil || v.Data != "ok" {
			t.Fatalf("bind failed: %v %+v", err, v)
		}
	})

	t.Run("malformed body is a 400", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("not json"))
		_, err := Bind[payload](r)
		w := httptest.NewRecorder()
		BindError(w, err)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("want 400, got %d", w.Code)
		}
	})

	t.Run("BindMax overrides the cap", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(big))
		if _, err := BindMax[payload](r, int64(len(big))+1); err != nil {
			t.Fatalf("raised cap must decode: %v", err)
		}
		r = httptest.NewRequest(http.MethodPost, "/", strings.NewReader(small))
		if _, err := BindMax[payload](r, 4); err == nil {
			t.Fatal("tiny cap must reject")
		}
		r = httptest.NewRequest(http.MethodPost, "/", strings.NewReader(big))
		if _, err := BindMax[payload](r, 0); err != nil {
			t.Fatalf("0 disables the cap: %v", err)
		}
	})
}
