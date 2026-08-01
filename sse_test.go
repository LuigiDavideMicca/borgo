package borgo

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSSEStream(t *testing.T) {
	w := httptest.NewRecorder()
	stream, err := SSE(w, httptest.NewRequest(http.MethodGet, "/events", nil))
	if err != nil {
		t.Fatal(err)
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type = %q", ct)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control = %q", cc)
	}

	if err := stream.Send("greet", map[string]string{"msg": "ciao"}); err != nil {
		t.Fatal(err)
	}
	if err := stream.Ping(); err != nil {
		t.Fatal(err)
	}

	body := w.Body.String()
	if !strings.Contains(body, "event: greet\ndata: {\"msg\":\"ciao\"}\n\n") {
		t.Errorf("event framing wrong:\n%s", body)
	}
	if !strings.Contains(body, ": ping\n\n") {
		t.Errorf("ping framing wrong:\n%s", body)
	}
}

// A stream that writes nothing until its first event reaches the browser only
// when its first event does: an intermediary is entitled to hold the header
// block until the body starts, and Bun.serve - the front server proxying this
// very response - does exactly that. So SSE must put bytes on the wire before
// it returns, not merely flush headers.
func TestSSEOpensWithBytesBeforeAnyEvent(t *testing.T) {
	w := httptest.NewRecorder()
	if _, err := SSE(w, httptest.NewRequest(http.MethodGet, "/events", nil)); err != nil {
		t.Fatal(err)
	}
	opening := w.Body.String()
	if opening == "" {
		t.Fatal("SSE wrote no body before the first event; a proxy may hold the headers until one arrives")
	}
	// whatever it is, a client must be able to ignore it: only a comment can be
	// sent before the app's own events without inventing an event of its own
	for _, line := range strings.Split(strings.TrimSuffix(opening, "\n\n"), "\n") {
		if !strings.HasPrefix(line, ":") {
			t.Errorf("opening bytes %q contain a non-comment line %q", opening, line)
		}
	}
	if !w.Flushed {
		t.Error("opening bytes were not flushed, so they may sit in a buffer")
	}
}

type noFlushWriter struct{ header http.Header }

func (w *noFlushWriter) Header() http.Header         { return w.header }
func (w *noFlushWriter) Write(b []byte) (int, error) { return len(b), nil }
func (w *noFlushWriter) WriteHeader(int)             {}

func TestSSERequiresFlusher(t *testing.T) {
	if _, err := SSE(&noFlushWriter{header: http.Header{}}, httptest.NewRequest(http.MethodGet, "/", nil)); err == nil {
		t.Fatal("want error for non-flushing writer")
	}
}

func TestHubSkipsSlowClients(t *testing.T) {
	hub := NewSSEHub()
	slow := make(chan []byte, 1)
	hub.mu.Lock()
	hub.subs[slow] = struct{}{}
	hub.mu.Unlock()

	hub.Publish("first", 1)
	hub.Publish("second", 2)

	if len(slow) != 1 {
		t.Fatalf("want exactly one buffered message, got %d", len(slow))
	}
	if frame := string(<-slow); !strings.HasPrefix(frame, "event: first\n") {
		t.Fatalf("kept message = %q, want first", frame)
	}
}

// an unencodable payload used to travel to every subscriber and fail there,
// closing every open stream
func TestHubDropsUnpublishableEvents(t *testing.T) {
	hub := NewSSEHub()
	sub := make(chan []byte, 4)
	hub.mu.Lock()
	hub.subs[sub] = struct{}{}
	hub.mu.Unlock()

	hub.Publish("broken", make(chan int))
	hub.Publish("multi\nline", 1)
	hub.Publish("fine", 1)

	if len(sub) != 1 {
		t.Fatalf("want only the valid event queued, got %d", len(sub))
	}
	if frame := string(<-sub); !strings.HasPrefix(frame, "event: fine\n") {
		t.Fatalf("queued frame = %q", frame)
	}
}

