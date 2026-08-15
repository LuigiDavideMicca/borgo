package borgo

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAcceptsGzip(t *testing.T) {
	cases := []struct {
		header string
		want   bool
	}{
		{"", false},
		{"gzip", true},
		{"gzip, deflate, br", true},
		{"deflate, gzip;q=0.5", true},
		{"gzip;q=0", false},
		{"gzip;q=0.0", false},
		{"gzip; q=0.00", false},
		{"gzip;q=0.5", true},
		// coding names are case-insensitive
		{"GZIP", true},
		{"Gzip;q=0", false},
		{"*;q=0", false},
		// and so are parameter names (RFC 9110 5.6.6): a client that spells
		// its refusal "Q=0" refused, and compressing it ships bytes it just
		// said it cannot decode
		{"gzip;Q=0", false},
		{"gzip; Q=0.00", false},
		{"GZIP;Q=0", false},
		{"*;Q=0", false},
		{"gzip;Q=0, *", false},
		{"deflate, gzip;Q=0.5", true},
		{"*;Q=0, gzip", true},
		// a q that is not a number is not a quality the client offered: NaN
		// parses fine and survives every "<= 0" test, so it used to compress
		{"gzip;q=NaN", false},
		{"gzip;q=nan", false},
		{"*;q=NaN", false},
		{"gzip;q=", false},
		{"gzip;q=high", false},
		{"gzip;q=NaN, deflate", false},
		{"br", false},
		{"*", true},
		{"identity", false},
		// "*" covers only the codings the header did not name, so an explicit
		// gzip refusal wins wherever it sits in the list
		{"gzip;q=0, *", false},
		{"*, gzip;q=0", false},
		{"gzip;q=0, *;q=1", false},
		{"identity, *;q=0", false},
		// and an explicit acceptance beats a wildcard refusal
		{"*;q=0, gzip", true},
		{"gzip;q=0.001", true},
		// a refusal wins wherever it sits, however many times the coding or
		// the parameter is spelled out: reading only the first of either
		// compressed for a client that had already said no
		{"gzip, gzip;q=0", false},
		{"gzip;q=1, gzip;q=0", false},
		{"gzip;q=0, gzip", false},
		{"gzip;q=1;q=0", false},
		{"gzip;q=0;q=1", false},
		{"*, *;q=0", false},
		{"deflate, gzip, br, gzip;q=0", false},
		{"gzip;q=1, gzip;q=1", true},
		// a parameter that names q and gives no value offers no quality
		{"gzip;q", false},
		{"gzip;Q", false},
		{"gzip;q=1;q", false},
		{"*;q", false},
		// a qvalue is "0" or "1" with at most three decimals, nothing else.
		// strconv.ParseFloat also reads Go literals, so "1_0" became ten and
		// "1e0" one - numbers no HTTP client ever sent
		{"gzip;q=1_0", false},
		{"gzip;q=1e0", false},
		{"gzip;q=0x1", false},
		{"gzip;q=+1", false},
		{"gzip;q=.5", false},
		{"gzip;q=1.5", false},
		{"gzip;q=2", false},
		{"gzip;q=0.5000", false},
		{"gzip;q=Inf", false},
		{"gzip;q=1.000", true},
		{"gzip;q=1.0", true},
		{"gzip;q=0.100", true},
	}
	for _, c := range cases {
		if got := acceptsGzip(c.header); got != c.want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", c.header, got, c.want)
		}
	}
}

func serveGzip(t *testing.T, acceptEncoding string, h http.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/test", nil)
	if acceptEncoding != "" {
		req.Header.Set("Accept-Encoding", acceptEncoding)
	}
	rec := httptest.NewRecorder()
	gzipMiddleware(h).ServeHTTP(rec, req)
	return rec
}

func TestGzipMiddlewareCompressesLargeJSON(t *testing.T) {
	items := make([]string, 200)
	for i := range items {
		items[i] = "a task title that repeats"
	}
	rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, items)
	})

	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
		t.Errorf("Vary = %q, want Accept-Encoding", got)
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "a task title that repeats") {
		t.Error("decompressed body lost the payload")
	}
	if rec.Body.Len() >= len(body) {
		t.Errorf("wire size %d not smaller than payload %d", rec.Body.Len(), len(body))
	}
}

