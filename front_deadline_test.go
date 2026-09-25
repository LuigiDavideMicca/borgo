package borgo

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The public port has read and write deadlines by default, and net/http's are
// whole-exchange deadlines: a response still streaming, or a body still
// arriving, when one passes is cut however healthy it is. borgo.SSE lifts them
// for its own connection. These hold the same for what the front carries to
// and from the render service - a render that streams, an upload that takes
// its time - which nothing lifted, while the docs said a streaming render was
// exempt.

// a renderer that answers the internal names at once, so the front's read of
// the policy table spends none of the deadline the test is about
func deadlineRenderer(t *testing.T, page http.HandlerFunc) *httptest.Server {
	t.Helper()
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/__borgo") {
			http.NotFound(w, r)
			return
		}
		page(w, r)
	}))
	t.Cleanup(renderer.Close)
	return renderer
}

func frontWithDeadlines(t *testing.T, renderer *httptest.Server, timeout time.Duration) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(frontWith(t, renderer, frontOptions{trusted: trustAll}))
	srv.Config.ReadTimeout = timeout
	srv.Config.WriteTimeout = timeout
	srv.Start()
	t.Cleanup(srv.Close)
	return srv
}

func TestAStreamedRenderOutlivesTheWriteDeadline(t *testing.T) {
	renderer := deadlineRenderer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		for i := 0; i < 4; i++ {
			fmt.Fprintf(w, "<p>chunk %d</p>\n", i)
			w.(http.Flusher).Flush()
			time.Sleep(150 * time.Millisecond)
		}
	})
	// the stream takes 600ms against a 200ms deadline
	front := frontWithDeadlines(t, renderer, 200*time.Millisecond)

	res, err := http.Get(front.URL + "/slow")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if n := strings.Count(string(body), "<p>chunk"); err != nil || n != 4 {
		t.Fatalf("a render still streaming at the write deadline was cut: %d of 4 chunks (%v)", n, err)
	}
}

func TestAProxiedEventStreamOutlivesTheWriteDeadline(t *testing.T) {
	renderer := deadlineRenderer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for i := 0; i < 4; i++ {
			fmt.Fprintf(w, "event: tick\ndata: %d\n\n", i)
			w.(http.Flusher).Flush()
			time.Sleep(150 * time.Millisecond)
		}
	})
	front := frontWithDeadlines(t, renderer, 200*time.Millisecond)

	res, err := http.Get(front.URL + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if n := strings.Count(string(body), "event: tick"); err != nil || n != 4 {
		t.Fatalf("an event stream still running at the write deadline was cut: %d of 4 events (%v)", n, err)
	}
}

