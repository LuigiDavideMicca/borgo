package borgo

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
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

// SSEHub is documented as built by NewSSEHub, but nothing stops `var hub
// SSEHub` - a struct field, a package-level var - and half the type already
// handled it: Publish, Close and Subscribers create the close latch lazily.
// ServeHTTP did not, so registering a subscription wrote to a nil map and
// panicked with h.mu held under a bare unlock: from that moment every Publish,
// Close, Subscribers and later ServeHTTP blocked forever on a hub that looked
// alive. The property below is scoped to that: no sequence of calls on a
// zero-value hub may panic or leave the mutex held.
//
// Every test here starts from a zero value, never NewSSEHub, and every wait is
// bounded - a wedged hub blocks its caller for good, so a test that called it
// straight would hang instead of reporting, and a hang is indistinguishable
// from a slow machine.

// hubCall runs op on its own goroutine so a held mutex fails the test instead
// of stopping it.
func hubCall(t *testing.T, what string, op func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		op()
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("%s never returned on a zero-value hub: ServeHTTP left the mutex held", what)
	}
}

func zeroHubSubscribers(t *testing.T, hub *SSEHub) int {
	t.Helper()
	n := -1
	hubCall(t, "Subscribers()", func() { n = hub.Subscribers() })
	return n
}

func waitZeroHubSubscribers(t *testing.T, hub *SSEHub, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		got := zeroHubSubscribers(t, hub)
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("zero-value hub reports %d subscribers, want %d", got, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// closeZeroHubServer stands in for `defer server.Close()`: httptest waits for
// outstanding requests, and a handler wedged on the hub's mutex never finishes
// one, so the plain defer would hang the test after its assertions passed.
func closeZeroHubServer(t *testing.T, server *httptest.Server) {
	t.Helper()
	server.CloseClientConnections()
	done := make(chan struct{})
	go func() {
		defer close(done)
		server.Close()
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Errorf("the test server never shut down: a hub handler is still wedged in ServeHTTP")
	}
}

// openZeroHubStream makes one real request - a client on a socket, not a direct
// call - and consumes the opening comment, so the subscription is live when it
// returns. The request carries a deadline, so every read below it fails loudly
// rather than blocking.
func openZeroHubStream(t *testing.T, server *httptest.Server) (*http.Response, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		cancel()
		t.Fatalf("building the request: %v", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatalf("a zero-value hub did not answer a real request: %v", err)
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		cancel()
		t.Fatalf("a zero-value hub answered %s, want 200", res.Status)
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		res.Body.Close()
		cancel()
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}
	opening := make([]byte, len(":ok\n\n"))
	if _, err := io.ReadFull(res.Body, opening); err != nil {
		res.Body.Close()
		cancel()
		t.Fatalf("reading the opening of the stream from a zero-value hub: %v", err)
	}
	return res, cancel
}

func TestZeroValueHubServesARealRequest(t *testing.T) {
	var hub SSEHub
	server := httptest.NewServer(&hub)
	defer closeZeroHubServer(t, server)

	res, cancel := openZeroHubStream(t, server)
	defer res.Body.Close()
	defer cancel()

	waitZeroHubSubscribers(t, &hub, 1)
}

func TestZeroValueHubServesConcurrentRequests(t *testing.T) {
	var hub SSEHub
	server := httptest.NewServer(&hub)
	defer closeZeroHubServer(t, server)

	type opened struct {
		body io.ReadCloser
		err  error
	}
	// the requests run together on purpose: the lazy creation of the subscriber
	// set happens under h.mu, and two arrivals must not each make their own
	results := make(chan opened, 2)
	for range 2 {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
			if err != nil {
				results <- opened{err: err}
				return
			}
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				results <- opened{err: err}
				return
			}
			opening := make([]byte, len(":ok\n\n"))
			if _, err := io.ReadFull(res.Body, opening); err != nil {
				res.Body.Close()
				results <- opened{err: err}
				return
			}
			results <- opened{body: res.Body}
			<-ctx.Done()
		}()
	}

	for i := range 2 {
		select {
		case got := <-results:
			if got.err != nil {
				t.Fatalf("concurrent request %d against a zero-value hub failed: %v", i, got.err)
			}
			defer got.body.Close()
		case <-time.After(20 * time.Second):
			t.Fatalf("concurrent request %d never opened its stream", i)
		}
	}
	waitZeroHubSubscribers(t, &hub, 2)
}

func TestZeroValueHubCloseAfterAServedRequest(t *testing.T) {
	var hub SSEHub
	server := httptest.NewServer(&hub)
	defer closeZeroHubServer(t, server)

	res, cancel := openZeroHubStream(t, server)
	defer cancel()
	waitZeroHubSubscribers(t, &hub, 1)

	ended := make(chan struct{})
	go func() {
		defer close(ended)
		defer res.Body.Close()
		io.Copy(io.Discard, res.Body)
	}()

	hubCall(t, "Close()", hub.Close)

	if got := zeroHubSubscribers(t, &hub); got != 0 {
		t.Fatalf("Subscribers() = %d right after Close on a zero-value hub, want 0", got)
	}
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the open stream never ended after Close on a zero-value hub")
	}
}

