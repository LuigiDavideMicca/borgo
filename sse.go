package borgo

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// sseWriteTimeout bounds each frame write, so one blackholed client cannot
// pin its goroutine (and hub slot) forever
const sseWriteTimeout = 10 * time.Second

// an event stream never ends on its own, so a graceful shutdown would sit out
// its whole grace period waiting for one. The run that is shutting down trips
// its latch, every stream that run is serving sees Done fire, and browsers
// reconnect to the next instance on their own.
//
// The latch belongs to the server, not to the package. One package global is
// re-armed by whichever run started last, and runs overlap: arming happens
// before the bind, so a second ServeContext that never got its port - the most
// likely overlap there is - replaced the live server's latch. The live
// server's own Shutdown then tripped a latch none of its streams were
// watching, so it sat out the whole BORGO_SHUTDOWN_TIMEOUT on them; and when
// the overlapping run stopped, its hook ended the streams of the server still
// serving, which answered every later SSE call with an already-finished stream
// while /healthz stayed green. Keyed by the server, no run can reach another
// run's latch, whatever order they start and stop in. The map is touched when
// a stream opens or a server starts or stops, never per frame.
var streamLatches sync.Map // *http.Server -> *streamLatch

type streamLatch struct {
	done chan struct{}
	once sync.Once
}

func (l *streamLatch) trip() { l.once.Do(func() { close(l.done) }) }

// armStreamShutdown gives srv its own stream-shutdown latch and registers the
// hook that trips it. The returned func trips the latch and forgets the
// server; serveContext defers it, so a run that never reached Shutdown - a
// listener that could not bind - leaves nothing behind either.
func armStreamShutdown(srv *http.Server) func() {
	latch := &streamLatch{done: make(chan struct{})}
	streamLatches.Store(srv, latch)
	disarm := func() {
		latch.trip()
		streamLatches.Delete(srv)
	}
	// net/http runs OnShutdown hooks as `go f()` and Shutdown does not wait for
	// them, so this one can still be pending long after the run it belongs to
	// is gone: it closes over its own latch and can only ever end its own
	// server's streams
	srv.RegisterOnShutdown(disarm)
	return disarm
}

// shutdownSignal is the channel a stream watches for its own server's
// shutdown. The server comes from the request, so a stream always watches the
// run that is serving it. A request that arrives without one - a handler
// called directly in a test, or mounted on something that is not net/http -
// gets a nil channel, which never fires: there is no run to end it, and the
// request's own context still does.
func shutdownSignal(r *http.Request) <-chan struct{} {
	srv, _ := r.Context().Value(http.ServerContextKey).(*http.Server)
	if srv == nil {
		return nil
	}
	latch, _ := streamLatches.Load(srv)
	l, _ := latch.(*streamLatch)
	if l == nil {
		return nil
	}
	return l.done
}

// SSEStream is one open server-sent-events response.
type SSEStream struct {
	w    http.ResponseWriter
	f    http.Flusher
	r    *http.Request
	rc   *http.ResponseController
	done <-chan struct{}
	mu   sync.Mutex
}

// SSE prepares the response for server-sent events and returns the stream.
// The front server proxies it to the browser without buffering.
func SSE(w http.ResponseWriter, r *http.Request) (*SSEStream, error) {
	f, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return nil, errors.New("borgo.SSE: response writer does not support flushing")
	}
	// a stream outlives any server-wide read/write timeout: clear the
	// deadlines on this connection so a configured timeout kills slow
	// requests without killing event streams; each write re-arms its own
	// short deadline instead
	rc := http.NewResponseController(w)
	rc.SetReadDeadline(time.Time{})
	rc.SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	// an SSE comment, ignored by every client, sent before any event: flushing
	// the header block alone is not enough, because an intermediary is free to
	// hold it until the body starts - and one of ours does. Bun.serve does not
	// send a response's headers downstream until the first body byte arrives,
	// so a stream that stays quiet until its first event leaves the browser
	// waiting on fetch() for exactly that long. X-Accel-Buffering asks nginx
	// the same favour; this asks it of everyone, by not being quiet.
	io.WriteString(w, ":ok\n\n")
	f.Flush()
	return &SSEStream{w: w, f: f, r: r, rc: rc, done: streamDone(r)}, nil
}

// streamDone closes on client disconnect or on the shutdown of the server
// serving r, whichever comes first; the watcher goroutine ends with the stream
// either way.
func streamDone(r *http.Request) <-chan struct{} {
	done := make(chan struct{})
	ctx := r.Context()
	stopping := shutdownSignal(r)
	go func() {
		defer close(done)
		select {
		case <-ctx.Done():
		case <-stopping:
		}
	}()
	return done
}

// Send writes one named event with data encoded as JSON. The event name must
// not contain newlines - they would let one event smuggle extra frames.
func (s *SSEStream) Send(event string, data any) error {
	frame, err := sseFrame(event, data)
	if err != nil {
		return err
	}
	return s.write(frame)
}

var pingFrame = []byte(": ping\n\n")

// Ping writes a comment line so proxies don't close an idle stream.
func (s *SSEStream) Ping() error { return s.write(pingFrame) }

