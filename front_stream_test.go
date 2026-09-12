package borgo

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

// httputil.ReverseProxy already flushes a chunked response and an event
// stream on every write, whatever FlushInterval says - so a chunked render
// proves nothing about the setting, and the first version of this test
// passed with FlushInterval at 0. What -1 still decides is a response that
// declares its length and writes it in parts: at 0 the proxy copies it into
// a buffer and the client sees nothing until it fills or the body ends. The
// suite had no test for either. Found by the verifier of phase 1; the
// mutation that survived this test's first version is what narrowed it.
func TestTheFrontDoesNotBufferAStream(t *testing.T) {
	release := make(chan struct{})
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Length", strconv.Itoa(len("<html>shell rest</html>")))
		w.WriteHeader(200)
		io.WriteString(w, "<html>shell")
		http.NewResponseController(w).Flush()
		<-release
		io.WriteString(w, " rest</html>")
	}))
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	front := httptest.NewServer(newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll}, u, testInternalKey, time.Second))
	defer front.Close()
	// registered after front.Close so it runs BEFORE it: closing the front
	// waits for the proxied request, which waits on this. The other order
	// turned a failure of this test into a ten-minute hang that go test
	// reports as a timeout, with no FAIL line naming the test
	defer close(release)

	// the request itself inside the goroutine: a buffering front holds back
	// the headers too, so http.Get would never return and a timer started
	// after it would never run
	first := make(chan string, 1)
	go func() {
		res, err := http.Get(front.URL + "/page")
		if err != nil {
			first <- "error: " + err.Error()
			return
		}
		defer res.Body.Close()
		buf := make([]byte, len("<html>shell"))
		n, _ := io.ReadFull(res.Body, buf)
		first <- string(buf[:n])
	}()
	select {
	case got := <-first:
		if got != "<html>shell" {
			t.Errorf("the first chunk is %q", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the shell never reached the client while the render was still going: the front buffered the stream")
	}
}

// DisableCompression keeps the front from asking the render service for gzip
// on a client's behalf and inflating what comes back. With it off, the
// transport adds its own Accept-Encoding to a request that carried none and
// transparently decodes the answer. Nothing tested either direction. Found by
// the verifier of phase 1.
func TestTheFrontNeitherAsksForNorInflatesACoding(t *testing.T) {
	page := []byte(strings.Repeat("<p>compressed</p>", 50))
	var coded bytes.Buffer
	zw := gzip.NewWriter(&coded)
	zw.Write(page)
	zw.Close()

	asked := make(chan string, 2)
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked <- r.Header.Get("Accept-Encoding")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			w.Write(coded.Bytes())
			return
		}
		w.Write(page)
	}))
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll}, u, testInternalKey, time.Second)

	// a client that asked for no coding: the render service must not be asked
	w := httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "http://app.example/page", nil))
	if got := <-asked; got != "" {
		t.Errorf("the render service was asked for %q on behalf of a client that asked for nothing", got)
	}

	// a client that asked for gzip: the coded bytes reach it as they were written
	req := httptest.NewRequest("GET", "http://app.example/page", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	w = httptest.NewRecorder()
	front.ServeHTTP(w, req)
	<-asked
	if w.Header().Get("Content-Encoding") != "gzip" || !bytes.Equal(w.Body.Bytes(), coded.Bytes()) {
		t.Errorf("the gzip body was not passed through untouched: %q, %d bytes", w.Header().Get("Content-Encoding"), w.Body.Len())
	}
}

// A proxied event stream is an active request to net/http, and no latch
// reached it: Shutdown waited for it, the whole grace by default and forever
// with BORGO_SHUTDOWN_TIMEOUT=0. borgo.SSE's own streams have ended on
// shutdown since 0.19; a proxied one now does the same. Found by the verifier
// of phase 1.
func TestAProxiedEventStreamEndsOnShutdown(t *testing.T) {
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		io.WriteString(w, ": ok\n\n")
		http.NewResponseController(w).Flush()
		<-r.Context().Done()
	}))
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	front := httptest.NewServer(newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll}, u, testInternalKey, time.Second))
	defer front.Close()

	res, err := http.Get(front.URL + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if line, _ := bufio.NewReader(res.Body).ReadString('\n'); line != ": ok\n" {
		t.Fatalf("the stream opened with %q", line)
	}

	// no deadline at all: the grace of 0
	done := make(chan error, 1)
	go func() { done <- front.Config.Shutdown(context.Background()) }()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("shutdown: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown with no grace deadline waited on a proxied event stream")
	}
}

// the one place a document and a stream are told apart
func TestIsEventStream(t *testing.T) {
	for ct, want := range map[string]bool{
		"text/event-stream":                true,
		"text/event-stream; charset=utf-8": true,
		"TEXT/Event-Stream":                true,
		"text/html; charset=utf-8":         false,
		"":                                 false,
		"text/event-streamx":               false,
	} {
		if got := isEventStream(ct); got != want {
			t.Errorf("isEventStream(%q) = %v", ct, got)
		}
	}
}

// the refusal used to say "0 disables" for the one duration where 0 means
// the opposite: wait for every open request, however long
func TestTheShutdownGraceRefusalSaysWhatZeroDoes(t *testing.T) {
	t.Setenv("BORGO_SHUTDOWN_TIMEOUT", "ten seconds")
	_, err := envDuration("BORGO_SHUTDOWN_TIMEOUT", 10*time.Second)
	if err == nil || strings.Contains(err.Error(), "disables") || !strings.Contains(err.Error(), "waits") {
		t.Errorf("the refusal reads %v", err)
	}
	t.Setenv("BORGO_READ_TIMEOUT", "ten seconds")
	if _, err := envDuration("BORGO_READ_TIMEOUT", 0); err == nil || !strings.Contains(err.Error(), `"0" disables`) {
		t.Errorf("a deadline's refusal changed: %v", err)
	}
}
