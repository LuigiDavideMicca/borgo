package borgo

import (
	"bufio"
	"context"
	"errors"
	"fmt"
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

// Bun.serve, the front server proxying this response, holds the header block
// until the body starts: SSE must put bytes on the wire, not merely flush
func TestSSEOpensWithBytesBeforeAnyEvent(t *testing.T) {
	w := httptest.NewRecorder()
	if _, err := SSE(w, httptest.NewRequest(http.MethodGet, "/events", nil)); err != nil {
		t.Fatal(err)
	}
	opening := w.Body.String()
	if opening == "" {
		t.Fatal("SSE wrote no body before the first event; a proxy may hold the headers until one arrives")
	}
	// only a comment can precede the app's own events
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

// subscriptions are opened through ServeHTTP, the way an app's are: writing
// hub.subs directly cannot notice a missing constructor

// a client that stops taking bytes on demand. The wedge is taken before the
// mutex, so reading what arrived during a held write is not a race
type slowClient struct {
	header  http.Header
	mu      sync.Mutex
	body    strings.Builder
	wedged  atomic.Bool
	once    sync.Once
	entered chan struct{}
	gate    chan struct{}
}

func newSlowClient() *slowClient {
	return &slowClient{header: http.Header{}, entered: make(chan struct{}), gate: make(chan struct{})}
}

func (c *slowClient) Header() http.Header { return c.header }
func (c *slowClient) WriteHeader(int)     {}
func (c *slowClient) Flush()              {}

func (c *slowClient) Write(p []byte) (int, error) {
	if c.wedged.Load() {
		c.once.Do(func() { close(c.entered) })
		<-c.gate
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.body.Write(p)
}

func (c *slowClient) received() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.body.String()
}

func eventNames(body string) []string {
	var names []string
	for _, line := range strings.Split(body, "\n") {
		if name, ok := strings.CutPrefix(line, "event: "); ok {
			names = append(names, name)
		}
	}
	return names
}

// fails rather than hangs: a hang is indistinguishable from a slow machine
func publishNow(t *testing.T, hub *SSEHub, event string, data any) {
	t.Helper()
	done := make(chan struct{})
	go func() { defer close(done); hub.Publish(event, data) }()
	select {
	case <-done:
	case <-time.After(streamDeadline):
		t.Fatalf("Publish(%q) blocked on a client that was not keeping up", event)
	}
}

func TestHubSkipsSlowClients(t *testing.T) {
	hub := NewSSEHub()
	client := newSlowClient()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	served := make(chan struct{})
	go func() {
		defer close(served)
		hub.ServeHTTP(client, httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx))
	}()
	waitSubscribers(t, hub, 1)

	// the first event is pulled out and wedged inside the write, so the buffer
	// behind it is empty and everything published after this queues from a
	// known state
	client.wedged.Store(true)
	publishNow(t, hub, "e0", 0)
	select {
	case <-client.entered:
	case <-time.After(streamDeadline):
		t.Fatal("the handler never reached a write, so no client is wedged and nothing is queueing behind one")
	}

	// far more than any buffer the hub could keep, without naming the capacity
	const flood = 64
	for i := 1; i <= flood; i++ {
		publishNow(t, hub, fmt.Sprintf("e%d", i), i)
	}

	// the subscription is a queue: "last" arriving proves everything kept before
	// it was already written
	close(client.gate)
	deadline := time.Now().Add(streamDeadline)
	for !strings.Contains(client.received(), "event: last\n") {
		if time.Now().After(deadline) {
			t.Fatalf("nothing more reached the client after it started reading again; it got %q", eventNames(client.received()))
		}
		publishNow(t, hub, "last", 1)
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case <-served:
	case <-time.After(streamDeadline):
		t.Fatal("the hub handler never returned")
	}

	kept := eventNames(client.received())
	for i, name := range kept {
		if name == "last" {
			kept = kept[:i]
			break
		}
	}
	if len(kept) == 0 {
		t.Fatal("nothing at all reached a client that was only wedged for a moment")
	}
	// skipped, not reordered, and never the ones already queued
	for i, name := range kept {
		if want := fmt.Sprintf("e%d", i); name != want {
			t.Fatalf("the client received %q; want the events published, in order, from e0", kept)
		}
	}
	if len(kept) > flood {
		t.Fatalf("all %d events reached a client that took none of them: nothing was skipped", len(kept))
	}
}

// the subscriber is a real request through ServeHTTP: what is asserted is what
// a client is sent
func TestHubDropsUnpublishableEvents(t *testing.T) {
	hub := NewSSEHub()
	server := httptest.NewServer(hub)
	// an open stream never goes idle, so Close alone would wait out a failure
	defer func() {
		server.CloseClientConnections()
		server.Close()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*streamDeadline)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatalf("building the request: %v", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("opening the stream: %v", err)
	}
	defer res.Body.Close()
	waitSubscribers(t, hub, 1)

	hub.Publish("broken", make(chan int))
	hub.Publish("multi\nline", 1)
	hub.Publish("fine", 1)

	// had either refused payload travelled, the first framing lines would not be
	// the valid event
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
		if len(lines) != 2 || lines[0] != "event: fine" || lines[1] != "data: 1" {
			t.Fatalf("the first frames to reach the client were %q; only the event that encodes may be broadcast", lines)
		}
	case <-time.After(streamDeadline):
		t.Fatal("the valid event never reached the client that the refused ones were published to")
	}

	// one bad Publish must not disconnect anybody
	if got := hub.Subscribers(); got != 1 {
		t.Fatalf("hub has %d subscribers after two refused publishes, want the 1 that is still connected", got)
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

	// read through Subscribers(), which is all an app has. The wait is generous:
	// 128 handlers must get scheduled to return while four publishers spin; idle
	// it settles in milliseconds, at 2x oversubscription one slot was still there
	// 5s in. It polls to the end and reports the count
	const unsubscribed = 30 * time.Second
	deadline := time.Now().Add(unsubscribed)
	for {
		n := hub.Subscribers()
		if n == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d subscriptions leaked %v after every client disconnected", n, unsubscribed)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

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

func TestHubSubscribers(t *testing.T) {
	hub := NewSSEHub()
	server := httptest.NewServer(hub)
	// cut the connections first, so a failure reports its assertion rather than
	// hanging in Close
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

	hub.mu.Lock()
	n := len(hub.subs)
	hub.mu.Unlock()
	if n != hub.Subscribers() {
		t.Fatalf("Subscribers() = %d, map holds %d", hub.Subscribers(), n)
	}
}

func TestHubCloseEndsEveryStream(t *testing.T) {
	hub := NewSSEHub()
	server := httptest.NewServer(hub)
	// httptest's Close waits for outstanding requests: a hub that fails to end
	// its streams would wedge here
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

// a ServeHTTP arriving after Close must not register for the microsecond
// before its first select: the count on a closed hub is a guarantee, not a sample
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

// the count and the close have to live inside the hub's one mutex: every
// combination at once, under -race
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

// nothing stops `var hub SSEHub`. ServeHTTP once wrote to a nil map and panicked
// with h.mu held under a bare unlock, so every later call blocked on a hub that
// looked alive. Every test here starts from a zero value, with every wait bounded

// on its own goroutine, so a held mutex fails the test instead of stopping it
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

// stands in for `defer server.Close()`: httptest waits for outstanding
// requests, and a handler wedged on the hub's mutex never finishes one
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

// one real request on a socket, with the opening comment consumed so the
// subscription is live on return. The deadline makes every read fail loudly
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
	// together on purpose: two arrivals must not each make their own subscriber set
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

	// the count a zero-value hub keeps is the count NewSSEHub keeps
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

// under the recover middleware the panic is a 500 and the process looks
// healthy, while the hub's mutex is held for good
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

// `var s SSEStream` once dereferenced a nil ResponseController in Send and Ping,
// and Done handed back a nil channel: a handler selecting on it parks for good.
// Every test below starts from a zero value, with every wait bounded

// on its own goroutine: a panic takes the goroutine, a wedge fails the test
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

// each subtest makes its call the very first one on its own zero value
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
	// write() gets no subtest of its own: covered through Send and Ping, the
	// surface an app can reach
	t.Run("Done", func(t *testing.T) {
		var s SSEStream
		var done <-chan struct{}
		streamCall(t, "Done()", func() { done = s.Done() })
		if done == nil {
			t.Fatal("Done() returned nil on a zero-value stream: a handler selecting on it parks for good")
		}
	})
}

// the timer tells a handler that never comes back from a crash
func TestZeroValueSSEStreamDoneNeverParksItsHandler(t *testing.T) {
	var s SSEStream
	select {
	case <-s.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("a handler selecting on a zero-value stream's Done() waited for a channel nothing will ever close")
	}
	// a second reader gets the same answer
	select {
	case <-s.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("Done() fired once and then parked the next caller")
	}
}

// the hub's bug was a held mutex, not the panic that caused it
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
			// Ping is write's own public face: the mutex contended is the same
			for range 25 {
				_ = s.Send("tick", 1)
				_ = s.Ping()
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

// a zero value is any field or element nobody assigned
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

// a watcher on a background-context request with no server behind it sat on
// two nil channels forever, one goroutine per stream. The suite parks a thousand

// the count has to hold still before it means anything
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

// covers goroutines earlier tests are still retiring (idle transport
// connections, the race detector's). Small on purpose: the leak is one per stream
const goroutineTolerance = 8

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
		// httptest.NewRequest carries a background context and no server, so neither
		// signal a stream watches can ever fire
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

// cancellable but never cancelled: the watcher must go when the stream goes
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
		// Close, not end(): it is the call a handler that detached its context has.
		// end() is reached by the hub in TestSSEHubEndsTheStreamItOpened below
		stream.Close()
	}

	waitGoroutinesBackTo(t, baseline, "after ending 200 streams whose requests were never cancelled")
}

// the hub must end the stream it opened however its loop returns
func TestSSEHubEndsTheStreamItOpened(t *testing.T) {
	baseline := streamGoroutineBaseline(t)

	hub := NewSSEHub()
	hub.Close() // so ServeHTTP returns on its first select

	// cancellable and never cancelled, so each one really does start a watcher
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for range 200 {
		req := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)
		hub.ServeHTTP(httptest.NewRecorder(), req)
	}

	waitGoroutinesBackTo(t, baseline, "after 200 hub requests that ended at once")
}

// not a performance budget: each wait fires in microseconds when it fires at all
const streamDeadline = 10 * time.Second

// the one budget here that pays for work: Shutdown polls the connections
// dozens of dropped streams left until they read idle, on net/http's own
// ticker. Idle well under a second; at 2x oversubscription measured at 18.6s
// against the 10s streamDeadline. On failure look at what holds a connection open
const shutdownAfterChurn = 60 * time.Second

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

// the streams below have to be unreachable before Close is what reaches them
func assertStillOpen(t *testing.T, done <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-done:
		t.Fatalf("%s: the stream ended on its own, so this test is no longer about Close", what)
	case <-time.After(300 * time.Millisecond):
	}
}

