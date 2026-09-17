package borgo

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const wsTestHandshake = "GET /ws?topics=a HTTP/1.1\r\nHost: app.test\r\nOrigin: http://app.test\r\n" +
	"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"

// wsPeer is a client spoken by hand, so every byte the server sends is seen
// as sent: the 101's own header block, each frame, and the end of the socket
type wsPeer struct {
	t    *testing.T
	conn net.Conn
	br   *bufio.Reader
	res  *http.Response
}

func dialWSPeer(t *testing.T, base string) *wsPeer {
	t.Helper()
	return dialWSPeerWith(t, base, nil)
}

// dialWSPeerWith sends first in the same write as the handshake
func dialWSPeerWith(t *testing.T, base string, first []byte) *wsPeer {
	t.Helper()
	return dialWSRaw(t, base, append([]byte(wsTestHandshake), first...))
}

// dialWSRaw writes a whole request as given and reads the answer's head
func dialWSRaw(t *testing.T, base string, request []byte) *wsPeer {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(base, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if _, err := conn.Write(request); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	br := bufio.NewReader(conn)
	res, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	return &wsPeer{t: t, conn: conn, br: br, res: res}
}

func (p *wsPeer) send(frames ...testFrame) {
	p.t.Helper()
	if _, err := p.conn.Write(frameStream(frames...)); err != nil {
		p.t.Fatal(err)
	}
}

type serverFrame struct {
	opcode  byte
	payload []byte
}

// next reads one server frame; a server frame is never masked or fragmented
func (p *wsPeer) next(within time.Duration) (serverFrame, error) {
	p.conn.SetReadDeadline(time.Now().Add(within))
	var head [2]byte
	if _, err := io.ReadFull(p.br, head[:]); err != nil {
		return serverFrame{}, err
	}
	if head[0]&0x80 == 0 || head[0]&0x70 != 0 || head[1]&0x80 != 0 {
		return serverFrame{}, errors.New("a server frame that is fragmented, extended or masked")
	}
	n := uint64(head[1] & 0x7f)
	switch n {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(p.br, ext[:]); err != nil {
			return serverFrame{}, err
		}
		n = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(p.br, ext[:]); err != nil {
			return serverFrame{}, err
		}
		n = binary.BigEndian.Uint64(ext[:])
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(p.br, payload); err != nil {
		return serverFrame{}, err
	}
	return serverFrame{opcode: head[0] & 0x0f, payload: payload}, nil
}

// nextData skips pings, which the server sends on its own schedule
func (p *wsPeer) nextData(within time.Duration) serverFrame {
	p.t.Helper()
	for {
		f, err := p.next(within)
		if err != nil {
			p.t.Fatalf("no frame: %v", err)
		}
		if f.opcode != wsOpPing {
			return f
		}
	}
}

// closed expects a close frame with this code, answers it as a browser does -
// the code echoed, then a wait for the server to end the socket - and expects
// the end within the given time
func (p *wsPeer) closed(code int, reason string, within time.Duration) {
	p.t.Helper()
	f := p.nextData(5 * time.Second)
	if f.opcode != wsOpClose || len(f.payload) < 2 {
		p.t.Fatalf("expected a close frame, got opcode %#x with %q", f.opcode, f.payload)
	}
	if got := int(binary.BigEndian.Uint16(f.payload)); got != code {
		p.t.Fatalf("closed with %d (%q), want %d", got, f.payload[2:], code)
	}
	if reason != "" && !strings.Contains(string(f.payload[2:]), reason) {
		p.t.Fatalf("close reason %q does not say %q", f.payload[2:], reason)
	}
	p.conn.Write(testFrame{fin: true, opcode: wsOpClose, payload: f.payload[:2]}.bytes())
	start := time.Now()
	p.ended()
	if took := time.Since(start); took > within {
		p.t.Fatalf("the socket ended %v after the close was answered, over %v", took, within)
	}
}

// ended reads to the end of the socket: an EOF, or the reset a close over
// unread bytes gives
func (p *wsPeer) ended() {
	p.t.Helper()
	for {
		f, err := p.next(5 * time.Second)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				p.t.Fatal("the socket did not end")
			}
			return
		}
		if f.opcode != wsOpPing {
			p.t.Fatalf("a frame after the close: %#x %q", f.opcode, f.payload)
		}
	}
}

