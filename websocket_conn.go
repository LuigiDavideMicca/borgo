package borgo

// A websocket after its handshake: one goroutine reads, one writes, and
// nothing else is held per socket - the shape the phase 3 spike measured at
// 33.8 KiB. The server's pooled bufio reader is dropped at the hijack, as
// there, keeping only what it had already read.

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// vars, not consts: a test cannot wait two minutes for a silent peer. Each
// socket copies them when it opens, so a test changing them races nothing
var (
	// bun pinged idle sockets itself and cut one silent for 120 seconds; a
	// ping every 30 keeps a live socket well inside that, and inside the idle
	// timeout of the proxies commonly in front
	wsPingInterval = 30 * time.Second
	wsReadTimeout  = 120 * time.Second
	wsWriteTimeout = sseWriteTimeout
	// how long a peer has to answer a close before the socket is cut anyway
	wsCloseGrace = 2 * time.Second
	// after a violation the frames can no longer be read, only the bytes:
	// they are dropped until the peer has been this quiet
	wsDrainQuiet = 100 * time.Millisecond
)

// What a socket may have waiting to be written before it is closed with 1013.
// A queue that grows, not a buffer held from the first frame: an idle socket
// holds none of it, and a publisher's burst - a handler pushing a few hundred
// events in a loop - fits, where the fixed 256 slots of the first version
// closed every subscriber of the topic however fast it read. Bytes are counted
// per socket although a frame is shared by every subscriber it goes to, so a
// burst's memory is paid once; the frame count bounds the queue's own
// headers when the frames are tiny. The byte bound is four times the largest
// message's payload, which is three whole frames of it with their headers and
// room for most of a fourth: at one times, a legal message of that size could
// never be queued and closed every subscriber it was sent to (found by the
// verifier).
const (
	wsQueueBytes  = 4 * wsMaxMessage
	wsQueueFrames = 1 << 14
)

var wsPingFrame = wsFrame(wsOpPing, nil)

// the connection cannot be taken - HTTP/2, or a writer that hides it - and
// the response is still unwritten; any other upgrade error has the socket
// taken and closed, and nothing may be written to the response after it
var errWSNotHijacked = errors.New("borgo: the connection cannot be taken for a websocket")

type wsTimers struct {
	ping, read, write, grace, quiet time.Duration
}

type wsConn struct {
	conn   net.Conn
	src    io.Reader
	timers wsTimers

	// frames waiting for the writer, which takes them all at once when wake
	// says there are some. queued and pending count bytes and frames not yet
	// written - the batch the writer holds included, or a reader draining
	// one write's worth at a time would hold twice the bound
	queueMu sync.Mutex
	queue   [][]byte
	queued  int
	pending int
	wake    chan struct{}

	// a pong has a slot of its own, never counted against the queue; one
	// slot, and a ping arriving while it is taken is not answered again: a peer
	// pinging faster than it reads is owed one answer (RFC 6455 section 5.5.3)
	pong chan []byte
	quit chan struct{}
	once sync.Once
	// set once, before quit closes; nil ends the socket without a close frame
	closeFrame []byte
	// the reader re-arms its deadline before every frame and the writer cuts it
	// short after a close: without the lock a re-arm racing the cut would wait
	// the full read timeout for a peer that never answers the close
	deadline sync.Mutex
}

func newWSConn(conn net.Conn, src io.Reader) *wsConn {
	return &wsConn{
		conn:   conn,
		src:    src,
		timers: wsTimers{ping: wsPingInterval, read: wsReadTimeout, write: wsWriteTimeout, grace: wsCloseGrace, quiet: wsDrainQuiet},
		wake:   make(chan struct{}, 1),
		pong:   make(chan []byte, 1),
		quit:   make(chan struct{}),
	}
}

