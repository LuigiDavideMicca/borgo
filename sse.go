package borgo

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"weak"
)

// per frame: one blackholed client cannot pin its goroutine and hub slot
const sseWriteTimeout = 10 * time.Second

// one shutdown latch per server, never a package global: runs overlap (a
// second ServeContext that fails to bind still arms before the bind), and a
// shared latch is then tripped by the wrong run. Touched when a stream opens
// or a server starts or stops, never per frame.
//
// Weak key, not an optimisation: a server stopped with Close, or simply
// dropped, never runs the OnShutdown hook that deletes its entry, and a strong
// key would pin it and its handler graph for the life of the process. Counting
// streams and deleting at zero does not work instead: onShutdown hooks cannot
// be unregistered, so every revival of the entry would add one more hook.
var streamLatches latchMap

// Load answers any, not *streamLatch: the test helper type-asserts the result
type latchMap struct {
	m sync.Map // weak.Pointer[http.Server] -> *streamLatch
}

func (lm *latchMap) Load(srv *http.Server) (any, bool) { return lm.m.Load(weak.Make(srv)) }

// not a closure on purpose: a cleanup that captured srv would keep alive the
// thing whose collection it waits for
func dropLatch(key weak.Pointer[http.Server]) { streamLatches.m.Delete(key) }

type streamLatch struct {
	done chan struct{}
	once sync.Once
}

func (l *streamLatch) trip() { l.once.Do(func() { close(l.done) }) }

// arms lazily so a server borgo did not start (`&http.Server{Handler:
// borgo.Middleware(mux)}`) still ends its streams on Shutdown: the first
// stream it opens is the only moment left to arm it.
//
// Declared, not tested: a stream opening while Shutdown is already walking the
// hook list registers too late and is left to its request context. It is the
// one connection already in a handler, since nothing is accepted by then.
func latchFor(srv *http.Server) *streamLatch {
	key := weak.Make(srv)
	if l, ok := streamLatches.m.Load(key); ok {
		return l.(*streamLatch)
	}
	fresh := &streamLatch{done: make(chan struct{})}
	actual, loaded := streamLatches.m.LoadOrStore(key, fresh)
	if !loaded {
		// neither may capture srv: the hook lives inside the server, the cleanup
		// must not reference what it waits on. net/http runs the hook as `go f()`
		// without waiting, so it can fire after a later latch took the key:
		// CompareAndDelete drops its own entry only
		srv.RegisterOnShutdown(func() {
			fresh.trip()
			streamLatches.m.CompareAndDelete(key, fresh)
		})
		runtime.AddCleanup(srv, dropLatch, key)
	}
	return actual.(*streamLatch)
}

// the returned func trips the latch and forgets the server; serveContext
// defers it, so a run that never reached Shutdown leaves nothing behind
func armStreamShutdown(srv *http.Server) func() {
	latch := latchFor(srv)
	key := weak.Make(srv)
	return func() {
		latch.trip()
		streamLatches.m.CompareAndDelete(key, latch)
	}
}

// nil (never fires) for a request with no net/http server in its context: a
// handler called directly, or a context whose values were dropped
func shutdownSignal(r *http.Request) <-chan struct{} {
	srv, _ := r.Context().Value(http.ServerContextKey).(*http.Server)
	if srv == nil {
		return nil
	}
	return latchFor(srv).done
}

// SSEStream is one open server-sent-events response, from SSE. A zero value
// never opened: every write is refused with an error naming SSE, and Done
// reports it already finished rather than handing out a nil channel.
type SSEStream struct {
	w  http.ResponseWriter
	f  http.Flusher
	r  *http.Request
	rc *http.ResponseController
	mu sync.Mutex

	// nil marks a stream that did not come from SSE
	state *streamEnd
}

// behind one pointer so a copied SSEStream (vet's copylocks refuses it, a copy
// happens anyway) shares the once with the original instead of closing the
// channel twice
type streamEnd struct {
	streamLatch
	// only Close sets this: a disconnection or a shutdown ends the stream
	// without it, so a racing write reports what the connection reported
	closed atomic.Bool
}

var errStreamNotOpen = errors.New("borgo: SSEStream was not opened by borgo.SSE(w, r), so it has nowhere to write")

// ErrStreamClosed is what Send and Ping return once the stream has been
// closed by SSEStream.Close. It is one value, so a caller that keeps writing
// sees the same error whichever call notices first, and can tell a stream it
// closed itself from a connection that failed under it:
//
//	if err := stream.Send("tick", n); errors.Is(err, borgo.ErrStreamClosed) {
//		return
//	}
//
// A stream ended by the client disconnecting or by the server shutting down
// does not report this: those write attempts fail with whatever the connection
// reported, because that is the more useful answer. Watch Done for those.
var ErrStreamClosed = errors.New("borgo: SSEStream is closed")