func TestZeroValueHubPublishAfterAServedRequest(t *testing.T) {
	var hub SSEHub
	server := httptest.NewServer(&hub)
	defer closeZeroHubServer(t, server)

	res, cancel := openZeroHubStream(t, server)
	defer res.Body.Close()
	defer cancel()
	waitZeroHubSubscribers(t, &hub, 1)

	hubCall(t, "Publish()", func() { hub.Publish("task-created", map[string]int{"id": 7}) })

	// and the event really reaches the client the zero-value hub registered:
	// the request's deadline bounds this read, so a lost frame is reported
	frames := make(chan []string, 1)
	go func() {
		scanner := bufio.NewScanner(res.Body)
		var lines []string
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" || strings.HasPrefix(line, ":") {
				continue
			}
			lines = append(lines, line)
			if len(lines) == 2 {
				break
			}
		}
		frames <- lines
	}()
	select {
	case lines := <-frames:
		if len(lines) != 2 || lines[0] != "event: task-created" || lines[1] != `data: {"id":7}` {
			t.Fatalf("a zero-value hub broadcast %q", lines)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the published event never reached the stream a zero-value hub was serving")
	}
}

func TestZeroValueHubSubscribersAfterAServedRequest(t *testing.T) {
	var hub SSEHub
	server := httptest.NewServer(&hub)
	defer closeZeroHubServer(t, server)

	res, cancel := openZeroHubStream(t, server)
	waitZeroHubSubscribers(t, &hub, 1)

	// and it drops back once the client goes: the count a zero-value hub keeps
	// is the same count NewSSEHub keeps
	res.Body.Close()
	cancel()
	waitZeroHubSubscribers(t, &hub, 0)
}

func TestZeroValueHubServesARequestArrivingAfterClose(t *testing.T) {
	var hub SSEHub
	hubCall(t, "Close()", hub.Close)

	server := httptest.NewServer(&hub)
	defer closeZeroHubServer(t, server)

	res, cancel := openZeroHubStream(t, server)
	defer cancel()

	ended := make(chan struct{})
	go func() {
		defer close(ended)
		defer res.Body.Close()
		io.Copy(io.Discard, res.Body)
	}()
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("a request to a closed zero-value hub hung instead of ending at once")
	}
	if got := zeroHubSubscribers(t, &hub); got != 0 {
		t.Fatalf("Subscribers() = %d on a closed zero-value hub", got)
	}
}

// The panic mattered less than what it left behind. Wrapped in the recover
// middleware every app has, the request turns into a 500 and the process looks
// healthy - while the hub's mutex is held for good and the next call on it
// never returns.
func TestZeroValueHubLeavesNoHeldMutexBehindARecoveredPanic(t *testing.T) {
	var hub SSEHub

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)

	served := make(chan any, 1)
	go func() {
		var recovered any
		func() {
			defer func() { recovered = recover() }()
			hub.ServeHTTP(httptest.NewRecorder(), req)
		}()
		served <- recovered
	}()

	waitZeroHubSubscribers(t, &hub, 1)
	cancel()

	select {
	case recovered := <-served:
		if recovered != nil {
			t.Fatalf("ServeHTTP panicked on a zero-value hub: %v", recovered)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ServeHTTP neither returned nor panicked out to the middleware; it is wedged on the hub's mutex")
	}

	// whatever happened in there, the hub is still usable
	if got := zeroHubSubscribers(t, &hub); got != 0 {
		t.Fatalf("Subscribers() = %d after the request ended, want 0", got)
	}
	hubCall(t, "Publish()", func() { hub.Publish("after", 1) })
	hubCall(t, "Close()", hub.Close)
}

// The hub's zero value was made safe above; its neighbour in the same file had
// the same disease. `var s SSEStream` reached Send or Ping and dereferenced a
// nil ResponseController, and Done handed back a nil channel - a handler
// selecting only on that parks for good, which is the worst way to fail
// because nothing crashes and nothing shows. A zero-value stream is a stream
// that never opened: it must refuse writes with an error that names SSE, and
// it must report itself finished rather than never finishing.
//
// Every test below starts from a zero value, never from SSE(), and every wait
// is bounded - a hang is indistinguishable from a slow machine and is not a
// verification.

