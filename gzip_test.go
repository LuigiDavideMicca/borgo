package borgo

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
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
	for _, header := range []string{"", "gzip;q=0", "br", "gzip;q=0, *", "*, gzip;q=0"} {
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

func benchGzip(b *testing.B, body func(http.ResponseWriter)) {
	b.Helper()
	h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { body(w) }))
	req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Accept-Encoding", "gzip")
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
	benchGzip(b, func(w http.ResponseWriter) { WriteJSON(w, http.StatusOK, items) })
}

func BenchmarkGzipSmallIdentity(b *testing.B) {
	benchGzip(b, func(w http.ResponseWriter) {
		WriteJSON(w, http.StatusOK, map[string]string{"ok": "yes"})
	})
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