// Done of a stream that never opened: already closed, so the handler unwinds
var streamOver = func() chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}()

// fires Done without refusing writes: only Close does that
func (s *SSEStream) end() {
	if s.state == nil {
		return
	}
	s.state.trip()
}

// Close ends the stream from the handler's side. Use it when nothing else can:
// a handler that detached the request context (context.WithoutCancel, r.Clone
// onto a background context) has a stream no disconnection and no shutdown
// will ever end.
//
// Idempotent and safe from any goroutine. When it returns, Done is closed and
// every later Send and Ping fails with ErrStreamClosed; a write already in
// flight is neither interrupted nor waited for. Nothing is written to the
// client: the response ends when the handler returns, and an EventSource
// reconnects unless told otherwise.
func (s *SSEStream) Close() {
	if s.state == nil {
		return
	}
	// refused before Done fires, so a goroutine Done wakes cannot slip a frame
	// in behind the close
	s.state.closed.Store(true)
	s.state.trip()
}

// SSE prepares the response for server-sent events and returns the stream.
// The front server proxies it to the browser without buffering.
func SSE(w http.ResponseWriter, r *http.Request) (*SSEStream, error) {
	f, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return nil, errors.New("borgo.SSE: response writer does not support flushing")
	}
	// a stream outlives any server-wide read/write timeout; each write re-arms
	// its own short deadline instead
	rc := http.NewResponseController(w)
	rc.SetReadDeadline(time.Time{})
	rc.SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	// flushing the headers alone is not enough: Bun.serve holds a response's
	// headers until the first body byte, so a quiet stream would leave the
	// browser waiting on fetch() until its first event
	io.WriteString(w, ":ok\n\n")
	f.Flush()
	stream := &SSEStream{w: w, f: f, r: r, rc: rc, state: &streamEnd{streamLatch: streamLatch{done: make(chan struct{})}}}
	stream.watch(r)
	return stream, nil
}

// with both signals absent there is nothing to wait for, and a watcher on two
// nil channels would sit for the life of the process
func (s *SSEStream) watch(r *http.Request) {
	ctx := r.Context()
	stopping := shutdownSignal(r)
	if ctx.Done() == nil && stopping == nil {
		return
	}
	go func() {
		select {
		case <-ctx.Done():
		case <-stopping:
		case <-s.state.done: // ended from the handler's side: the watcher goes too
			return
		}
		s.end()
	}()
}

// Send writes one named event with data encoded as JSON. The event name must
// not contain newlines.
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
	if s.w == nil || s.f == nil || s.rc == nil {
		return errStreamNotOpen
	}
	if s.state != nil && s.state.closed.Load() {
		return ErrStreamClosed
	}
	s.rc.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
	defer s.rc.SetWriteDeadline(time.Time{})
	if _, err := s.w.Write(frame); err != nil {
		return err
	}
	s.f.Flush()
	return nil
}

// json.Marshal is compact, so the payload cannot break out of its data: line
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
// A stream handler must return once it fires. On a stream that never opened it
// is already closed.
func (s *SSEStream) Done() <-chan struct{} {
	if s.state == nil {
		return streamOver
	}
	return s.state.done
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

// created on first use so a hub not built by NewSSEHub still works. Under h.mu
func (h *SSEHub) closedChan() chan struct{} {
	if h.closed == nil {
		h.closed = make(chan struct{})
	}
	return h.closed
}

// same, for the subscriber set. Under h.mu
func (h *SSEHub) subsSet() map[chan []byte]struct{} {
	if h.subs == nil {
		h.subs = map[chan []byte]struct{}{}
	}
	return h.subs
}

// Publish sends the event to every connected client. Clients too slow to keep
// up skip messages instead of blocking the publisher. A payload that will not
// encode is logged and dropped. Publishing to a closed hub does nothing.
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
// It is a sample: a client can connect or drop the instant after it returns.
// On a closed hub it reads 0 from the moment Close returns.
func (h *SSEHub) Subscribers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

// Close ends every open stream and makes the hub inert: later Publish calls
// are dropped and a request arriving afterwards gets an immediately-finished
// stream. Use it to retire a hub while the process keeps serving; a
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
	// here and not in each handler, so Subscribers is 0 the moment Close returns
	clear(h.subs)
}

// ServeHTTP streams hub events to one client until it disconnects, the server
// shuts down, or the hub is closed.
func (h *SSEHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	stream, err := SSE(w, r)
	if err != nil {
		return
	}
	// releases the watcher even when the request context never cancels
	defer stream.Close()
	ch := make(chan []byte, 8)
	// the latch is read under the lock that registers the subscription, and a
	// shut hub takes none: otherwise Subscribers could sample a request that
	// arrived after Close, for the microsecond before its select unwinds
	closed := func() chan struct{} {
		h.mu.Lock()
		defer h.mu.Unlock()
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
