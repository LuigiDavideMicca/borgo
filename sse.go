package borgo

import (
	"context"
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
// its whole grace period waiting for one. ServeContext cancels this when it
// starts shutting down and every stream's Done fires: browsers reconnect to
// the next instance on their own.
//
// It is re-armed at the top of every ServeContext rather than being a one-shot
// package latch, so a program that runs a server, stops it and runs another -
// which ServeContext exists to allow - does not start the second one with
// every stream already cancelled. The mutex is only taken when a stream opens
// or a server starts or stops, never per frame.
var (
	shutdownMu   sync.Mutex
	shutdownCtx  context.Context
	shutdownStop context.CancelFunc
)

func init() { armShutdown() }

// armShutdown resets the stream-shutdown latch.
func armShutdown() {
	shutdownMu.Lock()
	defer shutdownMu.Unlock()
	shutdownCtx, shutdownStop = context.WithCancel(context.Background())
}

// signalShutdown ends every open stream. Registered as the server's
// OnShutdown hook.
func signalShutdown() {
	shutdownMu.Lock()
	stop := shutdownStop
	shutdownMu.Unlock()
	stop()
}

// shutdownSignal is the channel a stream watches for server shutdown.
func shutdownSignal() <-chan struct{} {
	shutdownMu.Lock()
	defer shutdownMu.Unlock()
	return shutdownCtx.Done()
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
	return &SSEStream{w: w, f: f, r: r, rc: rc, done: streamDone(r.Context())}, nil
}

// streamDone closes on client disconnect or on shutdown, whichever comes
// first; the watcher goroutine ends with the stream either way.
func streamDone(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	stopping := shutdownSignal()
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
// it returns.
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
	h.mu.Lock()
	// read the latch under the same lock that registers the subscription: a
	// Close racing this call either sees the subscription and clears it, or
	// trips the latch first and this stream ends on its first select
	closed := h.closedChan()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.subs, ch)
		h.mu.Unlock()
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