type wsTestServer struct {
	srv      *http.Server
	base     string
	security *securityConfig
	onOpen   func(c *wsConn)
	// messages the connection handed on, and a signal each time serve returns
	messages atomic.Int64
	served   chan struct{}
}

// an echo relay: the connection layer under test, and nothing of the relay
func startWSServer(t *testing.T, configure func(s *wsTestServer)) *wsTestServer {
	t.Helper()
	s := &wsTestServer{served: make(chan struct{}, 16)}
	s.srv = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if refusal := wsHandshakeRefusal(r); refusal.status != 0 {
			http.Error(w, refusal.reason, refusal.status)
			return
		}
		c, err := wsUpgrade(w, r, s.security)
		if err != nil {
			t.Error(err)
			return
		}
		if s.onOpen != nil {
			s.onOpen(c)
		}
		c.serve(shutdownSignal(r), func(p []byte) {
			s.messages.Add(1)
			c.send(wsFrame(wsOpText, p))
		})
		s.served <- struct{}{}
	})}
	if configure != nil {
		configure(s)
	}
	armStreamShutdown(s.srv)
	s.base = serveOn(t, s.srv)
	t.Cleanup(func() { s.srv.Close() })
	return s
}

// setWSVar changes a timer for one test; sockets copy the timers when they
// open, and every socket of this test opens after the change
func setWSVar(t *testing.T, v *time.Duration, to time.Duration) {
	prev := *v
	*v = to
	t.Cleanup(func() { *v = prev })
}

func TestWSUpgradeAnswersWithTheAcceptAndTheSecurityHeaders(t *testing.T) {
	s := startWSServer(t, func(s *wsTestServer) {
		s.security = &securityConfig{enabled: true, csp: "default-src 'self'"}
	})
	p := dialWSPeer(t, s.base)
	if p.res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("answered %d", p.res.StatusCode)
	}
	for name, want := range map[string]string{
		"Upgrade":              "websocket",
		"Connection":           "Upgrade",
		"Sec-WebSocket-Accept": "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
	} {
		if got := p.res.Header.Get(name); got != want {
			t.Errorf("%s: %q, want %q", name, got, want)
		}
	}
	for _, kv := range staticSecurity {
		if got := p.res.Header.Get(kv[0]); got != kv[1] {
			t.Errorf("the handshake carries %s: %q, want %q", kv[0], got, kv[1])
		}
	}
	// a 101 has no content type, and a policy on a socket is noise
	if csp := p.res.Header.Get("Content-Security-Policy"); csp != "" {
		t.Errorf("the handshake carries a csp: %q", csp)
	}

	off := startWSServer(t, func(s *wsTestServer) { s.security = &securityConfig{enabled: false} })
	if got := dialWSPeer(t, off.base).res.Header.Get("X-Frame-Options"); got != "" {
		t.Errorf("security headers off, and the handshake still carries X-Frame-Options: %q", got)
	}
}

func TestWSRelaysWholeMessagesAndAnswersPings(t *testing.T) {
	s := startWSServer(t, nil)
	p := dialWSPeer(t, s.base)
	p.send(
		textFrame(`{"a":1}`),
		testFrame{opcode: wsOpText, payload: []byte("frag")},
		testFrame{fin: true, opcode: wsOpPing, payload: []byte("are you there")},
		testFrame{fin: true, opcode: wsOpContinuation, payload: []byte("mented")},
		testFrame{fin: true, opcode: wsOpBinary, payload: []byte(`"binary too"`)},
	)
	// data keeps its order; the pong has a slot of its own and may pass it
	var data, pongs []string
	for len(data)+len(pongs) < 4 {
		f := p.nextData(5 * time.Second)
		switch f.opcode {
		case wsOpText:
			data = append(data, string(f.payload))
		case wsOpPong:
			pongs = append(pongs, string(f.payload))
		default:
			t.Fatalf("unexpected frame %#x %q", f.opcode, f.payload)
		}
	}
	if want := []string{`{"a":1}`, "fragmented", `"binary too"`}; fmt.Sprintf("%q", data) != fmt.Sprintf("%q", want) {
		t.Errorf("data %q, want %q", data, want)
	}
	if len(pongs) != 1 || pongs[0] != "are you there" {
		t.Errorf("pongs %q, want the one ping's payload", pongs)
	}
}