func (s *SSEStream) write(frame []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rc.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
	defer s.rc.SetWriteDeadline(time.Time{})
	if _, err := s.w.Write(frame); err != nil {
		return err
	}
	s.f.Flush()
	return nil
}

// sseFrame renders one event as wire bytes. json.Marshal is compact, so the
// payload cannot break out of its data: line.
func sseFrame(event string, data any) ([]byte, error) {
	if strings.ContainsAny(event, "\r\n") {
		return nil, fmt.Errorf("borgo: sse event name must not contain newlines: %q", event)
	}
	payload, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	frame := make([]byte, 0, len(event)+len(payload)+16)
	frame = append(frame, "event: "...)
	frame = append(frame, event...)
	frame = append(frame, "\ndata: "...)
	frame = append(frame, payload...)
	return append(frame, "\n\n"...), nil
}

// Done closes when the client disconnects or the server starts shutting down.
// A stream handler must return once it fires.
func (s *SSEStream) Done() <-chan struct{} {
	return s.done
}

// SSEHub broadcasts events to every connected client. Register its ServeHTTP
// as a route handler and call Publish from anywhere:
//
//	var events = borgo.NewSSEHub()
//
//	//borgo:route GET /api/events
//	func Events(w http.ResponseWriter, r *http.Request) { events.ServeHTTP(w, r) }
type SSEHub struct {
	mu     sync.Mutex
	subs   map[chan []byte]struct{}
	closed chan struct{}
	shut   bool
}

func NewSSEHub() *SSEHub {
	return &SSEHub{subs: map[chan []byte]struct{}{}}
}

// closedChan returns the latch Close trips, creating it on first use so a hub
// that was not built by NewSSEHub still closes rather than panicking. Callers
// must hold h.mu.
func (h *SSEHub) closedChan() chan struct{} {
	if h.closed == nil {
		h.closed = make(chan struct{})
	}
	return h.closed
}

// subsSet returns the subscriber set, creating it on first use so a hub that
// was not built by NewSSEHub registers its streams instead of panicking on a
// nil map. Callers must hold h.mu.
func (h *SSEHub) subsSet() map[chan []byte]struct{} {
	if h.subs == nil {
		h.subs = map[chan []byte]struct{}{}
	}
	return h.subs
}

// Publish sends the event to every connected client. Clients too slow to
// keep up skip messages instead of blocking the publisher. A payload that
// will not encode is logged and dropped: one bad Publish must not disconnect
// every open stream. Publishing to a closed hub does nothing.
func (h *SSEHub) Publish(event string, data any) {
	frame, err := sseFrame(event, data)
	if err != nil {
		log.Printf("borgo: sse publish: %v", err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.shut {
		return
	}
	for ch := range h.subs {
		select {
		case ch <- frame:
		default:
		}
	}
}

// Subscribers is the number of streams currently connected to the hub - the
// server-sent-events counterpart of the WebSocket relay's built-in __count.
// Publish it on a timer for presence, or read it to decide whether producing
// an event is worth the work:
//
//	if hub.Subscribers() > 0 {
//		hub.Publish("tick", expensive())
//	}
//
// It is a sample, not a lock: a client can connect or drop the instant after
// it returns. On a closed hub it is not a sample but a guarantee - it reads 0
// from the moment Close returns, however many requests arrive afterwards.
func (h *SSEHub) Subscribers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

// Close ends every open stream and makes the hub inert: the handlers return,
// their clients see the stream finish, later Publish calls are dropped and a
// request that arrives afterwards is answered with an immediately-finished
// stream. Use it to retire a hub while the process keeps serving - a
// process-wide shutdown already ends every stream through Serve.
//
// Safe from any goroutine and idempotent. Subscribers reports 0 as soon as it
// returns, though the handler goroutines take a moment to unwind.
func (h *SSEHub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.shut {
		return
	}
	h.shut = true
	close(h.closedChan())
	// drop the subscriptions here rather than leaving each handler to remove
	// its own, so Subscribers is 0 the moment Close returns; the handlers'
	// deferred delete is then a no-op
	clear(h.subs)
}

// ServeHTTP streams hub events to one client until it disconnects, the server
// shuts down, or the hub is closed.
func (h *SSEHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	stream, err := SSE(w, r)
	if err != nil {
		return
	}
	ch := make(chan []byte, 8)
	// a function so the unlock is deferred: the section must fail toward
	// releasing the lock, never toward holding it
	closed := func() chan struct{} {
		h.mu.Lock()
		defer h.mu.Unlock()
		// read the latch under the same lock that registers the subscription: a
		// Close racing this call either sees the subscription and clears it, or
		// trips the latch first and this stream ends on its first select. In that
		// second case the subscription is not taken at all, so Subscribers really
		// does read 0 for the whole life of a closed hub, as it documents - a
		// request arriving after Close used to register itself for the microsecond
		// before the select unwound it, and a presence counter could sample it
		if !h.shut {
			h.subsSet()[ch] = struct{}{}
		}
		return h.closedChan()
	}()
	defer func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		delete(h.subs, ch)
	}()

	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-stream.Done():
			return
		case <-closed:
			return
		case <-ping.C:
			if stream.Ping() != nil {
				return
			}
		case frame := <-ch:
			if stream.write(frame) != nil {
				return
			}
		}
	}
}