// streamCall runs op on its own goroutine, so a call that panics takes the
// goroutine rather than the test binary, and a call that wedges on the
// stream's mutex fails the test instead of hanging it.
func streamCall(t *testing.T, what string, op func()) {
	t.Helper()
	outcome := make(chan any, 1)
	go func() {
		var recovered any
		func() {
			defer func() { recovered = recover() }()
			op()
		}()
		outcome <- recovered
	}()
	select {
	case recovered := <-outcome:
		if recovered != nil {
			t.Fatalf("%s panicked on a zero-value SSEStream: %v", what, recovered)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("%s never returned on a zero-value SSEStream: its mutex is held", what)
	}
}

// each subtest makes its call the very first one on its own zero value: the
// first call is the one that used to panic
func TestZeroValueSSEStreamRefusesToWrite(t *testing.T) {
	t.Run("Send", func(t *testing.T) {
		var s SSEStream
		var err error
		streamCall(t, "Send()", func() { err = s.Send("greet", map[string]string{"msg": "ciao"}) })
		if err == nil {
			t.Fatal("Send() reported success on a stream that has nowhere to write")
		}
		if !strings.Contains(err.Error(), "SSE") {
			t.Errorf("Send() error %q does not tell the caller to go through SSE()", err)
		}
	})
	t.Run("Ping", func(t *testing.T) {
		var s SSEStream
		var err error
		streamCall(t, "Ping()", func() { err = s.Ping() })
		if err == nil {
			t.Fatal("Ping() reported success on a stream that has nowhere to write")
		}
	})
	t.Run("write", func(t *testing.T) {
		var s SSEStream
		var err error
		streamCall(t, "write()", func() { err = s.write(pingFrame) })
		if err == nil {
			t.Fatal("write() reported success on a stream that has nowhere to write")
		}
	})
	t.Run("Done", func(t *testing.T) {
		var s SSEStream
		var done <-chan struct{}
		streamCall(t, "Done()", func() { done = s.Done() })
		if done == nil {
			t.Fatal("Done() returned nil on a zero-value stream: a handler selecting on it parks for good")
		}
	})
}

// the nil channel a zero value used to return is not a crash, it is a handler
// that never comes back; the timer is what tells the two apart
func TestZeroValueSSEStreamDoneNeverParksItsHandler(t *testing.T) {
	var s SSEStream
	select {
	case <-s.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("a handler selecting on a zero-value stream's Done() waited for a channel nothing will ever close")
	}
	// and it stays that way: a second reader gets the same answer
	select {
	case <-s.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("Done() fired once and then parked the next caller")
	}
}

// a still write is one thing; the mutex under -race with several callers is
// another, and the hub's bug was a held mutex, not the panic that caused it
func TestZeroValueSSEStreamUnderConcurrentCalls(t *testing.T) {
	var s SSEStream

	panics := make(chan any, 32)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					panics <- r
				}
			}()
			for range 25 {
				_ = s.Send("tick", 1)
				_ = s.Ping()
				_ = s.write(pingFrame)
				_ = s.Done()
			}
		}()
	}

	finished := make(chan struct{})
	go func() {
		wg.Wait()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(10 * time.Second):
		t.Fatal("concurrent calls on a zero-value stream never all returned: the stream's mutex is held")
	}
	select {
	case r := <-panics:
		t.Fatalf("a concurrent call on a zero-value stream panicked: %v", r)
	default:
	}
}

// a zero value is not only `var s SSEStream`: it is any field or element
// nobody assigned, and those are the ones that arrive by accident
func TestZeroValueSSEStreamInsideAStructAndASlice(t *testing.T) {
	var holder struct {
		name   string
		stream SSEStream
	}
	streamCall(t, "Send() on a struct field", func() {
		if err := holder.stream.Send("greet", 1); err == nil {
			t.Error("Send() on a zero-value struct field reported success")
		}
	})
	select {
	case <-holder.stream.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("Done() on a zero-value struct field parks its handler")
	}

	streams := make([]SSEStream, 3)
	for i := range streams {
		streamCall(t, "Ping() on a slice element", func() {
			if err := streams[i].Ping(); err == nil {
				t.Errorf("Ping() on zero-value element %d reported success", i)
			}
		})
		select {
		case <-streams[i].Done():
		case <-time.After(2 * time.Second):
			t.Fatalf("Done() on zero-value element %d parks its handler", i)
		}
	}
}

// Every stream started a watcher goroutine that sat on the request context and
// the server's shutdown latch. When neither exists - a handler called with a
// background-context request and no server behind it, which is how a test or a
// non-net/http mount reaches it - that watcher waited on two nil channels, and
// nothing would ever wake it. The suite parks a thousand of them in one test.
// A stream must leave no goroutine behind once its life is over, including
// when its request cannot be cancelled at all.