// the server's reader buffers past the handshake whatever arrived with it
func TestWSFrameSentWithTheHandshakeIsNotLost(t *testing.T) {
	s := startWSServer(t, nil)
	p := dialWSPeerWith(t, s.base, textFrame("in the same packet").bytes())
	if f := p.nextData(5 * time.Second); f.opcode != wsOpText || string(f.payload) != "in the same packet" {
		t.Fatalf("got %#x %q", f.opcode, f.payload)
	}
}

func TestWSPeerCloseIsEchoedAndTheSocketEndedAtOnce(t *testing.T) {
	// a drain where none belongs would show as a second's wait
	setWSVar(t, &wsDrainQuiet, time.Second)
	s := startWSServer(t, nil)
	for _, code := range []int{1000, 4000} {
		p := dialWSPeer(t, s.base)
		start := time.Now()
		p.send(testFrame{fin: true, opcode: wsOpClose, payload: append(binary.BigEndian.AppendUint16(nil, uint16(code)), "bye"...)})
		f := p.nextData(5 * time.Second)
		if f.opcode != wsOpClose || len(f.payload) != 2 || int(binary.BigEndian.Uint16(f.payload)) != code {
			t.Fatalf("a close %d answered with %#x %q", code, f.opcode, f.payload)
		}
		p.ended()
		if took := time.Since(start); took > 500*time.Millisecond {
			t.Fatalf("the socket ended %v after the peer's close %d", took, code)
		}
	}

	// a close with no code is answered with none: 1005 may not be sent
	q := dialWSPeer(t, s.base)
	start := time.Now()
	q.send(testFrame{fin: true, opcode: wsOpClose})
	f := q.nextData(5 * time.Second)
	if f.opcode != wsOpClose || len(f.payload) != 0 {
		t.Fatalf("an empty close answered with %#x %q", f.opcode, f.payload)
	}
	q.ended()
	if took := time.Since(start); took > 500*time.Millisecond {
		t.Fatalf("the socket ended %v after the peer's empty close", took)
	}
}

func TestWSViolationClosesWithItsCode(t *testing.T) {
	s := startWSServer(t, nil)
	cases := []struct {
		name  string
		input []byte
		code  int
	}{
		{"an unmasked frame", testFrame{fin: true, opcode: wsOpText, payload: []byte("hi"), unmasked: true}.bytes(), wsCloseProtocolError},
		// only the header is sent: the refusal cannot wait for two megabytes
		{"a message over a megabyte", testFrame{fin: true, opcode: wsOpText, declared: 2 << 20}.bytes()[:14], wsCloseTooBig},
		{"text that is not utf-8", textFrame("\xff\xfe").bytes(), wsCloseInvalidPayload},
		{"a close code no one may send", testFrame{fin: true, opcode: wsOpClose, payload: []byte{0x03, 0xed}}.bytes(), wsCloseProtocolError},
		// what follows a violation is still arriving when the server ends the
		// socket: without the drain, the reset outruns the close frame
		{"a violation with more on the wire behind it",
			append(testFrame{fin: true, opcode: wsOpText, payload: []byte("hi"), unmasked: true}.bytes(), bytes.Repeat([]byte{0x81}, 1<<16)...),
			wsCloseProtocolError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := dialWSPeer(t, s.base)
			if _, err := p.conn.Write(tc.input); err != nil {
				t.Fatal(err)
			}
			// read late, as a busy page does: a reset, if the server sends
			// one, has arrived by then and takes the close frame with it
			time.Sleep(200 * time.Millisecond)
			p.closed(tc.code, "", wsCloseGrace/2)
		})
	}
}

// the drain after a violation is bounded by the grace, not by a peer that
// never falls quiet
func TestWSDrainEndsAtTheGraceForAPeerThatNeverStops(t *testing.T) {
	setWSVar(t, &wsCloseGrace, 300*time.Millisecond)
	s := startWSServer(t, nil)
	p := dialWSPeer(t, s.base)
	p.conn.Write(testFrame{fin: true, opcode: wsOpText, payload: []byte("hi"), unmasked: true}.bytes())
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
				if _, err := p.conn.Write(bytes.Repeat([]byte{0x81}, 64)); err != nil {
					return
				}
			}
		}
	}()
	start := time.Now()
	select {
	case <-s.served:
		if took := time.Since(start); took > 1500*time.Millisecond {
			t.Fatalf("the socket ended %v after the violation, with a grace of 300ms", took)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a peer that never stops sending held the drain open")
	}
}