func TestGzipMiddlewareLeavesSmallResponsesIdentity(t *testing.T) {
	rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusCreated, map[string]string{"ok": "yes"})
	})
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want none", got)
	}
	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want 201", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"ok":"yes"`) {
		t.Errorf("body = %q", rec.Body.String())
	}
}

func TestGzipMiddlewareRespectsClient(t *testing.T) {
	big := strings.Repeat("data ", 1000)
	for _, header := range []string{"", "gzip;q=0", "br", "gzip;q=0, *", "*, gzip;q=0",
		"gzip, gzip;q=0", "gzip;q=1;q=0", "gzip;q", "gzip;q=1_0", "gzip;q=1.5"} {
		rec := serveGzip(t, header, func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(big))
		})
		if got := rec.Header().Get("Content-Encoding"); got != "" {
			t.Errorf("Accept-Encoding %q: Content-Encoding = %q, want none", header, got)
		}
		if rec.Body.String() != big {
			t.Errorf("Accept-Encoding %q: body mangled", header)
		}
		// identity responses vary by Accept-Encoding too: without this a
		// shared cache would serve the uncompressed body to everyone
		if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
			t.Errorf("Accept-Encoding %q: Vary = %q, want Accept-Encoding", header, got)
		}
	}
}

// Accept-Encoding can arrive as several field lines, which RFC 9110 5.3 makes
// equivalent to the one list they join into. Reading only the first line
// (Header.Get) shipped gzip to a client whose second line refused it.
func TestGzipReadsEveryAcceptEncodingLine(t *testing.T) {
	big := strings.Repeat("data ", 1000)
	cases := []struct {
		name  string
		lines []string
		want  string
	}{
		{"refusal on the second line", []string{"gzip", "gzip;q=0"}, ""},
		{"refusal on the first line", []string{"gzip;q=0", "gzip"}, ""},
		{"acceptance on the second line", []string{"deflate", "gzip"}, "gzip"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
			for _, line := range c.lines {
				req.Header.Add("Accept-Encoding", line)
			}
			rec := httptest.NewRecorder()
			gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(big))
			})).ServeHTTP(rec, req)

			if got := rec.Header().Get("Content-Encoding"); got != c.want {
				t.Fatalf("lines %q: Content-Encoding = %q, want %q", c.lines, got, c.want)
			}
			if got := decodedBody(t, rec); got != big {
				t.Errorf("lines %q: body mangled (%d bytes)", c.lines, len(got))
			}
		})
	}
}

func TestGzipMiddlewarePassesThroughSSE(t *testing.T) {
	rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		stream, err := SSE(w, r)
		if err != nil {
			t.Fatal(err)
		}
		if err := stream.Send("tick", map[string]int{"n": 1}); err != nil {
			t.Fatal(err)
		}
	})
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want none on an event stream", got)
	}
	if !rec.Flushed {
		t.Error("flush did not reach the client")
	}
	if !strings.Contains(rec.Body.String(), "event: tick") {
		t.Errorf("body = %q", rec.Body.String())
	}
}

func TestGzipMiddlewarePassesThroughPreEncoded(t *testing.T) {
	rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "br")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(strings.Repeat("pretend brotli ", 200)))
	})
	if got := rec.Header().Get("Content-Encoding"); got != "br" {
		t.Fatalf("Content-Encoding = %q, want br untouched", got)
	}
}