// streamGoroutineBaseline is a baseline taken once the goroutines of earlier tests
// have finished unwinding: the count has to hold still before it means
// anything.
func streamGoroutineBaseline(t *testing.T) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	last, stable := -1, 0
	for {
		n := runtime.NumGoroutine()
		if n == last {
			if stable++; stable == 5 {
				return n
			}
		} else {
			last, stable = n, 0
		}
		select {
		case <-ctx.Done():
			t.Logf("goroutine count never settled; taking %d as the baseline", n)
			return n
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// goroutineTolerance covers the handful of goroutines this package's earlier
// tests can still be retiring in the background - idle transport connections,
// the race detector's own. It is small on purpose: the leak under test is one
// goroutine per stream, so it shows up as hundreds, never as a few.
const goroutineTolerance = 8

// waitGoroutinesBackTo fails saying how many are left, rather than timing out
// in silence.
func waitGoroutinesBackTo(t *testing.T, baseline int, what string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		n := runtime.NumGoroutine()
		if n <= baseline+goroutineTolerance {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("%s: %d goroutines still running, baseline was %d (tolerance %d) - %d left behind",
				what, n, baseline, goroutineTolerance, n-baseline)
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func TestSSEStreamLeavesNoGoroutineOnAnUncancellableRequest(t *testing.T) {
	const streams = 200
	baseline := streamGoroutineBaseline(t)

	for range streams {
		// httptest.NewRequest carries a background context and no server, so
		// neither of the two signals a stream watches can ever fire
		req := httptest.NewRequest(http.MethodGet, "/api/events", nil)
		if req.Context().Done() != nil {
			t.Fatal("this test needs a request that cannot be cancelled")
		}
		if _, err := SSE(httptest.NewRecorder(), req); err != nil {
			t.Fatal(err)
		}
	}

	waitGoroutinesBackTo(t, baseline, "after opening 200 streams on uncancellable requests")
}

// and when the request can be cancelled but never is, the stream's own end is
// enough: the watcher must go when the stream goes, not when the client
// eventually happens to disconnect
func TestSSEStreamWatcherEndsWithTheStream(t *testing.T) {
	const streams = 200
	baseline := streamGoroutineBaseline(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel() // never fires during the test: the streams end themselves
	for range streams {
		req := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)
		stream, err := SSE(httptest.NewRecorder(), req)
		if err != nil {
			t.Fatal(err)
		}
		stream.end()
	}

	waitGoroutinesBackTo(t, baseline, "after ending 200 streams whose requests were never cancelled")
}

// the hub is the handler most streams go through, so it must end the stream it
// opened however its loop returns
func TestSSEHubEndsTheStreamItOpened(t *testing.T) {
	baseline := streamGoroutineBaseline(t)

	hub := NewSSEHub()
	hub.Close() // so ServeHTTP returns on its first select

	// the requests are cancellable and are never cancelled, so each one really
	// does start a watcher: what has to release it is the handler returning
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for range 200 {
		req := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)
		hub.ServeHTTP(httptest.NewRecorder(), req)
	}

	waitGoroutinesBackTo(t, baseline, "after 200 hub requests that ended at once")
}

// streamDeadline is how long every wait below is allowed to take. It is not a
// performance budget: each of these fires in microseconds when it fires at
// all, and the whole point is telling "did not happen" from "was slow".
const streamDeadline = 10 * time.Second

// waitStreamEnd fails saying what was still open, instead of timing out mute.
func waitStreamEnd(t *testing.T, done <-chan struct{}, what string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), streamDeadline)
	defer cancel()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatalf("%s: still open %v later, so the handler waiting on Done() is parked there for good", what, streamDeadline)
	}
}

// assertStillOpen is the other half: the streams below have to be unreachable
// before Close is what reaches them.
func assertStillOpen(t *testing.T, done <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-done:
		t.Fatalf("%s: the stream ended on its own, so this test is no longer about Close", what)
	case <-time.After(300 * time.Millisecond):
	}
}

// openedStream is a stream on a recorder: opened by SSE, with no server and no
// cancellable request behind it, which is all the in-process cases below need.
func openedStream(t *testing.T) (*SSEStream, *httptest.ResponseRecorder) {
	t.Helper()
	w := httptest.NewRecorder()
	s, err := SSE(w, httptest.NewRequest(http.MethodGet, "/api/events", nil))
	if err != nil {
		t.Fatalf("opening a stream: %v", err)
	}
	return s, w
}

// closeStream calls Close on its own goroutine: Close that blocks - on the
// write mutex, say - is a failure with a message, not a hung test.
func closeStream(t *testing.T, s *SSEStream, what string) {
	t.Helper()
	returned := make(chan any, 1)
	go func() {
		var recovered any
		func() {
			defer func() { recovered = recover() }()
			s.Close()
		}()
		returned <- recovered
	}()
	ctx, cancel := context.WithTimeout(context.Background(), streamDeadline)
	defer cancel()
	select {
	case recovered := <-returned:
		if recovered != nil {
			t.Fatalf("Close() %s panicked: %v", what, recovered)
		}
	case <-ctx.Done():
		t.Fatalf("Close() %s never returned within %v", what, streamDeadline)
	}
}

// An app that mounts borgo's handlers on its own server is told, by
// Middleware's own doc comment, to write exactly the server below and that it
// "gets the same guarantees borgo's own server has". Its streams were not
// among them: nothing armed a latch for a server borgo did not start, so
// Shutdown had no way to end a stream and waited on it for the whole of its
// context. borgo's own server escaped only because it follows the grace period
// with Close.
func TestShutdownEndsStreamsOnAServerTheAppStarted(t *testing.T) {
	handlerReturned := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("/api/events", func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerReturned)
		pingStream(w, r)
	})
	// verbatim the disposition Middleware documents
	srv := &http.Server{Handler: Middleware(mux)}
	base := serveOn(t, srv)
	// the stream is alive and unclosable until then: Close is what releases the
	// connection when Shutdown could not
	defer srv.Close()

	// the response reaching the client means SSE has written and flushed its
	// opening comment, so the handler is inside the stream by now
	ended := readingStream(t, base+"/api/events")

	ctx, cancel := context.WithTimeout(context.Background(), streamDeadline)
	defer cancel()
	start := time.Now()
	if err := srv.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown gave up after %v (%v): it was waiting on an event stream it had no way to end", time.Since(start), err)
	}
	waitStreamEnd(t, ended, "the client's side of the stream after Shutdown returned")
	waitStreamEnd(t, handlerReturned, "the handler after Shutdown returned")
}