// the origin refusal is a close the client must see as 4403, which it treats
// as final; a reset instead reads as a dropped socket, and is redialled
func TestWSServerCloseReachesAPeerThatIsStillSending(t *testing.T) {
	s := startWSServer(t, func(s *wsTestServer) {
		s.onOpen = func(c *wsConn) { c.close(wsCloseOriginRefused, "origin refused") }
	})
	p := dialWSPeer(t, s.base)
	chatter := make([]testFrame, 64)
	for i := range chatter {
		chatter[i] = textFrame(strings.Repeat("x", 1000))
	}
	// written before a byte is read: the server has unread input when it ends
	p.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	p.conn.Write(frameStream(chatter...))
	f := p.nextData(5 * time.Second)
	if f.opcode != wsOpClose || binary.BigEndian.Uint16(f.payload) != wsCloseOriginRefused {
		t.Fatalf("expected close 4403, got %#x %q", f.opcode, f.payload)
	}
	if string(f.payload[2:]) != "origin refused" {
		t.Fatalf("reason %q", f.payload[2:])
	}
	// and nothing a refused socket sent was handed on - counted once the
	// server has read all of it and ended the socket
	p.conn.Write(testFrame{fin: true, opcode: wsOpClose, payload: f.payload[:2]}.bytes())
	select {
	case <-s.served:
	case <-time.After(5 * time.Second):
		t.Fatal("the refused socket was never ended")
	}
	if n := s.messages.Load(); n != 0 {
		t.Fatalf("%d messages of a closed socket reached the relay", n)
	}
}

func TestWSPeerThatNeverAnswersACloseIsCutAfterTheGrace(t *testing.T) {
	setWSVar(t, &wsCloseGrace, 300*time.Millisecond)
	s := startWSServer(t, func(s *wsTestServer) {
		s.onOpen = func(c *wsConn) { c.close(wsCloseOriginRefused, "origin refused") }
	})

	silent := dialWSPeer(t, s.base)
	if f := silent.nextData(5 * time.Second); f.opcode != wsOpClose {
		t.Fatalf("expected a close, got %#x %q", f.opcode, f.payload)
	}
	start := time.Now()
	silent.ended()
	if took := time.Since(start); took < 200*time.Millisecond || took > 2*time.Second {
		t.Fatalf("cut %v after a close it never answered, with a grace of 300ms", took)
	}

	// sending frames is not answering the close: they do not buy more time
	chatty := dialWSPeer(t, s.base)
	if f := chatty.nextData(5 * time.Second); f.opcode != wsOpClose {
		t.Fatalf("expected a close, got %#x %q", f.opcode, f.payload)
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(30 * time.Millisecond):
				if _, err := chatty.conn.Write(textFrame("still talking").bytes()); err != nil {
					return
				}
			}
		}
	}()
	start = time.Now()
	chatty.ended()
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("a peer sending frames was cut %v after a close it never answered", took)
	}
}

func TestWSSendQueuesUpToItsBoundsThenClosesWith1013(t *testing.T) {
	cases := []struct {
		name  string
		frame []byte
		fits  int
	}{
		// the byte bound, with frames the size of a real event
		{"bytes", make([]byte, 64<<10), wsQueueBytes / (64 << 10)},
		// the frame bound, with frames too small for the bytes to matter
		{"frames", make([]byte, 2), wsQueueFrames},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newWSConn(nil, nil)
			for i := range tc.fits {
				if !c.send(tc.frame) {
					t.Fatalf("frame %d of %d refused", i, tc.fits)
				}
			}
			// and it comes back at once: a publisher fanning out to many slow
			// sockets pays this per socket
			start := time.Now()
			if c.send(tc.frame) {
				t.Fatalf("frame %d accepted past the bound", tc.fits+1)
			}
			if took := time.Since(start); took > 10*time.Millisecond {
				t.Fatalf("the send past the bound waited %v", took)
			}
			if !c.ended() {
				t.Fatal("a full queue did not close the socket")
			}
			if code, _ := wsCloseCode(c.closeFrame[2:]); code != wsCloseTryAgainLater {
				t.Fatalf("closed with %d, want 1013", code)
			}
		})
	}
	// and a socket that is closing takes nothing more, with all the room
	// there is
	c := newWSConn(nil, nil)
	c.close(wsCloseNormal, "")
	if c.send([]byte("x")) || c.pending != 0 {
		t.Fatal("a closing socket accepted a frame")
	}
}