func TestHubUnderConcurrentSubscribers(t *testing.T) {
	hub := NewSSEHub()
	server := httptest.NewServer(hub)
	defer server.Close()

	stop := make(chan struct{})
	var publishers sync.WaitGroup
	for p := range 4 {
		publishers.Add(1)
		go func() {
			defer publishers.Done()
			for i := 0; ; i++ {
				select {
				case <-stop:
					return
				default:
				}
				hub.Publish("tick", map[string]int{"p": p, "i": i})
			}
		}()
	}

	var clients sync.WaitGroup
	for range 16 {
		clients.Add(1)
		go func() {
			defer clients.Done()
			for range 8 {
				ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
				req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
				res, err := http.DefaultClient.Do(req)
				if err == nil {
					io.Copy(io.Discard, io.LimitReader(res.Body, 1<<12))
					res.Body.Close()
				}
				cancel()
			}
		}()
	}
	clients.Wait()
	close(stop)
	publishers.Wait()

	// every stream that ended must have unsubscribed: a hub that leaks slots
	// grows without bound
	deadline := time.Now().Add(5 * time.Second)
	for {
		hub.mu.Lock()
		n := len(hub.subs)
		hub.mu.Unlock()
		if n == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d subscriptions leaked after every client disconnected", n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// waitSubscribers blocks until the hub reports n subscribers.
func waitSubscribers(t *testing.T, hub *SSEHub, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if got := hub.Subscribers(); got == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("hub has %d subscribers, want %d", hub.Subscribers(), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// the websocket relay reports presence through a built-in __count; the hub had
// no equivalent, so an app could not tell whether producing an event was worth
// the work
func TestHubSubscribers(t *testing.T) {
	hub := NewSSEHub()
	server := httptest.NewServer(hub)
	// as above: cut the connections first, so a failure reports its assertion
	// rather than hanging in Close waiting for streams that are still open
	defer func() {
		server.CloseClientConnections()
		server.Close()
	}()

	if got := hub.Subscribers(); got != 0 {
		t.Fatalf("fresh hub reports %d subscribers", got)
	}

	var bodies []io.ReadCloser
	for i := 1; i <= 3; i++ {
		res, err := http.Get(server.URL)
		if err != nil {
			t.Fatal(err)
		}
		bodies = append(bodies, res.Body)
		waitSubscribers(t, hub, i)
	}
	for i, body := range bodies {
		body.Close()
		waitSubscribers(t, hub, len(bodies)-i-1)
	}

	// and it agrees with the map it counts
	hub.mu.Lock()
	n := len(hub.subs)
	hub.mu.Unlock()
	if n != hub.Subscribers() {
		t.Fatalf("Subscribers() = %d, map holds %d", hub.Subscribers(), n)
	}
}

// there was no way to end every stream short of shutting the process down
func TestHubCloseEndsEveryStream(t *testing.T) {
	hub := NewSSEHub()
	server := httptest.NewServer(hub)
	// httptest's Close waits for outstanding requests, so a hub that fails to
	// end its streams would wedge here and report a timeout instead of the
	// assertion that caught it
	defer func() {
		server.CloseClientConnections()
		server.Close()
	}()

	ended := make(chan struct{}, 3)
	for range 3 {
		res, err := http.Get(server.URL)
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			defer res.Body.Close()
			io.Copy(io.Discard, res.Body) // returns when the stream ends
			ended <- struct{}{}
		}()
	}
	waitSubscribers(t, hub, 3)

	hub.Close()

	// Close accounts for the subscriptions itself, so this is not a poll
	if got := hub.Subscribers(); got != 0 {
		t.Fatalf("Subscribers() = %d immediately after Close, want 0", got)
	}
	for i := range 3 {
		select {
		case <-ended:
		case <-time.After(5 * time.Second):
			t.Fatalf("stream %d never ended after Close", i)
		}
	}

	// the hub is inert afterwards, and Close is idempotent
	hub.Publish("after", 1)
	hub.Close()
	hub.Close()
	if got := hub.Subscribers(); got != 0 {
		t.Fatalf("Subscribers() = %d on a closed hub", got)
	}

	// a client arriving after Close gets a stream that finishes at once
	res, err := http.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		io.Copy(io.Discard, res.Body)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a request to a closed hub hung instead of ending at once")
	}
}

// Subscribers documents that a closed hub reads 0 from the moment Close
// returns, but a ServeHTTP arriving afterwards used to register itself anyway
// and unwind a microsecond later on its first select - so a presence counter
// on a retired hub could sample a subscriber that was never really there. The
// count on a closed hub is a guarantee, not a sample: nothing may register.
func TestClosedHubNeverReportsASubscriber(t *testing.T) {
	hub := NewSSEHub()
	hub.Close()

	stop := make(chan struct{})
	peak := make(chan int, 1)
	go func() {
		highest := 0
		for {
			if n := hub.Subscribers(); n > highest {
				highest = n
			}
			select {
			case <-stop:
				peak <- highest
				return
			default:
			}
		}
	}()

	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 250 {
				hub.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/events", nil))
			}
		}()
	}
	wg.Wait()
	close(stop)

	if n := <-peak; n != 0 {
		t.Fatalf("Subscribers() read %d on a closed hub; a request that arrives after Close must not register at all", n)
	}
}