// and a server the app starts must not lose the streams of a server borgo
// starts, or the other way round: the latch is per server, whichever of the
// two armed it.
func TestAnAppServersShutdownLeavesAnotherServersStreamsAlone(t *testing.T) {
	mine := &http.Server{Handler: http.HandlerFunc(pingStream)}
	other := &http.Server{Handler: http.HandlerFunc(pingStream)}
	base := serveOn(t, mine)
	otherBase := serveOn(t, other)
	defer mine.Close()
	defer other.Close()

	ours := readingStream(t, base)
	theirs := readingStream(t, otherBase)

	ctx, cancel := context.WithTimeout(context.Background(), streamDeadline)
	defer cancel()
	if err := srvShutdown(ctx, mine); err != nil {
		t.Fatalf("shutting the first server down: %v", err)
	}
	waitStreamEnd(t, ours, "the stream of the server that shut down")
	assertStillOpen(t, theirs, "the stream of the server that is still serving")
}

func srvShutdown(ctx context.Context, srv *http.Server) error { return srv.Shutdown(ctx) }

// The two ways a server gets a latch have to meet on one latch. A stream arms
// one lazily the moment it opens; serveContext arms the same server before it
// binds. When the stream got there first, the arming that follows must adopt
// what is already there - a second latch would leave the live stream watching
// one nobody will ever trip, which is the failure this file's own comment
// describes with the roles reversed.
func TestArmingAServerAStreamAlreadyArmedKeepsTheOneLatch(t *testing.T) {
	srv := &http.Server{Handler: http.HandlerFunc(pingStream)}
	base := serveOn(t, srv)
	defer srv.Close()

	ended := readingStream(t, base)
	watched := latchOf(t, srv)

	// verbatim what serveContext does, on a server a stream already armed
	disarm := armStreamShutdown(srv)
	if latchOf(t, srv) != watched {
		t.Fatal("arming the server replaced the latch its open stream is watching, so nothing that trips the new one can reach that stream")
	}
	assertStillOpen(t, watched, "the latch before anything tripped it")

	disarm()
	waitStreamEnd(t, watched, "the latch after the run that armed it ended")
	waitStreamEnd(t, ended, "the stream that armed the latch first")
}

// A handler that detaches the request context - to go on working after the
// response, which is what context.WithoutCancel and r.Clone(context.Background())
// are for - got a stream that nothing could end: the client's disconnection is
// gone with the cancellation, and Clone drops the context values, so the
// server's shutdown latch is unreachable too. Close is the only thing that can
// reach such a stream, which is why it is exported.
func TestCloseEndsAStreamNothingElseCanReach(t *testing.T) {
	streams := make(chan *SSEStream, 1)
	handlerReturned := make(chan struct{})
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerReturned)
		// keeps the response writer, drops the cancellation and the values -
		// http.ServerContextKey with them
		detached := r.Clone(context.Background())
		stream, err := SSE(w, detached)
		if err != nil {
			return
		}
		streams <- stream
		select {
		case <-stream.Done():
		case <-time.After(2 * streamDeadline):
			// the test has already failed by now; this only keeps a red run
			// from leaving a goroutine parked in every later test
		}
	})}
	base := serveOn(t, srv)
	defer srv.Close()

	res, err := http.Get(base)
	if err != nil {
		t.Fatalf("opening the stream: %v", err)
	}
	var stream *SSEStream
	select {
	case stream = <-streams:
	case <-time.After(streamDeadline):
		res.Body.Close()
		t.Fatal("the handler never reached its stream")
	}

	// the client goes: on a detached context nothing hears it
	res.Body.Close()
	assertStillOpen(t, stream.Done(), "a stream on a detached context after the client disconnected")

	// and neither does the server's own shutdown, since the clone kept no way
	// of naming the server
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	assertStillOpen(t, stream.Done(), "a stream on a detached context after Shutdown")

	closeStream(t, stream, "on a stream nothing else can reach")
	waitStreamEnd(t, stream.Done(), "the stream after Close")
	waitStreamEnd(t, handlerReturned, "the handler after Close")
}