// the queue is memory only while it holds something: written, it lets go of
// a burst's backing array - and what the writer holds still counts until it
// is written, or a reader draining one write at a time would hold twice the
// bound (found by the verifier)
func TestWSQueueLetsGoOfWhatItWroteAndCountsWhatItHasNot(t *testing.T) {
	c := newWSConn(nil, nil)
	for range 1000 {
		c.send([]byte("x"))
	}
	batch := c.take()
	if len(batch) != 1000 {
		t.Fatalf("took %d of 1000", len(batch))
	}
	if c.queue != nil {
		t.Fatalf("after a take the queue still holds %d frames in %d slots", len(c.queue), cap(c.queue))
	}
	if c.queued != 1000 || c.pending != 1000 {
		t.Fatalf("a batch being written counts as %d bytes, %d frames", c.queued, c.pending)
	}
	for _, f := range batch {
		c.wrote(f)
	}
	if c.queued != 0 || c.pending != 0 {
		t.Fatalf("written, the queue still counts %d bytes, %d frames", c.queued, c.pending)
	}
	if !c.send([]byte("y")) || c.queued != 1 {
		t.Fatalf("a written queue counts %d bytes for one", c.queued)
	}
}

// the bound holds while the writer is blocked on a peer: the batch it took
// is still unread by that peer
func TestWSQueueBoundCountsTheBatchBeingWritten(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	c := newWSConn(server, server)
	big := make([]byte, wsQueueBytes/4)
	for i := range 4 {
		if !c.send(big) {
			t.Fatalf("frame %d of 4 refused", i)
		}
	}
	written := make(chan struct{})
	go c.writeLoop(nil, written)
	// the writer is now blocked on the first frame, the batch taken
	time.Sleep(50 * time.Millisecond)
	if c.send(big) {
		t.Fatal("a fifth frame was queued while four were being written")
	}
	server.Close()
	<-written
}

// a close decided while the writer is in the middle of a batch goes out
// after the frame in flight, not after the rest of the batch
func TestWSCloseInTheMiddleOfABatchIsNotKeptWaiting(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	c := newWSConn(server, server)
	for i := range 6 {
		c.send(wsFrame(wsOpText, []byte{'0' + byte(i)}))
	}
	written := make(chan struct{})
	go c.writeLoop(nil, written)
	p := &wsPeer{t: t, conn: client, br: bufio.NewReader(client)}
	if f, _ := p.next(time.Second); f.opcode != wsOpText || string(f.payload) != "0" {
		t.Fatalf("first frame %#x %q", f.opcode, f.payload)
	}
	c.close(wsCloseNormal, "now")
	// at most the frame already in flight, then the close
	dataAfter := 0
	for {
		f, err := p.next(time.Second)
		if err != nil {
			t.Fatalf("no close frame: %v", err)
		}
		if f.opcode == wsOpClose {
			break
		}
		dataAfter++
	}
	if dataAfter > 1 {
		t.Fatalf("%d data frames went out after the close was decided", dataAfter)
	}
	p.nothingMore()
	server.Close()
	<-written
}

// nothingMore reads for a moment and expects the socket to stay silent: the
// writer has nothing to say after a close frame
func (p *wsPeer) nothingMore() {
	p.t.Helper()
	f, err := p.next(300 * time.Millisecond)
	if err == nil {
		p.t.Fatalf("a %#x frame with %q after the close frame", f.opcode, f.payload)
	}
	if ne, ok := err.(net.Error); !ok || !ne.Timeout() {
		p.t.Fatalf("expected silence, got %v", err)
	}
}

// a close decided before the writer ever ran goes out before the backlog
func TestWSCloseGoesOutBeforeABacklog(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	c := newWSConn(server, server)
	for range 3 {
		c.send(wsFrame(wsOpText, []byte("backlog")))
	}
	c.close(wsCloseNormal, "first")
	written := make(chan struct{})
	go c.writeLoop(nil, written)
	p := &wsPeer{t: t, conn: client, br: bufio.NewReader(client)}
	f, err := p.next(time.Second)
	if err != nil || f.opcode != wsOpClose {
		t.Fatalf("first frame %#x %q, %v", f.opcode, f.payload, err)
	}
	// and the backlog never follows it
	p.nothingMore()
	server.Close()
	<-written
}