// wsUpgrade answers a handshake wsHandshakeRefusal admitted, and takes the
// socket. The 101 carries the security headers from here: it is written to
// the hijacked socket, past every wrapper that adds them to a response.
func wsUpgrade(w http.ResponseWriter, r *http.Request, security *securityConfig) (*wsConn, error) {
	conn, brw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		// nothing was written: the caller still holds a response it can answer
		return nil, fmt.Errorf("%w: %v", errWSNotHijacked, err)
	}
	h := http.Header{}
	security.apply(h)
	var head strings.Builder
	head.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ")
	head.WriteString(wsAccept(r.Header.Get("Sec-WebSocket-Key")))
	head.WriteString("\r\n")
	h.Write(&head)
	head.WriteString("\r\n")
	// net/http clears its own deadlines when it hands the socket over
	// (hijackLocked, server.go), and every write here and every read in
	// readLoop arms one of its own before it blocks: a subscriber held for an
	// hour is cut by neither
	c := newWSConn(conn, conn)
	if !c.write([]byte(head.String())) {
		conn.Close()
		return nil, errors.New("borgo: the websocket handshake could not be written")
	}
	// a client may send its first frame in the packet that carried the
	// handshake, and the server's reader has it already
	if n := brw.Reader.Buffered(); n > 0 {
		pre, _ := brw.Reader.Peek(n)
		c.src = io.MultiReader(bytes.NewReader(bytes.Clone(pre)), conn)
	}
	return c, nil
}

func (c *wsConn) finish(frame []byte) {
	c.once.Do(func() {
		c.closeFrame = frame
		close(c.quit)
	})
}

func (c *wsConn) ended() bool {
	select {
	case <-c.quit:
		return true
	default:
		return false
	}
}

// close ends the socket with a close frame; the first ending decides. What is
// still queued is not sent: a socket closed for falling behind is not owed the
// backlog, and one closed by shutdown has no time for it.
func (c *wsConn) close(code int, reason string) {
	c.finish(wsCloseFrame(code, reason))
}

// send queues a frame and never waits: a socket with more unread than the
// queue allows is closed with 1013 instead of holding the publisher or
// skipping frames in silence - order and presence are part of a websocket's
// contract, and the client redials by itself.
func (c *wsConn) send(frame []byte) bool {
	if c.ended() {
		return false
	}
	c.queueMu.Lock()
	full := c.pending >= wsQueueFrames || c.queued+len(frame) > wsQueueBytes
	if !full {
		c.queue = append(c.queue, frame)
		c.queued += len(frame)
		c.pending++
	}
	c.queueMu.Unlock()
	if full {
		c.close(wsCloseTryAgainLater, fmt.Sprintf("more than %d KiB or %d messages unread - reconnect", wsQueueBytes>>10, wsQueueFrames))
		return false
	}
	select {
	case c.wake <- struct{}{}:
	default:
	}
	return true
}

// take empties the queue; the backing array goes with it, so a socket that
// was sent a burst does not keep the burst's size once it is written. What
// was taken still counts until wrote says it went out
func (c *wsConn) take() [][]byte {
	c.queueMu.Lock()
	defer c.queueMu.Unlock()
	batch := c.queue
	c.queue = nil
	return batch
}

func (c *wsConn) wrote(frame []byte) {
	c.queueMu.Lock()
	c.queued -= len(frame)
	c.pending--
	c.queueMu.Unlock()
}

type wsEnding int

const (
	wsEndedByPeer      wsEnding = iota // the peer's close frame was read
	wsEndedByViolation                 // the frames stopped making sense
	wsEndedByStream                    // the socket failed, or went silent
)

// serve runs the socket until it has ended. onMessage gets every data message,
// binary as well as text - today's relay reads both as a string - and
// shutdown, when it fires, closes the socket with 1001.
func (c *wsConn) serve(shutdown <-chan struct{}, onMessage func([]byte)) {
	written := make(chan struct{})
	go c.writeLoop(shutdown, written)
	ending := c.readLoop(onMessage)
	c.finish(nil)
	<-written
	// after a violation the peer may still be sending, and closing over unread
	// bytes resets the connection: the reset can reach the peer ahead of the
	// close frame it follows, and a browser then reports 1006 instead of the
	// code. A peer whose close was read has finished sending and waits for this
	// side to end the socket - at once, not after a grace - and one that is
	// gone has nothing left to read
	if ending == wsEndedByViolation {
		c.drain()
	}
	c.conn.Close()
}

