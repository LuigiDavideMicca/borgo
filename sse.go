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
//
// The key is a weak pointer, and that is not an optimisation. Keyed strongly,
// the map pins every server it has ever seen for the life of the process: the
// entry was dropped only by the OnShutdown hook, so a server stopped with
// Close - or one the app simply stops using - left itself and its whole
// handler graph behind a key nothing would ever remove. Only servers borgo
// started escaped, because serveContext defers a disarm that runs on every
// path. Lazy arming made that every net/http server that serves one event
// stream. A weak key holds no server up.
//
// The alternative considered was counting live streams per server and dropping
// the entry at zero. It cannot work here: http.Server.onShutdown only grows -
// net/http offers no way to unregister a hook - so every revival of a dropped
// entry registers another one, and a server whose clients reconnect (which is
// what EventSource does, forever) would accumulate one hook and one dead latch
// per stream it ever served. That trades one leaked entry per server for a
// leak proportional to traffic. An entry that lives exactly as long as its
// server needs no count, and leaves no window between the last stream leaving
// and the next one arriving.
var streamLatches latchMap

// latchMap is the map above with its strong-pointer lookups spelled out, so no
// caller builds a weak key by hand. Load answers with any rather than
// *streamLatch because the test helper that reads it type-asserts the result.
type latchMap struct {
	m sync.Map // weak.Pointer[http.Server] -> *streamLatch
}

func (lm *latchMap) Load(srv *http.Server) (any, bool) { return lm.m.Load(weak.Make(srv)) }

// dropLatch forgets a server that has been collected. It is a package-level
// func and not a closure on purpose: a cleanup that captured the server would
// keep alive the very thing whose collection it is waiting for, and this shape
// cannot.
func dropLatch(key weak.Pointer[http.Server]) { streamLatches.m.Delete(key) }

type streamLatch struct {
	done chan struct{}
	once sync.Once
}

func (l *streamLatch) trip() { l.once.Do(func() { close(l.done) }) }

// latchFor returns srv's latch, arming one the first time anybody asks for a
// server that has none. The lazy arming is what makes the guarantee Middleware
// promises true on a server borgo did not start: an app that mounts
// `&http.Server{Handler: borgo.Middleware(mux)}` calls nothing of ours before
// serving, so the only moment left to arm it is the first stream it opens.
// Without that its Shutdown had no way to end a stream, and sat on it until
// its own context gave out - borgo's own server only escaped because shutdown
// follows the grace period with Close.
//
// RegisterOnShutdown takes the server's lock and appends, so it is legal at
// any time, and Shutdown runs whatever is registered when it takes that same
// lock. The window it cannot cover is a stream opening while Shutdown is
// already walking the list: that hook is registered too late to run, and the
// stream is left to its request context. Requests are not being accepted by
// then, so this is the one connection that was already in a handler. That
// window is reasoned about here and NOT covered by a test: reproducing it
// means interleaving with the inside of net/http's Shutdown, which we do not
// control. Treat it as declared, not as verified.
//
// LoadOrStore rather than Store: the hook is registered once per server, and
// a stream that armed the latch and a later serveContext on the same server
// must end up watching the same one.
func latchFor(srv *http.Server) *streamLatch {
	key := weak.Make(srv)
	if l, ok := streamLatches.m.Load(key); ok {
		return l.(*streamLatch)
	}
	fresh := &streamLatch{done: make(chan struct{})}
	actual, loaded := streamLatches.m.LoadOrStore(key, fresh)
	if !loaded {
		// neither of these may capture srv. The hook is stored inside the
		// server, and the cleanup must not reference the object it waits on -
		// so both carry the weak key, which keeps nothing alive.
		//
		// net/http runs OnShutdown hooks as `go f()` and Shutdown does not wait
		// for them, so this one can still be pending long after the run it
		// belongs to is gone: it closes over its own latch and can only ever end
		// its own server's streams. CompareAndDelete, so it drops its own entry
		// and never a later one's.
		srv.RegisterOnShutdown(func() {
			fresh.trip()
			streamLatches.m.CompareAndDelete(key, fresh)
		})
		runtime.AddCleanup(srv, dropLatch, key)
	}
	return actual.(*streamLatch)
}

// armStreamShutdown arms srv's stream-shutdown latch before it serves anything,
// rather than leaving it to the first stream. The returned func trips the latch
// and forgets the server; serveContext defers it, so a run that never reached
// Shutdown - a listener that could not bind - leaves nothing behind either.
func armStreamShutdown(srv *http.Server) func() {
	latch := latchFor(srv)
	key := weak.Make(srv)
	return func() {
		latch.trip()
		streamLatches.m.CompareAndDelete(key, latch)
	}
}