func TestWSSubscriberThatFallsBehindIsClosedWith1013AndNeverBlocksTheSender(t *testing.T) {
	sent := make(chan time.Duration, 1)
	s := startWSServer(t, func(s *wsTestServer) {
		s.onOpen = func(c *wsConn) {
			go func() {
				frame := wsFrame(wsOpText, []byte(strings.Repeat("y", 4096)))
				start := time.Now()
				for i := 0; i < 100000 && c.send(frame); i++ {
				}
				sent <- time.Since(start)
			}()
		}
	})
	p := dialWSPeer(t, s.base)
	select {
	case took := <-sent:
		if took > 2*time.Second {
			t.Errorf("the sender was held %v by a peer that reads nothing", took)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the sender blocked on a peer that reads nothing")
	}
	// the backlog is not owed: what arrives is some data, then the close
	for {
		f := p.nextData(10 * time.Second)
		if f.opcode == wsOpText {
			continue
		}
		if f.opcode != wsOpClose || binary.BigEndian.Uint16(f.payload) != wsCloseTryAgainLater {
			t.Fatalf("expected close 1013, got %#x %q", f.opcode, f.payload)
		}
		break
	}
}

// a peer that reads nothing fails a write at the write timeout; the socket
// ends then, not when the reader's own deadline or the close grace passes
func TestWSFailedWriteEndsTheSocketAtOnce(t *testing.T) {
	setWSVar(t, &wsWriteTimeout, 200*time.Millisecond)
	setWSVar(t, &wsCloseGrace, 5*time.Second)
	setWSVar(t, &wsReadTimeout, 10*time.Second)
	opened := make(chan time.Time, 1)
	s := startWSServer(t, func(s *wsTestServer) {
		s.onOpen = func(c *wsConn) {
			opened <- time.Now()
			// frames the writer can take one at a time, until the socket is full
			go func() {
				frame := wsFrame(wsOpText, bytes.Repeat([]byte{'z'}, 1<<16))
				for c.send(frame) {
					time.Sleep(time.Millisecond)
				}
			}()
		}
	})
	dialWSPeer(t, s.base) // and never read from
	start := <-opened
	select {
	case <-s.served:
		if took := time.Since(start); took > 4*time.Second {
			t.Fatalf("the socket ended %v after it opened", took)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("a socket whose writes fail was never ended")
	}
}

func TestWSShutdownClosesEverySocketWithGoingAway(t *testing.T) {
	setWSVar(t, &wsDrainQuiet, time.Second)
	s := startWSServer(t, nil)
	p := dialWSPeer(t, s.base)
	q := dialWSPeer(t, s.base)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go s.srv.Shutdown(ctx)
	p.closed(wsCloseGoingAway, "shutting down", 500*time.Millisecond)
	q.closed(wsCloseGoingAway, "shutting down", 500*time.Millisecond)
}

func TestWSSilentPeerIsCutAndALiveOneIsKept(t *testing.T) {
	setWSVar(t, &wsPingInterval, 40*time.Millisecond)
	setWSVar(t, &wsReadTimeout, 300*time.Millisecond)
	s := startWSServer(t, nil)

	silent := dialWSPeer(t, s.base)
	start := time.Now()
	pings := 0
	for {
		f, err := silent.next(3 * time.Second)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				t.Fatal("a silent peer was never cut")
			}
			if time.Since(start) < 250*time.Millisecond {
				t.Fatalf("cut after %v, before the read timeout", time.Since(start))
			}
			break
		}
		if f.opcode == wsOpPing {
			pings++
		}
	}
	if pings < 3 {
		t.Errorf("%d pings in the read timeout, at one every 40ms", pings)
	}

	// answering pings is sending frames: the deadline moves with each
	live := dialWSPeer(t, s.base)
	until := time.Now().Add(time.Second)
	for time.Now().Before(until) {
		f, err := live.next(time.Second)
		if err != nil {
			t.Fatalf("a peer answering every ping was cut: %v", err)
		}
		if f.opcode == wsOpPing {
			live.send(testFrame{fin: true, opcode: wsOpPong, payload: f.payload})
		}
	}
	live.send(textFrame("still here"))
	if f := live.nextData(time.Second); string(f.payload) != "still here" {
		t.Fatalf("got %q", f.payload)
	}
}