// A compressed response without Vary: Accept-Encoding is one a shared cache
// stores and then hands to a client that cannot decode it. The header is set
// before the handler runs, so a handler that sets its own Vary - or deletes it
// - used to take ours with it; it is re-asserted at the commit, and added
// rather than substituted so the handler's reasons for varying survive.
func TestGzipVarySurvivesTheHandler(t *testing.T) {
	big := strings.Repeat("data ", 1000)
	cases := []struct {
		name       string
		mutate     func(http.Header)
		wantFields []string
	}{
		{"handler sets its own Vary", func(h http.Header) { h.Set("Vary", "Cookie") }, []string{"Cookie", "Accept-Encoding"}},
		{"handler deletes Vary", func(h http.Header) { h.Del("Vary") }, []string{"Accept-Encoding"}},
		{"handler adds to Vary", func(h http.Header) { h.Add("Vary", "Cookie") }, []string{"Accept-Encoding", "Cookie"}},
		{"handler says Vary: *", func(h http.Header) { h.Set("Vary", "*") }, []string{"*"}},
		{"handler restates ours", func(h http.Header) { h.Set("Vary", "accept-encoding") }, []string{"accept-encoding"}},
	}
	for _, c := range cases {
		for _, ae := range []string{"gzip", "identity"} {
			t.Run(c.name+"/"+ae, func(t *testing.T) {
				rec := serveGzip(t, ae, func(w http.ResponseWriter, r *http.Request) {
					c.mutate(w.Header())
					w.Write([]byte(big))
				})
				var got []string
				for _, line := range rec.Header().Values("Vary") {
					for _, f := range strings.Split(line, ",") {
						got = append(got, strings.TrimSpace(f))
					}
				}
				if !slices.Equal(got, c.wantFields) {
					t.Errorf("Vary = %q, want %q", got, c.wantFields)
				}
			})
		}
	}
}

// net/http snapshots headers at WriteHeader and ignores later mutations; the
// response buffer must not quietly honour them, or the same handler would
// behave differently the day its response outgrows the buffer
func TestGzipHeadersFreezeAtWriteHeader(t *testing.T) {
	t.Run("buffered identity", func(t *testing.T) {
		rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Early", "kept")
			w.WriteHeader(http.StatusOK)
			w.Header().Set("X-Late", "dropped")
			w.Write([]byte("small"))
		})
		if got := rec.Header().Get("X-Early"); got != "kept" {
			t.Errorf("X-Early = %q, want kept", got)
		}
		if got := rec.Header().Get("X-Late"); got != "" {
			t.Errorf("X-Late = %q, headers after WriteHeader must not ship", got)
		}
	})
	t.Run("compressed", func(t *testing.T) {
		rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Early", "kept")
			w.WriteHeader(http.StatusOK)
			w.Header().Set("X-Late", "dropped")
			w.Write([]byte(strings.Repeat("x", 2*gzipMinBytes)))
		})
		if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
			t.Fatalf("Content-Encoding = %q, want gzip", got)
		}
		if rec.Header().Get("X-Early") != "kept" || rec.Header().Get("X-Late") != "" {
			t.Errorf("headers wrong: early=%q late=%q", rec.Header().Get("X-Early"), rec.Header().Get("X-Late"))
		}
	})
}

// pooled gzip writers must never leak one response's bytes into another
func TestGzipConcurrentResponsesStayIsolated(t *testing.T) {
	handler := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]string{"who": strings.Repeat(r.URL.Path, 200)})
	}))
	var wg sync.WaitGroup
	for i := range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			want := strings.Repeat(fmt.Sprintf("/client-%d", i), 200)
			for range 8 {
				req := httptest.NewRequest("GET", fmt.Sprintf("/client-%d", i), nil)
				req.Header.Set("Accept-Encoding", "gzip")
				rec := httptest.NewRecorder()
				handler.ServeHTTP(rec, req)

				zr, err := gzip.NewReader(rec.Body)
				if err != nil {
					t.Errorf("client %d: %v", i, err)
					return
				}
				body, err := io.ReadAll(zr)
				if err != nil {
					t.Errorf("client %d: %v", i, err)
					return
				}
				var got map[string]string
				if json.Unmarshal(body, &got) != nil || got["who"] != want {
					t.Errorf("client %d got a body that is not its own", i)
					return
				}
			}
		}()
	}
	wg.Wait()
}

type discardWriter struct{ header http.Header }

func (d *discardWriter) Header() http.Header         { return d.header }
func (d *discardWriter) Write(p []byte) (int, error) { return len(p), nil }
func (d *discardWriter) WriteHeader(int)             {}

func benchGzip(b *testing.B, acceptEncoding string, body func(http.ResponseWriter)) {
	b.Helper()
	h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { body(w) }))
	req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	if acceptEncoding != "" {
		req.Header.Set("Accept-Encoding", acceptEncoding)
	}
	b.ReportAllocs()
	for b.Loop() {
		h.ServeHTTP(&discardWriter{header: http.Header{}}, req)
	}
}