// shutdownSignal is the channel a stream watches for its own server's
// shutdown. The server comes from the request, so a stream always watches the
// run that is serving it - every net/http server puts itself there, not only
// ours. A request that arrives without one - a handler called directly in a
// test, mounted on something that is not net/http, or holding a context whose
// values were dropped - gets a nil channel, which never fires: there is no run
// this stream can be shown to belong to, and the request's own context and
// Close remain.
func shutdownSignal(r *http.Request) <-chan struct{} {
	srv, _ := r.Context().Value(http.ServerContextKey).(*http.Server)
	if srv == nil {
		return nil
	}
	return latchFor(srv).done
}

// SSEStream is one open server-sent-events response.
//
// It comes from SSE. A zero value never opened: it has nothing to write to and
// nothing that could ever disconnect it, so every write is refused with an
// error naming SSE, and Done reports it already finished. The alternative was
// what a zero value used to do - panic inside the nil ResponseController, and
// hand Done a nil channel, which parks the handler selecting on it for good.
type SSEStream struct {
	w  http.ResponseWriter
	f  http.Flusher
	r  *http.Request
	rc *http.ResponseController
	mu sync.Mutex

	// nil on any stream that did not come from SSE; that is what marks it as
	// never opened
	state *streamEnd
}

// streamEnd is everything about a stream's ending, behind one pointer both a
// stream and any copy of it reach. go vet's copylocks refuses to copy an
// SSEStream - the write mutex must not be copied, two of them on one
// connection interleave frames - but a copy taken anyway used to share the
// channel while getting a sync.Once of its own, so ending the original and the
// copy closed that channel twice and panicked. Behind the pointer the once is
// shared too, and the second ending is the no-op it claims to be. It cost
// nothing to make the diagnosis not also be a crash.
type streamEnd struct {
	streamLatch
	// Close sets this; a client that disappears or a server that shuts down
	// ends the stream without it, so a write racing a disconnection still
	// reports what the connection reported rather than a verdict of ours
	closed atomic.Bool
}

// errStreamNotOpen is the refusal a stream that never opened answers with.
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

// streamOver is what Done hands a stream that never opened: already closed, so
// the handler unwinds at once instead of waiting on a channel nobody will
// close. One value for all of them - nothing ever writes to it.
var streamOver = func() chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}()

// end fires Done, once, from any goroutine. A stream that never opened has no
// latch to fire and is already over. It leaves writes alone: only Close
// refuses them.
func (s *SSEStream) end() {
	if s.state == nil {
		return
	}
	s.state.trip()
}

// Close ends the stream from the handler's side. Use it when nothing else can:
// a handler that detaches the request context - context.WithoutCancel, or an
// r.Clone onto a background context to go on working after the response - has
// a stream that no disconnection and no shutdown will ever end, because it
// kept neither the cancellation nor the values the two signals are read from.
//
// It is idempotent and safe from any goroutine, including one that is not the
// handler's. When it returns, Done is closed and every later Send and Ping is
// refused with one same error. It does not interrupt or wait for a write
// already in flight: that write finishes or fails on its own, and the refusals
// start after it.
//
// Closing does not write anything to the client. The response simply ends when
// the handler returns, which is what a browser's EventSource sees as the
// stream finishing, and it will reconnect unless told otherwise.
func (s *SSEStream) Close() {
	if s.state == nil {
		return
	}
	// refuse writes before firing Done, so a goroutine that Done wakes cannot
	// slip a frame in behind the close it was told about
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
	stream := &SSEStream{w: w, f: f, r: r, rc: rc, state: &streamEnd{streamLatch: streamLatch{done: make(chan struct{})}}}
	stream.watch(r)
	return stream, nil
}

// watch ends the stream when the client disconnects or when the server serving
// r starts shutting down, whichever comes first.
//
// Either signal can be absent: a request with a background context cannot be
// cancelled, and a handler called with no net/http server behind it has no
// shutdown latch to read. When both are, there is nothing to wait for, and the
// watcher this used to start regardless sat on two nil channels for the life
// of the process - one goroutine per stream, on exactly the streams nothing
// would ever end. So it is not started at all, and when it is, the stream's
// own end releases it too: the watcher goes when the stream goes, without
// waiting for a client that may never disconnect.
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
		case <-s.state.done: // the stream ended from the handler's side
			return
		}
		s.end()
	}()
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
// A stream handler must return once it fires. On a stream that never opened it
// is already closed: such a stream is over before it starts, and saying so is
// the only answer that does not park the handler forever.
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
	// however this loop returns, the stream is over: releasing its watcher here
	// rather than leaving it to the request context means the goroutine goes
	// even when the request is one that never gets cancelled
	defer stream.Close()
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