// the protection the deadline exists for stays: a body that stops arriving
// is cut once the silence outlasts it, however little was sent
func TestAStalledUploadIsStillCut(t *testing.T) {
	received := make(chan int, 1)
	renderer := deadlineRenderer(t, func(w http.ResponseWriter, r *http.Request) {
		n, _ := io.Copy(io.Discard, r.Body)
		received <- int(n)
		w.WriteHeader(http.StatusNoContent)
	})
	front := frontWithDeadlines(t, renderer, 200*time.Millisecond)

	body, writer := io.Pipe()
	go func() {
		writer.Write(bytes.Repeat([]byte("x"), 1024))
		// silent for three deadlines, then the rest
		time.Sleep(600 * time.Millisecond)
		writer.Write(bytes.Repeat([]byte("x"), 3072))
		writer.Close()
	}()
	req, err := http.NewRequest(http.MethodPost, front.URL+"/upload", body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := http.DefaultClient.Do(req)
	if err == nil {
		res.Body.Close()
	}
	select {
	case n := <-received:
		if n == 4096 {
			t.Fatal("a body silent for three read deadlines arrived whole: the deadline no longer bounds silence")
		}
	case <-time.After(5 * time.Second):
		// the render service never saw a complete body: cut, as it should be
	}
}

func TestASlowUploadOutlivesTheReadDeadline(t *testing.T) {
	received := make(chan int, 1)
	renderer := deadlineRenderer(t, func(w http.ResponseWriter, r *http.Request) {
		n, _ := io.Copy(io.Discard, r.Body)
		received <- int(n)
		w.WriteHeader(http.StatusNoContent)
	})
	front := frontWithDeadlines(t, renderer, 200*time.Millisecond)

	body, writer := io.Pipe()
	go func() {
		for i := 0; i < 4; i++ {
			writer.Write(bytes.Repeat([]byte("x"), 1024))
			time.Sleep(150 * time.Millisecond)
		}
		writer.Close()
	}()
	req, err := http.NewRequest(http.MethodPost, front.URL+"/upload", body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("a body still arriving at the read deadline was cut: %v", err)
	}
	res.Body.Close()
	select {
	case n := <-received:
		if n != 4096 {
			t.Fatalf("the render service received %d of 4096 bytes", n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the render service never received the body")
	}
}

// what http.ResponseController reaches on a real connection, recorded: the
// deadlines each read and write asked for
type deadlineRecorder struct {
	*httptest.ResponseRecorder
	writes, reads []time.Time
}

func (d *deadlineRecorder) SetWriteDeadline(t time.Time) error {
	d.writes = append(d.writes, t)
	return nil
}

func (d *deadlineRecorder) SetReadDeadline(t time.Time) error {
	d.reads = append(d.reads, t)
	return nil
}

func serveWithDeadlines(srv *http.Server, req *http.Request, handler http.HandlerFunc) *deadlineRecorder {
	rec := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	req = req.WithContext(context.WithValue(req.Context(), http.ServerContextKey, srv))
	progressDeadlines(handler).ServeHTTP(rec, req)
	return rec
}

func TestProgressDeadlinesRollWritesAndLeaveAStreamItsOwn(t *testing.T) {
	srv := &http.Server{ReadTimeout: time.Minute, WriteTimeout: time.Minute}

	start := time.Now()
	page := serveWithDeadlines(srv, httptest.NewRequest(http.MethodGet, "/", nil), func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte("a"))
		w.Write([]byte("b"))
	})
	if len(page.writes) != 2 || page.writes[0].Before(start.Add(59*time.Second)) || page.writes[1].Before(page.writes[0]) {
		t.Fatalf("a page's writes asked for %v: want each a minute past itself", page.writes)
	}

	// an event stream: the armed deadline cleared once, then only what the
	// stream sets for itself - borgo.SSE's 10 seconds per write, which a
	// minute set from out here would widen
	own := time.Now().Add(10 * time.Second)
	stream := serveWithDeadlines(srv, httptest.NewRequest(http.MethodGet, "/", nil), func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(":ok\n\n"))
		http.NewResponseController(w).SetWriteDeadline(own)
		w.Write([]byte("data: 1\n\n"))
	})
	if len(stream.writes) != 2 || !stream.writes[0].IsZero() || !stream.writes[1].Equal(own) {
		t.Fatalf("an event stream's deadlines were %v: want the armed one cleared, then only its own", stream.writes)
	}

	start = time.Now()
	upload := serveWithDeadlines(srv, httptest.NewRequest(http.MethodPost, "/", strings.NewReader("xyz")), func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
	})
	if len(upload.reads) == 0 || upload.reads[0].Before(start.Add(59*time.Second)) {
		t.Fatalf("reading the body asked for %v: want a minute past each read", upload.reads)
	}
}

// an operator's 0 is no deadline, not a deadline of now
func TestProgressDeadlinesKeepAnOperatorsZero(t *testing.T) {
	srv := &http.Server{ReadTimeout: time.Minute, WriteTimeout: 0}
	rec := serveWithDeadlines(srv, httptest.NewRequest(http.MethodPost, "/", strings.NewReader("xyz")), func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		w.Write([]byte("done"))
	})
	if len(rec.writes) != 0 {
		t.Fatalf("WriteTimeout 0 asked for write deadlines %v", rec.writes)
	}
	none := serveWithDeadlines(&http.Server{}, httptest.NewRequest(http.MethodPost, "/", strings.NewReader("xyz")), func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		w.Write([]byte("done"))
	})
	if len(none.writes)+len(none.reads) != 0 {
		t.Fatalf("a server without deadlines was given some: %v %v", none.writes, none.reads)
	}
}

// an api served alone streams through its own door the same way
func TestAnApiAloneStreamsPastTheWriteDeadline(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		for i := 0; i < 4; i++ {
			fmt.Fprintf(w, "chunk %d\n", i)
			http.NewResponseController(w).Flush()
			time.Sleep(150 * time.Millisecond)
		}
	})
	srv := httptest.NewUnstartedServer(apiOnlyHandler(nil, 1<<20, nil, mux, nil))
	srv.Config.WriteTimeout = 200 * time.Millisecond
	srv.Start()
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/stream", nil)
	req.Header.Set("Accept-Encoding", "identity")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if n := strings.Count(string(body), "chunk"); err != nil || n != 4 {
		t.Fatalf("an api alone cut its stream at the write deadline: %d of 4 chunks (%v)", n, err)
	}
}