func BenchmarkGzipCompressed(b *testing.B) {
	items := make([]string, 200)
	for i := range items {
		items[i] = "a task title that repeats"
	}
	benchGzip(b, "gzip", func(w http.ResponseWriter) { WriteJSON(w, http.StatusOK, items) })
}

func BenchmarkGzipSmallIdentity(b *testing.B) {
	benchGzip(b, "gzip", func(w http.ResponseWriter) {
		WriteJSON(w, http.StatusOK, map[string]string{"ok": "yes"})
	})
}

// the price of one commit point: a client that cannot take gzip now goes
// through the writer too, so the cost it pays has to stay visible
func BenchmarkGzipClientRefusesEncoding(b *testing.B) {
	benchGzip(b, "", func(w http.ResponseWriter) {
		WriteJSON(w, http.StatusOK, map[string]string{"ok": "yes"})
	})
}

// The buffer exists to decide, not to hold the response: only the first
// gzipMinBytes may ever be copied, so the cost of a large body must stay flat
// as it grows. Appending each incoming slice before testing the threshold made
// a one-Write handler allocate a second copy of its whole body - 2 MB per
// request on a 1 MB response, on the identity path too, which before the one
// commit point never touched the buffer at all. Both encodings are measured
// because both pay it.
func benchGzipLargeBody(b *testing.B, acceptEncoding string) {
	for _, size := range []int{1 << 10, 64 << 10, 1 << 20} {
		body := bytes.Repeat([]byte("borgo benchmark payload "), size/24+1)[:size]
		b.Run(fmt.Sprintf("%dKB", size>>10), func(b *testing.B) {
			benchGzip(b, acceptEncoding, func(w http.ResponseWriter) { w.Write(body) })
		})
	}
}

func BenchmarkGzipLargeBodyCompressed(b *testing.B) { benchGzipLargeBody(b, "gzip") }

func BenchmarkGzipLargeBodyIdentity(b *testing.B) { benchGzipLargeBody(b, "identity") }

// CI runs tests, not benchmarks, so the flat cost above is asserted here too:
// the guard is the growth from 64 KB to 1 MB, which is ~0 when the body is
// streamed and ~1 MB when it is copied.
func TestGzipDoesNotCopyTheBodyPastTheDecision(t *testing.T) {
	for _, ae := range []string{"gzip", "identity"} {
		t.Run(ae, func(t *testing.T) {
			small := bytesPerResponse(t, ae, 64<<10)
			large := bytesPerResponse(t, ae, 1<<20)
			if grown := int64(large) - int64(small); grown > 128<<10 {
				t.Errorf("a 1 MB response allocates %d B more than a 64 KB one (%d vs %d): the body is copied, not streamed",
					grown, large, small)
			}
		})
	}
}

// bytesPerResponse reports what one response allocates: warmed first so a
// pooled gzip writer is not charged to the window, and taken as the best of
// three so a GC draining that pool mid-window cannot fail the run.
func bytesPerResponse(t *testing.T, acceptEncoding string, size int) uint64 {
	t.Helper()
	body := bytes.Repeat([]byte("borgo benchmark payload "), size/24+1)[:size]
	h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(body) }))
	req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Accept-Encoding", acceptEncoding)

	const iters = 50
	serve := func() {
		for range iters {
			h.ServeHTTP(&discardWriter{header: http.Header{}}, req)
		}
	}
	best := ^uint64(0)
	for range 3 {
		var before, after runtime.MemStats
		serve()
		runtime.ReadMemStats(&before)
		serve()
		runtime.ReadMemStats(&after)
		best = min(best, (after.TotalAlloc-before.TotalAlloc)/iters)
	}
	return best
}

// serveWithin runs the full chain and refuses to hang: a handler that never
// returns names itself instead of taking the suite down with it.
func serveWithin(t *testing.T, h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rec := httptest.NewRecorder()
	done := make(chan any, 1)
	go func() {
		defer func() { done <- recover() }()
		h.ServeHTTP(rec, req.WithContext(ctx))
	}()
	select {
	case v := <-done:
		if v != nil {
			t.Fatalf("%s: a panic escaped the middleware chain: %v", req.Header.Get("Accept-Encoding"), v)
		}
	case <-ctx.Done():
		t.Fatalf("no response after 5s for Accept-Encoding %q: the handler never returned (%v)",
			req.Header.Get("Accept-Encoding"), ctx.Err())
	}
	return rec
}