// RFC 6455 section 5.5.1: nothing may follow a close frame. A socket closed
// for falling behind still has a backlog queued, and a publisher that has not
// noticed goes on handing it frames
func TestWSNothingIsWrittenAfterTheCloseFrame(t *testing.T) {
	s := startWSServer(t, func(s *wsTestServer) {
		s.onOpen = func(c *wsConn) {
			go func() {
				frame := wsFrame(wsOpText, []byte("backlog"))
				for range 64 {
					c.send(frame)
				}
				c.close(wsCloseNormal, "done")
				for range 64 {
					c.send(frame)
				}
			}()
		}
	})
	p := dialWSPeer(t, s.base)
	closed := false
	for {
		f, err := p.next(5 * time.Second)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				t.Fatal("the socket did not end")
			}
			break
		}
		if closed {
			t.Fatalf("a %#x frame with %q after the close frame", f.opcode, f.payload)
		}
		closed = f.opcode == wsOpClose
	}
	if !closed {
		t.Fatal("the socket ended without a close frame")
	}
}

// a socket served on its own goroutine has no net/http recover above it: a
// handler that panics ends that socket, and the writer with it, and nothing else
func TestWSPanicInAHandlerEndsOnlyItsSocket(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)
	ended := make(chan struct{}, 4)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := wsUpgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		c.serveAsync(nil, func(p []byte) {
			if string(p) == "boom" {
				panic("the handler broke")
			}
			c.send(wsFrame(wsOpText, p))
		}, func() { ended <- struct{}{} })
	})}
	base := serveOn(t, srv)
	defer srv.Close()

	before := runtime.NumGoroutine()
	broken := dialWSPeer(t, base)
	broken.send(textFrame("boom"))
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the socket whose handler panicked never ended")
	}
	broken.ended()
	// its writer went with it: nothing is left waiting for a ping to fail
	waitFor(t, func() bool { return runtime.NumGoroutine() <= before }, "the broken socket's goroutines to exit")

	live := dialWSPeer(t, base)
	live.send(textFrame("still serving"))
	if f := live.nextData(2 * time.Second); string(f.payload) != "still serving" {
		t.Fatalf("got %q", f.payload)
	}
}

// the numbers the design chose, which no other test would notice changing:
// bun cut a silent socket at 120 seconds and pinged it itself
func TestWSDefaultTimersAreTheOnesTheDesignChose(t *testing.T) {
	if wsPingInterval != 30*time.Second || wsReadTimeout != 120*time.Second {
		t.Errorf("ping every %v, read deadline %v; want 30s and 120s", wsPingInterval, wsReadTimeout)
	}
	if wsCloseGrace != 2*time.Second || wsDrainQuiet != 100*time.Millisecond {
		t.Errorf("close grace %v, drain quiet %v; want 2s and 100ms", wsCloseGrace, wsDrainQuiet)
	}
	// four times the largest message: at one times, a legal message of that
	// size could never be queued
	if wsQueueBytes != 4*wsMaxMessage || wsQueueFrames != 1<<14 {
		t.Errorf("a socket may queue %d bytes and %d frames; want 4 MiB and 16384", wsQueueBytes, wsQueueFrames)
	}
	if wsCountWindow != 50*time.Millisecond {
		t.Errorf("counts coalesced over %v; want 50ms", wsCountWindow)
	}
	if wsWriteTimeout != sseWriteTimeout {
		t.Errorf("write timeout %v; want the one borgo.SSE bounds its writes with (%v)", wsWriteTimeout, sseWriteTimeout)
	}
}

// the public port arms a read and a write timeout on every request; net/http
// clears them as it hands the socket to a hijacker, and the deadline each read
// and each write arms here is what bounds the socket afterwards. The guard is
// on both: a net/http that stopped clearing them would cut this socket
func TestWSHijackedSocketOutlivesTheServersTimeouts(t *testing.T) {
	s := startWSServer(t, func(s *wsTestServer) {
		s.srv.ReadTimeout = 150 * time.Millisecond
		s.srv.WriteTimeout = 150 * time.Millisecond
	})
	p := dialWSPeer(t, s.base)
	time.Sleep(500 * time.Millisecond)
	p.send(textFrame("after the timeouts"))
	if f := p.nextData(2 * time.Second); string(f.payload) != "after the timeouts" {
		t.Fatalf("got %q", f.payload)
	}
}