// the hub's discipline is a single mutex around a non-blocking publish and a
// deferred unsubscribe; the count and the close have to live inside it. Run
// under -race, every combination at once.
func TestHubCloseAndCountAreRaceFree(t *testing.T) {
	hub := NewSSEHub()
	server := httptest.NewServer(hub)
	defer server.Close()

	var wg sync.WaitGroup
	stop := make(chan struct{})

	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; ; i++ {
				select {
				case <-stop:
					return
				default:
				}
				hub.Publish("tick", map[string]int{"i": i})
			}
		}()
	}
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				_ = hub.Subscribers()
			}
		}()
	}
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 4 {
				ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
				req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
				if res, err := http.DefaultClient.Do(req); err == nil {
					io.Copy(io.Discard, io.LimitReader(res.Body, 1<<12))
					res.Body.Close()
				}
				cancel()
			}
		}()
	}
	// several concurrent Closes, from the middle of the traffic
	closers := make(chan struct{})
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-closers
			hub.Close()
		}()
	}
	time.Sleep(100 * time.Millisecond)
	close(closers)
	time.Sleep(100 * time.Millisecond)
	close(stop)
	wg.Wait()

	if got := hub.Subscribers(); got != 0 {
		t.Fatalf("%d subscribers left on a closed hub", got)
	}
}

func BenchmarkHubPublish(b *testing.B) {
	hub := NewSSEHub()
	for range 100 {
		ch := make(chan []byte, 1)
		hub.subs[ch] = struct{}{}
		// drain so the buffer never fills and short-circuits the send
		go func() {
			for range ch {
			}
		}()
	}
	payload := map[string]any{"id": 7, "title": "a task", "done": false}
	b.ReportAllocs()
	for b.Loop() {
		hub.Publish("task-created", payload)
	}
}

func TestHubBroadcast(t *testing.T) {
	hub := NewSSEHub()
	server := httptest.NewServer(hub)
	defer server.Close()

	res, err := http.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	// wait for the subscription to register before publishing
	deadline := time.Now().Add(2 * time.Second)
	for {
		hub.mu.Lock()
		n := len(hub.subs)
		hub.mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("client never subscribed")
		}
		time.Sleep(5 * time.Millisecond)
	}

	hub.Publish("task-created", map[string]int{"id": 7})

	scanner := bufio.NewScanner(res.Body)
	var lines []string
	for scanner.Scan() {
		line := scanner.Text()
		// the stream opens with a comment so the headers reach the client
		// before the first event; comments and separators are not framing
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		lines = append(lines, line)
		if len(lines) == 2 {
			break
		}
	}
	if len(lines) != 2 || lines[0] != "event: task-created" || lines[1] != `data: {"id":7}` {
		t.Fatalf("broadcast frames wrong: %q", lines)
	}
}