// decodedBody returns what the client would end up holding, so a compressed
// and an identity answer to the same request are comparable.
func decodedBody(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	if rec.Header().Get("Content-Encoding") != "gzip" {
		return rec.Body.String()
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("Content-Encoding: gzip but the body is not a gzip stream: %v", err)
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gzip stream truncated mid-flight: %v", err)
	}
	return string(body)
}

// The one that counts: a panicking handler must answer the same thing whether
// or not the client asked for compression. The split used to answer 500 to a
// gzip client and a truncated 200 to everyone else - the same bug, visible
// only to half the clients, which is why nobody found it.
func TestPanicResponseDoesNotDependOnAcceptEncoding(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	buffered := `{"items":[1,2,3`
	committed := strings.Repeat("x", 2*gzipMinBytes)

	cases := []struct {
		name string
		h    http.HandlerFunc
	}{
		{"before any write", func(w http.ResponseWriter, r *http.Request) {
			panic("boom")
		}},
		{"after WriteHeader, before the first write", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			panic("boom")
		}},
		{"after a write still inside the buffer", func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(buffered))
			panic("boom")
		}},
		{"after a write past the buffer", func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(committed))
			panic("boom")
		}},
		{"after a flush", func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(buffered))
			w.(http.Flusher).Flush()
			panic("boom")
		}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			chain := recoverMiddleware(gzipMiddleware(c.h))

			plain := httptest.NewRequest(http.MethodGet, "/api/x", nil)
			identity := serveWithin(t, chain, plain)

			zipped := httptest.NewRequest(http.MethodGet, "/api/x", nil)
			zipped.Header.Set("Accept-Encoding", "gzip")
			compressed := serveWithin(t, chain, zipped)

			t.Logf("identity: %d %q | gzip: %d (%s) %q",
				identity.Code, identity.Body.String(),
				compressed.Code, compressed.Header().Get("Content-Encoding"), compressed.Body.String())

			if identity.Code != compressed.Code {
				t.Errorf("status depends on Accept-Encoding: identity %d, gzip %d",
					identity.Code, compressed.Code)
			}
			if got, want := decodedBody(t, compressed), decodedBody(t, identity); got != want {
				t.Errorf("body depends on Accept-Encoding:\n identity %q\n gzip     %q", want, got)
			}
			if got, want := compressed.Header().Get("Vary"), identity.Header().Get("Vary"); got != want {
				t.Errorf("Vary depends on Accept-Encoding: identity %q, gzip %q", want, got)
			}
		})
	}
}