func TestSSEStreamClose(t *testing.T) {
	t.Run("twice", func(t *testing.T) {
		s, _ := openedStream(t)
		closeStream(t, s, "the first time")
		closeStream(t, s, "the second time")
		waitStreamEnd(t, s.Done(), "the stream after two Closes")
	})

	t.Run("from two goroutines at once", func(t *testing.T) {
		s, _ := openedStream(t)
		var wg sync.WaitGroup
		start := make(chan struct{})
		panics := make(chan any, 8)
		for range 8 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() {
					if r := recover(); r != nil {
						panics <- r
					}
				}()
				<-start
				s.Close()
				_ = s.Send("tick", 1)
				_ = s.Done()
			}()
		}
		close(start)
		finished := make(chan struct{})
		go func() { wg.Wait(); close(finished) }()
		select {
		case <-finished:
		case <-time.After(streamDeadline):
			t.Fatal("eight concurrent Close/Send callers never all returned: the stream is holding its mutex")
		}
		select {
		case r := <-panics:
			t.Fatalf("a concurrent Close panicked: %v", r)
		default:
		}
		waitStreamEnd(t, s.Done(), "the stream after eight concurrent Closes")
	})

	t.Run("on a zero value", func(t *testing.T) {
		var s SSEStream
		closeStream(t, &s, "on a zero value")
		closeStream(t, &s, "on a zero value, again")
		waitStreamEnd(t, s.Done(), "a zero-value stream after Close")
		// it never opened, and that is what it keeps saying: the caller is told
		// to go through SSE, not that it closed something
		if err := s.Send("tick", 1); !errors.Is(err, errStreamNotOpen) {
			t.Errorf("Send() after Close on a zero value = %v, want the not-opened refusal", err)
		}
	})

	t.Run("before any Send", func(t *testing.T) {
		s, w := openedStream(t)
		opening := w.Body.Len()
		closeStream(t, s, "before anything was sent")
		if err := s.Send("tick", 1); !errors.Is(err, ErrStreamClosed) {
			t.Fatalf("Send() after Close = %v, want %v", err, ErrStreamClosed)
		}
		// and the same one every time, whichever call notices
		if err := s.Send("tick", 2); !errors.Is(err, ErrStreamClosed) {
			t.Errorf("the second Send() after Close = %v, want %v", err, ErrStreamClosed)
		}
		if err := s.Ping(); !errors.Is(err, ErrStreamClosed) {
			t.Errorf("Ping() after Close = %v, want %v", err, ErrStreamClosed)
		}
		if n := w.Body.Len(); n != opening {
			t.Errorf("%d bytes reached the client after Close; the refusals are not refusals", n-opening)
		}
	})

	t.Run("while a Send is in flight", func(t *testing.T) {
		w := &gatedWriter{ResponseRecorder: httptest.NewRecorder(), entered: make(chan struct{}), gate: make(chan struct{})}
		s, err := SSE(w, httptest.NewRequest(http.MethodGet, "/api/events", nil))
		if err != nil {
			t.Fatalf("opening a stream: %v", err)
		}
		w.armed.Store(true)

		sent := make(chan error, 1)
		go func() { sent <- s.Send("slow", 1) }()
		select {
		case <-w.entered:
		case <-time.After(streamDeadline):
			t.Fatal("the write never started, so nothing was in flight to close against")
		}

		// Close must not queue behind a write that owns the connection: a
		// blackholed client holds it for the whole write timeout
		closeStream(t, s, "while a write was in flight")
		waitStreamEnd(t, s.Done(), "the stream after Close during a write")

		close(w.gate)
		select {
		case <-sent:
			// whether the in-flight frame lands or fails is the connection's
			// business; what matters is that it returned
		case <-time.After(streamDeadline):
			t.Fatal("the in-flight Send never returned after its write was released")
		}
		if err := s.Send("after", 1); !errors.Is(err, ErrStreamClosed) {
			t.Errorf("Send() after the in-flight one = %v, want %v", err, ErrStreamClosed)
		}
	})

	t.Run("after the client is gone", func(t *testing.T) {
		s, done := servedStream(t)
		done()
		waitStreamEnd(t, s.Done(), "the stream after its client disconnected")
		// the disconnection already fired the latch: Close must find it fired
		// and say nothing, not close a closed channel
		closeStream(t, s, "after the client had gone")
		if err := s.Send("tick", 1); !errors.Is(err, ErrStreamClosed) {
			t.Errorf("Send() after Close on a disconnected stream = %v, want %v", err, ErrStreamClosed)
		}
	})

	t.Run("after Shutdown", func(t *testing.T) {
		s, _ := servedStream(t)
		ctx, cancel := context.WithTimeout(context.Background(), streamDeadline)
		defer cancel()
		if err := srvShutdown(ctx, s.r.Context().Value(http.ServerContextKey).(*http.Server)); err != nil {
			t.Fatalf("shutting the server down: %v", err)
		}
		waitStreamEnd(t, s.Done(), "the stream after Shutdown")
		closeStream(t, s, "after Shutdown")
		if err := s.Send("tick", 1); !errors.Is(err, ErrStreamClosed) {
			t.Errorf("Send() after Close on a shut-down stream = %v, want %v", err, ErrStreamClosed)
		}
	})

	t.Run("on a copy", func(t *testing.T) {
		s, _ := openedStream(t)
		dup := copyOfStream(s)
		// the copy is the same stream by every observable measure
		if dup.Done() != s.Done() {
			t.Fatal("the copy does not share the original's Done channel, so this is not the copy the defect is about")
		}
		closeStream(t, s, "on the original")
		closeStream(t, dup, "on the copy of an already-closed stream")
		waitStreamEnd(t, dup.Done(), "the copy after both were closed")
		if err := dup.Send("tick", 1); !errors.Is(err, ErrStreamClosed) {
			t.Errorf("Send() on a closed stream's copy = %v, want %v", err, ErrStreamClosed)
		}
		// and in the other order, on a fresh pair
		other, _ := openedStream(t)
		otherDup := copyOfStream(other)
		closeStream(t, otherDup, "on the copy first")
		closeStream(t, other, "on the original of an already-closed copy")
	})

	t.Run("Done before and after", func(t *testing.T) {
		s, _ := openedStream(t)
		before := s.Done()
		select {
		case <-before:
			t.Fatal("Done() was already closed on a stream nobody had closed")
		default:
		}
		closeStream(t, s, "between the two reads of Done()")
		waitStreamEnd(t, before, "the channel Done() handed out before Close")
		waitStreamEnd(t, s.Done(), "the channel Done() hands out after Close")
		if s.Done() != before {
			t.Error("Done() handed out a different channel after Close: a handler holding the first one would never hear")
		}
	})
}