// opened by SSE on a recorder: no server, no cancellable request
func openedStream(t *testing.T) (*SSEStream, *httptest.ResponseRecorder) {
	t.Helper()
	w := httptest.NewRecorder()
	s, err := SSE(w, httptest.NewRequest(http.MethodGet, "/api/events", nil))
	if err != nil {
		t.Fatalf("opening a stream: %v", err)
	}
	return s, w
}

// on its own goroutine: a Close that blocks is a failure with a message
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

// Middleware's doc comment tells an app to write exactly the server below and
// promises borgo's own guarantees; its streams once sat out Shutdown's whole
// context
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
	// Close is what releases the connection when Shutdown could not
	defer srv.Close()

	// the response reaching the client means the handler is inside the stream
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

// the latch is per server, whichever of the two armed it
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

// a stream arms lazily, serveContext arms before the bind: when the stream got
// there first the arming that follows must adopt the latch already there
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

// context.WithoutCancel and r.Clone(context.Background()) drop both the
// cancellation and the server value: Close is the only thing that reaches
// such a stream
func TestCloseEndsAStreamNothingElseCanReach(t *testing.T) {
	streams := make(chan *SSEStream, 1)
	handlerReturned := make(chan struct{})
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerReturned)
		// keeps the response writer, drops the cancellation and the values
		detached := r.Clone(context.Background())
		stream, err := SSE(w, detached)
		if err != nil {
			return
		}
		streams <- stream
		select {
		case <-stream.Done():
		case <-time.After(2 * streamDeadline):
			// keeps a red run from leaving a goroutine parked in every later test
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

	// on a detached context nothing hears the client go
	res.Body.Close()
	assertStillOpen(t, stream.Done(), "a stream on a detached context after the client disconnected")

	// nor the server's shutdown: the clone kept no way of naming the server
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
		// the caller is told to go through SSE, not that it closed something
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
		// the same one every time, whichever call notices
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

		// Close must not queue behind a write: a blackholed client holds the
		// connection for the whole write timeout
		closeStream(t, s, "while a write was in flight")
		waitStreamEnd(t, s.Done(), "the stream after Close during a write")

		close(w.gate)
		select {
		case <-sent:
			// whether the in-flight frame lands is the connection's business
		case <-time.After(streamDeadline):
			t.Fatal("the in-flight Send never returned after its write was released")
		}
		if err := s.Send("after", 1); !errors.Is(err, ErrStreamClosed) {
			t.Errorf("Send() after the in-flight one = %v, want %v", err, ErrStreamClosed)
		}
	})

	t.Run("after the client is gone", func(t *testing.T) {
		s, _, done := servedStream(t)
		done()
		waitStreamEnd(t, s.Done(), "the stream after its client disconnected")
		// the disconnection already fired the latch: Close must not close it twice
		closeStream(t, s, "after the client had gone")
		if err := s.Send("tick", 1); !errors.Is(err, ErrStreamClosed) {
			t.Errorf("Send() after Close on a disconnected stream = %v, want %v", err, ErrStreamClosed)
		}
	})

	t.Run("after Shutdown", func(t *testing.T) {
		s, srv, _ := servedStream(t)
		ctx, cancel := context.WithTimeout(context.Background(), streamDeadline)
		defer cancel()
		if err := srvShutdown(ctx, srv); err != nil {
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

// one entry pinned an *http.Server and its whole handler graph when the key
// was strong
func countLatches() int {
	n := 0
	streamLatches.m.Range(func(_, _ any) bool { n++; return true })
	return n
}

// entries other tests left go on being collected while this one runs
func latchBaseline(t *testing.T) int {
	t.Helper()
	runtime.GC()
	runtime.GC()
	return countLatches()
}

// the removal is the collector's work, so this polls; it fails with the count
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

// returns holding no reference to the server. None of the stop modes is
// Shutdown: an entry removed only by an event the app may never produce is
// the defect
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
	// the Serve goroutine holds the server: nothing can be collected before it
	// returns
	<-served
	http.DefaultClient.CloseIdleConnections()
}

// nothing below ever calls Shutdown, the one event that removes an entry
func TestLatchEntriesDoNotOutliveTheirServers(t *testing.T) {
	t.Run("a server stopped with Close", func(t *testing.T) {
		base := latchBaseline(t)
		oneStreamServer(t, func(srv *http.Server, _ net.Listener) { srv.Close() })
		waitLatchesDropTo(t, base, "a server stopped with Close and never Shutdown")
	})

	t.Run("a server that is never stopped at all", func(t *testing.T) {
		base := latchBaseline(t)
		// neither Shutdown nor Close: the listener goes and the server falls out of use
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

// onShutdown only grows, and an EventSource reconnects for as long as the
// page is open: the latch staying one object across reconnections is the proof
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
	// bounded above only: countLatches falls as other tests' servers are
	// collected (measured 3 to 1 mid-test, 6 runs of 8 at 2x oversubscription),
	// and never rises. The latch identity in the loop above says it was never
	// rebuilt
	if n := countLatches(); n > entries {
		t.Errorf("51 streams on one server left %d latch entries, want at most the %d it started with", n, entries)
	}

	// this Shutdown walks what 51 reconnections left behind: churn budget
	ctx, cancel := context.WithTimeout(context.Background(), shutdownAfterChurn)
	defer cancel()
	if err := srvShutdown(ctx, srv); err != nil {
		t.Fatalf("shutting down after 51 streams, in %v: %v", shutdownAfterChurn, err)
	}
	waitStreamEnd(t, first, "the one latch, after Shutdown")
}

// a stream arriving exactly as the last one leaves: the entry lives for the
// server's whole life, so there is no transition to guard
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

	// the number of live streams crosses zero constantly
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
	// bounded above only, as in the test above
	if n := countLatches(); n > entries {
		t.Errorf("streams crossing zero left %d latch entries for one server, want at most %d", n, entries)
	}

	// the stream opened last must still be reachable by the server's shutdown
	ended := readingStream(t, base)
	// 160 opened-and-dropped connections to walk: churn budget
	ctx, cancel := context.WithTimeout(context.Background(), shutdownAfterChurn)
	defer cancel()
	if err := srvShutdown(ctx, srv); err != nil {
		t.Fatalf("shutting down after 160 streams came and went, in %v: %v", shutdownAfterChurn, err)
	}
	waitStreamEnd(t, ended, "the stream opened after all that coming and going")
}

// through a real server, handing back the stream and the server rather than
// the stream's own request, which no app has. httptest.Server is no use: its
// Close waits for every connection to go idle, and an event stream never does
func servedStream(t *testing.T) (*SSEStream, *http.Server, func()) {
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
		return s, srv, disconnect
	case <-time.After(streamDeadline):
		t.Fatal("the handler never reached its stream")
		return nil, srv, disconnect
	}
}

// holds the first write after arming, so Close can be called mid-write. The
// opening comment must go through untouched
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

// the copy vet's copylocks refuses (`dup := *stream`): same connection, same
// channel, its own mutex
func copyOfStream(s *SSEStream) *SSEStream {
	dup := new(SSEStream)
	reflect.ValueOf(dup).Elem().Set(reflect.ValueOf(s).Elem())
	return dup
}

// Publish against 100 subscribers whose buffers are full: the number to watch
// is that it stays flat as subscribers are added. Subscriptions are opened
// through ServeHTTP, the way an app's are. The clients are wedged, not
// draining: draining handlers put their scheduling inside the timed region
// (29us to 90us/op across identical runs, 212-365 allocs/op against Publish's
// own 9); wedged, three runs land within 9% at 9 allocs/op
func BenchmarkHubPublish(b *testing.B) {
	hub := NewSSEHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	clients := make([]*slowClient, 0, 100)
	var handlers sync.WaitGroup
	for range 100 {
		client := newSlowClient()
		clients = append(clients, client)
		handlers.Add(1)
		go func() {
			defer handlers.Done()
			hub.ServeHTTP(client, httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx))
		}()
	}
	deadline := time.Now().Add(streamDeadline)
	for hub.Subscribers() < 100 {
		if time.Now().After(deadline) {
			b.Fatalf("only %d of 100 streams subscribed", hub.Subscribers())
		}
		time.Sleep(time.Millisecond)
	}

	// enough frames to wedge every handler and fill the buffer behind it
	for _, client := range clients {
		client.wedged.Store(true)
	}
	for i := range 32 {
		hub.Publish("warm", i)
	}
	for i, client := range clients {
		select {
		case <-client.entered:
		case <-time.After(streamDeadline):
			b.Fatalf("client %d never reached a write, so its subscription is not full and this is not the path under test", i)
		}
	}

	payload := map[string]any{"id": 7, "title": "a task", "done": false}
	b.ReportAllocs()
	for b.Loop() {
		hub.Publish("task-created", payload)
	}
	b.StopTimer()

	for _, client := range clients {
		close(client.gate)
	}
	cancel()
	unwound := make(chan struct{})
	go func() { handlers.Wait(); close(unwound) }()
	select {
	case <-unwound:
	case <-time.After(streamDeadline):
		b.Fatal("the hub's handlers never returned after their clients were released")
	}
}

func TestHubBroadcast(t *testing.T) {
	hub := NewSSEHub()
	server := httptest.NewServer(hub)
	// an open stream never goes idle, so Close alone would wait out a failure
	defer func() {
		server.CloseClientConnections()
		server.Close()
	}()

	// the request deadline is the backstop: a read with neither once ended this
	// test at the ten-minute panic
	ctx, cancel := context.WithTimeout(context.Background(), 2*streamDeadline)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatalf("building the request: %v", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("opening the stream: %v", err)
	}
	defer res.Body.Close()

	// through the count the hub publishes rather than the map behind it
	waitSubscribers(t, hub, 1)

	hub.Publish("task-created", map[string]int{"id": 7})

	frames := make(chan []string, 1)
	go func() {
		scanner := bufio.NewScanner(res.Body)
		var lines []string
		for scanner.Scan() {
			line := scanner.Text()
			// comments and separators are not framing
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
			t.Fatalf("broadcast frames wrong: %q", lines)
		}
	case <-time.After(streamDeadline):
		t.Fatalf("the published event never reached the one subscriber the hub reported, in %v: a broadcast is either delivered or lost, and this says which", streamDeadline)
	}
}