// a recorder has no connection to commit to, and the defect was about what a
// real client ends up holding: same handler, same panic, one socket each
func TestPanicInsideTheBufferIsA500OverARealConnection(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	srv := httptest.NewServer(recoverMiddleware(gzipMiddleware(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"items":[1,2,3`))
			panic("mid body")
		}))))
	defer srv.Close()

	// the transport adds Accept-Encoding: gzip on its own and strips the
	// encoding again before we see it; both would hide which path ran
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
	for _, ae := range []string{"identity", "gzip"} {
		t.Run(ae, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Accept-Encoding", ae)
			res, err := client.Do(req)
			if err != nil {
				t.Fatalf("Accept-Encoding %s: no response (%v)", ae, err)
			}
			defer res.Body.Close()
			if res.StatusCode != http.StatusInternalServerError {
				t.Fatalf("Accept-Encoding %s: status = %d, want 500", ae, res.StatusCode)
			}
			payload, err := io.ReadAll(res.Body)
			if err != nil {
				t.Fatalf("Accept-Encoding %s: body cut short (%v)", ae, err)
			}
			var body map[string]string
			if json.Unmarshal(payload, &body) != nil || body["error"] == "" {
				t.Fatalf("Accept-Encoding %s: body = %q, want a whole json error", ae, payload)
			}
		})
	}
}

// past the buffer nothing can be un-sent, so the answer is the handler's own
// status with a short body - never a 500 pretending the wire was still free
func TestPanicPastTheBufferTruncatesInsteadOfRestating(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	for _, ae := range []string{"", "gzip"} {
		t.Run("Accept-Encoding "+ae, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
			if ae != "" {
				req.Header.Set("Accept-Encoding", ae)
			}
			rec := serveWithin(t, recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusTeapot)
				w.Write([]byte(strings.Repeat("y", 2*gzipMinBytes)))
				panic("late")
			}))), req)

			if rec.Code != http.StatusTeapot {
				t.Fatalf("status = %d, want the committed 418", rec.Code)
			}
			if body := decodedBody(t, rec); len(body) != 2*gzipMinBytes {
				t.Errorf("body is %d bytes, want the %d that were committed", len(body), 2*gzipMinBytes)
			}
		})
	}
}

func TestGzipMiddlewareEmptyResponse(t *testing.T) {
	rec := serveGzip(t, "gzip", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("body = %q, want empty", rec.Body.String())
	}
}

// Content-Encoding describes bytes. Where none can exist it describes nothing,
// and on a 304 it is copied by any cache refreshing the entry it stands for
// (RFC 9110 15.4.5): the stored body, never compressed, then carries a header
// saying it is. A HEAD is the same claim about a body the client cannot see,
// and gzipping it would also drop the Content-Length the handler set for the
// GET that HEAD stands in for.
func TestGzipDeclaresNoEncodingWhereNoBodyCanBe(t *testing.T) {
	big := strings.Repeat("data ", 1000)
	cases := []struct {
		name   string
		method string
		status int
	}{
		{"204 with a large body written anyway", http.MethodGet, http.StatusNoContent},
		{"304 with a large body written anyway", http.MethodGet, http.StatusNotModified},
		{"HEAD with a large body", http.MethodHead, http.StatusOK},
		{"HEAD with a small body", http.MethodHead, http.StatusOK},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(c.method, "/api/test", nil)
			req.Header.Set("Accept-Encoding", "gzip")
			rec := httptest.NewRecorder()
			gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", strconv.Itoa(len(big)))
				w.WriteHeader(c.status)
				w.Write([]byte(big))
			})).ServeHTTP(rec, req)

			if got := rec.Header().Get("Content-Encoding"); got != "" {
				t.Errorf("Content-Encoding = %q, want none: there are no bytes for it to describe", got)
			}
			if rec.Code != c.status {
				t.Errorf("status = %d, want %d", rec.Code, c.status)
			}
			// a HEAD answers about the GET it stands in for, so the length it
			// declares has to survive
			if c.method == http.MethodHead {
				if got := rec.Header().Get("Content-Length"); got != strconv.Itoa(len(big)) {
					t.Errorf("Content-Length = %q, want %d", got, len(big))
				}
			}
		})
	}
}

// finish ends the response. A handler that leaked its writer and wrote after
// returning used to re-send the buffer it had already committed, and, with the
// gzip writer cleared, open a second gzip stream nobody would close - raw
// deflate bytes under no Content-Encoding.
func TestGzipWriteAfterFinishAddsNothing(t *testing.T) {
	for _, ae := range []string{"gzip", "identity"} {
		t.Run(ae, func(t *testing.T) {
			var leaked http.ResponseWriter
			rec := serveGzip(t, ae, func(w http.ResponseWriter, r *http.Request) {
				leaked = w
				w.Write([]byte("committed"))
			})
			// past finish the writer only forwards, and a real connection
			// refuses what it forwards; what must not happen is the buffer
			// going out twice or a second gzip stream starting
			leaked.Write([]byte(strings.Repeat("late", 1000)))
			body := rec.Body.String()
			if n := strings.Count(body, "committed"); n != 1 {
				t.Errorf("the committed body went out %d times", n)
			}
			if strings.Contains(body, "\x1f\x8b\x08") {
				t.Error("a late write opened a gzip stream, under no Content-Encoding and with nobody to close it")
			}
			if got := rec.Header().Get("Content-Encoding"); got != "" {
				t.Errorf("Content-Encoding = %q, want none", got)
			}
		})
	}
}