// countLatches is the whole proof below: one entry pins nothing now, but it
// used to pin an *http.Server and every closure its handler graph reaches.
func countLatches() int {
	n := 0
	streamLatches.m.Range(func(_, _ any) bool { n++; return true })
	return n
}

// latchBaseline settles the map before a test counts against it: entries other
// tests left behind go on being collected while this one runs, and the counts
// have to be taken from the same side of that.
func latchBaseline(t *testing.T) int {
	t.Helper()
	runtime.GC()
	runtime.GC()
	return countLatches()
}

// waitLatchesDropTo drives the collector until the map is back to want. The
// removal is the collector's work, so this polls instead of asserting once -
// but it fails with the count, because "some entries survived their servers"
// is the finding and the number is how bad it is.
func waitLatchesDropTo(t *testing.T, want int, what string) {
	t.Helper()
	deadline := time.Now().Add(streamDeadline)
	for {
		runtime.GC()
		n := countLatches()
		if n <= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: %d latch entries still held after %v, want %d - %d server(s) and every closure their handlers reach cannot be collected", what, n, streamDeadline, want, n-want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// oneStreamServer runs one event stream on a fresh server, ends it the way stop
// says, and returns holding no reference to that server - so whatever the map
// still has afterwards has outlived the thing it was about. None of the ways
// the callers stop it is Shutdown, and that is the point: an entry that is only
// removed by an event the app may never produce is the defect, not the fix.
func oneStreamServer(t *testing.T, stop func(srv *http.Server, ln net.Listener)) {
	t.Helper()
	srv := &http.Server{Handler: http.HandlerFunc(pingStream)}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	served := make(chan struct{})
	go func() { defer close(served); srv.Serve(ln) }()

	res, err := http.Get("http://" + ln.Addr().String())
	if err != nil {
		t.Fatalf("opening a stream: %v", err)
	}
	if _, armed := streamLatches.Load(srv); !armed {
		res.Body.Close()
		t.Fatal("no latch was armed, so this test is not about removing one")
	}
	// the client goes first, so the handler is out before the server is
	res.Body.Close()
	stop(srv, ln)
	// the Serve goroutine holds the server: nothing can be collected until it
	// has returned, and a test that skipped this would be timing its own
	// scheduler rather than the map
	<-served
	http.DefaultClient.CloseIdleConnections()
}

// The latch map used to be keyed by the server itself, so it held one alive for
// every server that had ever served a stream. Only borgo's own servers escaped,
// because serveContext defers a disarm that runs on every path; lazy arming
// then handed the same fate to every net/http server an app writes. Nothing
// below ever calls Shutdown - the one event that used to remove an entry.
func TestLatchEntriesDoNotOutliveTheirServers(t *testing.T) {
	t.Run("a server stopped with Close", func(t *testing.T) {
		base := latchBaseline(t)
		oneStreamServer(t, func(srv *http.Server, _ net.Listener) { srv.Close() })
		waitLatchesDropTo(t, base, "a server stopped with Close and never Shutdown")
	})

	t.Run("a server that is never stopped at all", func(t *testing.T) {
		base := latchBaseline(t)
		// neither Shutdown nor Close: the listener goes and the app lets the
		// server fall out of use, which no hook of ours will ever hear about
		oneStreamServer(t, func(_ *http.Server, ln net.Listener) { ln.Close() })
		waitLatchesDropTo(t, base, "a server dropped without ever being stopped")
	})

	t.Run("many servers with one stream each", func(t *testing.T) {
		base := latchBaseline(t)
		for range 8 {
			oneStreamServer(t, func(srv *http.Server, _ net.Listener) { srv.Close() })
		}
		waitLatchesDropTo(t, base, "eight servers with one stream each")
	})
}

// The counting design this fix rejected would have dropped the entry whenever
// the last stream left and rebuilt it for the next one. Rebuilding means
// another RegisterOnShutdown, and http.Server.onShutdown only ever grows -
// net/http has no way to remove a hook. A browser's EventSource reconnects for
// as long as the page is open, so that list would grow once per reconnection
// for the life of the process. The latch staying the same object across
// reconnections is how this test sees that it did not happen.
func TestReconnectingStreamsKeepOneLatchOnOneServer(t *testing.T) {
	srv := &http.Server{Handler: http.HandlerFunc(pingStream)}
	base := serveOn(t, srv)
	defer srv.Close()

	res, err := http.Get(base)
	if err != nil {
		t.Fatalf("opening the first stream: %v", err)
	}
	res.Body.Close()
	first := latchOf(t, srv)
	entries := countLatches()

	for i := range 50 {
		res, err := http.Get(base)
		if err != nil {
			t.Fatalf("reconnection %d: %v", i, err)
		}
		res.Body.Close()
		if got := latchOf(t, srv); got != first {
			t.Fatalf("reconnection %d was handed a different latch: the entry was dropped and rebuilt, and every rebuild appends an OnShutdown hook that this server can never drop", i)
		}
	}
	if n := countLatches(); n != entries {
		t.Errorf("51 streams on one server left %d latch entries, want the %d it started with", n, entries)
	}

	// and the one latch every reconnection shared is still the live one
	ctx, cancel := context.WithTimeout(context.Background(), streamDeadline)
	defer cancel()
	if err := srvShutdown(ctx, srv); err != nil {
		t.Fatalf("shutting down after 51 streams: %v", err)
	}
	waitStreamEnd(t, first, "the one latch, after Shutdown")
}

// The case that matters most: a stream arriving exactly as the last one leaves.
// Under a scheme that removed the entry when the count reached zero, this is
// where a new stream either revives an entry the departing one is still
// deleting, or takes a latch that is on its way out and watches a channel the
// server's Shutdown no longer knows about. Holding the entry for the server's
// whole life removes the transition rather than guarding it, and this is what
// says so: one latch throughout, and the last stream opened still ends.
func TestAStreamArrivingAsTheLastLeavesSharesTheOneLatch(t *testing.T) {
	srv := &http.Server{Handler: http.HandlerFunc(pingStream)}
	base := serveOn(t, srv)
	defer srv.Close()

	res, err := http.Get(base)
	if err != nil {
		t.Fatalf("opening the first stream: %v", err)
	}
	res.Body.Close()
	watched := latchOf(t, srv)
	entries := countLatches()

	// sixteen callers opening and closing at once: the number of live streams
	// crosses zero constantly, which is the moment in question
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 10 {
				res, err := http.Get(base)
				if err != nil {
					return
				}
				res.Body.Close()
			}
		}()
	}
	wg.Wait()

	if got := latchOf(t, srv); got != watched {
		t.Fatal("the server's latch was replaced while streams were coming and going: whichever streams took the old one are watching a channel Shutdown will not trip")
	}
	if n := countLatches(); n != entries {
		t.Errorf("streams crossing zero left %d latch entries for one server, want %d", n, entries)
	}

	// the stream opened last must still be reachable by the server's shutdown
	ended := readingStream(t, base)
	ctx, cancel := context.WithTimeout(context.Background(), streamDeadline)
	defer cancel()
	if err := srvShutdown(ctx, srv); err != nil {
		t.Fatalf("shutting down: %v", err)
	}
	waitStreamEnd(t, ended, "the stream opened after all that coming and going")
}

