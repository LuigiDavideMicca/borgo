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

// frames a socket may fall behind by before it is closed. Measured: 16 closed
// almost every subscriber in the __count storm of a thousand joins; 256
// delivered all of it at 33.8 KiB a socket; 1024 cost 48.2 and bought no time
const wsSendBuffer = 256

var wsPingFrame = wsFrame(wsOpPing, nil)

type wsTimers struct {
	ping, read, write, grace, quiet time.Duration
}

type wsConn struct {
	conn   net.Conn
	src    io.Reader
	timers wsTimers
	out    chan []byte
	// a pong has a slot of its own, never counted against the data buffer; one
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
		out:    make(chan []byte, wsSendBuffer),
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
		return nil, err
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

// close ends the socket with a close frame; the first ending decides. What is
// still queued is not sent: a socket closed for falling behind is not owed the
// backlog, and one closed by shutdown has no time for it.
func (c *wsConn) close(code int, reason string) {
	c.finish(wsCloseFrame(code, reason))
}

// send queues a frame and never waits: a socket wsSendBuffer frames behind is
// closed with 1013 instead of holding the publisher or skipping frames in
// silence - order and presence are part of a websocket's contract, and the
// client redials by itself.
func (c *wsConn) send(frame []byte) bool {
	select {
	case <-c.quit:
		return false
	default:
	}
	select {
	case c.out <- frame:
		return true
	default:
		c.close(wsCloseTryAgainLater, fmt.Sprintf("more than %d messages unread - reconnect", wsSendBuffer))
		return false
	}
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
		var frame []byte
		select {
		case <-c.quit:
			if c.closeFrame != nil {
				c.write(c.closeFrame)
			}
			c.deadline.Lock()
			c.conn.SetReadDeadline(time.Now().Add(c.timers.grace))
			c.deadline.Unlock()
			return
		case <-shutdown:
			c.close(wsCloseGoingAway, "the server is shutting down")
			shutdown = nil
			continue
		case frame = <-c.pong:
		case frame = <-c.out:
		case <-ping.C:
			frame = wsPingFrame
		}
		if !c.write(frame) {
			// gone, or not reading for a whole write timeout: nothing more can
			// reach it, and the reader is woken rather than left to its deadline
			c.conn.Close()
			c.finish(nil)
		}
	}
}

func (c *wsConn) write(frame []byte) bool {
	c.conn.SetWriteDeadline(time.Now().Add(c.timers.write))
	_, err := c.conn.Write(frame)
	return err == nil
}