// serveAsync runs serve on a goroutine of its own and calls done when the
// socket has ended, so the handler that upgraded can return: net/http's
// goroutine keeps the stack it grew reading the request, and a subscriber is
// held for hours (the spike measured 40.2 KiB a socket served in place, 36
// served here). Out here there is no net/http recover, so a panic in
// onMessage ends this socket, is logged, and leaves the process alone.
func (c *wsConn) serveAsync(shutdown <-chan struct{}, onMessage func([]byte), done func()) {
	go func() {
		defer done()
		defer func() {
			if v := recover(); v != nil {
				log.Printf("borgo: a websocket handler panicked, and its socket was closed: %v", v)
				c.finish(nil)
				c.conn.Close()
			}
		}()
		c.serve(shutdown, onMessage)
	}()
}

// drain drops what the peer still sends until it goes quiet, ends, or the
// grace runs out
func (c *wsConn) drain() {
	end := time.Now().Add(c.timers.grace)
	var buf [512]byte
	for {
		deadline := time.Now().Add(c.timers.quiet)
		if deadline.After(end) {
			deadline = end
		}
		c.conn.SetReadDeadline(deadline)
		if _, err := c.src.Read(buf[:]); err != nil {
			return
		}
	}
}

func (c *wsConn) readLoop(onMessage func([]byte)) wsEnding {
	rd := newWSReader(c.src, wsMaxMessage)
	for {
		c.deadline.Lock()
		select {
		case <-c.quit:
		default:
			c.conn.SetReadDeadline(time.Now().Add(c.timers.read))
		}
		c.deadline.Unlock()

		m, err := rd.next()
		var refused *wsCloseError
		if errors.As(err, &refused) {
			c.close(refused.code, refused.reason)
			return wsEndedByViolation
		}
		if err != nil {
			return wsEndedByStream
		}
		switch m.opcode {
		case wsOpPing:
			select {
			case c.pong <- wsFrame(wsOpPong, m.payload):
			default:
			}
		case wsOpClose:
			code, err := wsCloseCode(m.payload)
			switch {
			case errors.As(err, &refused):
				c.close(refused.code, refused.reason)
			case code == 1005:
				// no code received, none echoed: 1005 may not be sent
				c.finish(wsFrame(wsOpClose, nil))
			default:
				c.close(code, "")
			}
			return wsEndedByPeer
		case wsOpText, wsOpBinary:
			select {
			case <-c.quit:
				// a message crossing the close is not relayed
			default:
				if onMessage != nil {
					onMessage(m.payload)
				}
			}
		}
	}
}

func (c *wsConn) writeLoop(shutdown <-chan struct{}, written chan<- struct{}) {
	defer close(written)
	ping := time.NewTicker(c.timers.ping)
	defer ping.Stop()
	for {
		// a decided close goes out before anything still queued, which the
		// select below would otherwise pick at random against it
		if c.ended() {
			if c.closeFrame != nil {
				c.write(c.closeFrame)
			}
			c.deadline.Lock()
			c.conn.SetReadDeadline(time.Now().Add(c.timers.grace))
			c.deadline.Unlock()
			return
		}
		select {
		case <-c.quit:
		case <-shutdown:
			c.close(wsCloseGoingAway, "the server is shutting down")
			shutdown = nil
		case frame := <-c.pong:
			c.writeOrEnd(frame)
		case <-ping.C:
			c.writeOrEnd(wsPingFrame)
		case <-c.wake:
			for _, frame := range c.take() {
				if !c.writeOrEnd(frame) {
					break
				}
				c.wrote(frame)
				// and a close decided in the middle of a burst is not kept
				// waiting behind the rest of it
				if c.ended() {
					break
				}
			}
		}
	}
}

// writeOrEnd writes a frame, or ends the socket: gone, or not reading for a
// whole write timeout, nothing more can reach it, and the reader is woken
// rather than left to its own deadline
func (c *wsConn) writeOrEnd(frame []byte) bool {
	if c.write(frame) {
		return true
	}
	c.conn.Close()
	c.finish(nil)
	return false
}

func (c *wsConn) write(frame []byte) bool {
	c.conn.SetWriteDeadline(time.Now().Add(c.timers.write))
	_, err := c.conn.Write(frame)
	return err == nil
}