// servedStream opens a stream through a real server and hands the test the
// stream itself, so it can be closed from outside its handler. The returned
// func disconnects the client. httptest.Server is no use here: its Close waits
// for every connection to go idle, and an open event stream never does.
func servedStream(t *testing.T) (*SSEStream, func()) {
	t.Helper()
	streams := make(chan *SSEStream, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stream, err := SSE(w, r)
		if err != nil {
			return
		}
		streams <- stream
		<-stream.Done()
	})}
	base := serveOn(t, srv)
	t.Cleanup(func() { srv.Close() })

	res, err := http.Get(base)
	if err != nil {
		t.Fatalf("opening a served stream: %v", err)
	}
	disconnect := sync.OnceFunc(func() { res.Body.Close() })
	t.Cleanup(disconnect)
	select {
	case s := <-streams:
		return s, disconnect
	case <-time.After(streamDeadline):
		t.Fatal("the handler never reached its stream")
		return nil, disconnect
	}
}

// gatedWriter holds the first write that follows arming, so a test can call
// Close while a write really is in flight. The opening comment SSE writes must
// go through untouched, or the stream would never open.
type gatedWriter struct {
	*httptest.ResponseRecorder
	armed   atomic.Bool
	entered chan struct{}
	gate    chan struct{}
	once    sync.Once
}

func (g *gatedWriter) Write(p []byte) (int, error) {
	if g.armed.Load() {
		g.once.Do(func() { close(g.entered) })
		<-g.gate
	}
	return g.ResponseRecorder.Write(p)
}

// copyOfStream is the copy go vet's copylocks refuses to let anyone write -
// `dup := *stream` does not compile past the gate, and that refusal is the
// defence. This is what the caller who ignores it ends up holding: same
// connection, same channel, its own mutex. Ending both used to be a `close of
// closed channel` panic in whichever goroutine got there second.
func copyOfStream(s *SSEStream) *SSEStream {
	dup := new(SSEStream)
	reflect.ValueOf(dup).Elem().Set(reflect.ValueOf(s).Elem())
	return dup
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
