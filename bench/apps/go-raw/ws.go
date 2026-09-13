package main

// GO_RAW_WS=1: the phase 3 spike of borgo 0.30. A websocket topic relay on the
// standard library alone - the shape a relay inside borgo's go front would
// take - measured against the one bun runs today. Not a product: enough of
// RFC 6455 for the probe (the handshake, masked client frames, ping, close,
// server text frames), on the same wire as borgo's relay - topics fixed by
// ?topics= at the handshake, {"topic","event","data"} out, the sender's own
// message echoed back, __count on every join and leave - and with the
// delivery policy the design proposes: a small buffer per connection, and a
// connection that falls behind is closed instead of stalling everyone else.

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// what a connection may fall behind by before it is closed. 16 was the first
// guess, and the first run closed almost every subscriber during the __count
// storm a thousand joins raise (1200 of 50000 delivered): GO_RAW_WS_BUFFER
// sets it, so the spike can measure the cost of a buffer that holds
var wsBuffer = func() int {
	if n, err := strconv.Atoi(os.Getenv("GO_RAW_WS_BUFFER")); err == nil && n > 0 {
		return n
	}
	return 16
}()

type wsMessage struct {
	Topic string          `json:"topic"`
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

type wsConn struct {
	conn   net.Conn
	topics []string
	out    chan []byte
	done   chan struct{}
	once   sync.Once
}

type wsHub struct {
	mu     sync.Mutex
	topics map[string]map[*wsConn]struct{}
}

var hub = &wsHub{topics: map[string]map[*wsConn]struct{}{}}

func (c *wsConn) close() {
	c.once.Do(func() {
		close(c.done)
		c.conn.Close()
	})
}

// never blocks the publisher: a full buffer is a subscriber that fell behind
func (c *wsConn) send(frame []byte) {
	select {
	case c.out <- frame:
	default:
		c.close()
	}
}

func (c *wsConn) subscribed(topic string) bool {
	for _, t := range c.topics {
		if t == topic {
			return true
		}
	}
	return false
}

func (c *wsConn) writeLoop() {
	for {
		select {
		case frame := <-c.out:
			if _, err := c.conn.Write(frame); err != nil {
				c.close()
				return
			}
		case <-c.done:
			return
		}
	}
}

func serverFrame(opcode byte, payload []byte) []byte {
	n := len(payload)
	var head []byte
	switch {
	case n < 126:
		head = []byte{0x80 | opcode, byte(n)}
	case n <= 0xffff:
		head = []byte{0x80 | opcode, 126, byte(n >> 8), byte(n)}
	default:
		head = make([]byte, 10)
		head[0], head[1] = 0x80|opcode, 127
		binary.BigEndian.PutUint64(head[2:], uint64(n))
	}
	return append(head, payload...)
}

func (h *wsHub) publish(topic string, payload []byte) {
	frame := serverFrame(0x1, payload)
	h.mu.Lock()
	subs := make([]*wsConn, 0, len(h.topics[topic]))
	for c := range h.topics[topic] {
		subs = append(subs, c)
	}
	h.mu.Unlock()
	for _, c := range subs {
		c.send(frame)
	}
}

func (h *wsHub) count(topic string) {
	h.mu.Lock()
	n := len(h.topics[topic])
	h.mu.Unlock()
	msg, _ := json.Marshal(wsMessage{Topic: topic, Event: "__count", Data: json.RawMessage(strconv.Itoa(n))})
	h.publish(topic, msg)
}

func (h *wsHub) join(c *wsConn) {
	h.mu.Lock()
	for _, t := range c.topics {
		if h.topics[t] == nil {
			h.topics[t] = map[*wsConn]struct{}{}
		}
		h.topics[t][c] = struct{}{}
	}
	h.mu.Unlock()
	for _, t := range c.topics {
		h.count(t)
	}
}

func (h *wsHub) leave(c *wsConn) {
	h.mu.Lock()
	for _, t := range c.topics {
		delete(h.topics[t], c)
		if len(h.topics[t]) == 0 {
			delete(h.topics, t)
		}
	}
	h.mu.Unlock()
	for _, t := range c.topics {
		h.count(t)
	}
}

func (c *wsConn) readLoop(src io.Reader) {
	defer func() {
		c.close()
		hub.leave(c)
	}()
	var head [10]byte
	var mask [4]byte
	for {
		if _, err := io.ReadFull(src, head[:2]); err != nil {
			return
		}
		opcode := head[0] & 0x0f
		n := uint64(head[1] & 0x7f)
		switch n {
		case 126:
			if _, err := io.ReadFull(src, head[2:4]); err != nil {
				return
			}
			n = uint64(binary.BigEndian.Uint16(head[2:4]))
		case 127:
			if _, err := io.ReadFull(src, head[2:10]); err != nil {
				return
			}
			n = binary.BigEndian.Uint64(head[2:10])
		}
		// a client frame is always masked, and the relay's cap is borgo's: 1 MB
		if head[1]&0x80 == 0 || n > 1<<20 {
			return
		}
		if _, err := io.ReadFull(src, mask[:]); err != nil {
			return
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(src, payload); err != nil {
			return
		}
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
		switch opcode {
		case 0x8:
			return
		case 0x9:
			if len(payload) <= 125 {
				c.send(serverFrame(0xa, payload))
			}
		case 0x1:
			var msg wsMessage
			if json.Unmarshal(payload, &msg) != nil || msg.Event == "" || !c.subscribed(msg.Topic) {
				continue
			}
			if msg.Data == nil {
				msg.Data = json.RawMessage("null")
			}
			out, _ := json.Marshal(msg)
			hub.publish(msg.Topic, out)
		}
	}
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	key := r.Header.Get("Sec-WebSocket-Key")
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || key == "" {
		http.Error(w, "upgrade required", http.StatusUpgradeRequired)
		return
	}
	var topics []string
	for _, part := range strings.Split(r.URL.Query().Get("topics"), ",") {
		if t := strings.TrimSpace(part); t != "" {
			topics = append(topics, t)
		}
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	handshake := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
		base64.StdEncoding.EncodeToString(sum[:]) + "\r\n\r\n"
	if _, err := conn.Write([]byte(handshake)); err != nil {
		conn.Close()
		return
	}
	// the server's pooled bufio reader is dropped after the handshake, as in
	// the hijacked sse variant: only what it already buffered is kept
	var src io.Reader = conn
	if buffered := rw.Reader.Buffered(); buffered > 0 {
		pre, _ := rw.Reader.Peek(buffered)
		src = io.MultiReader(bytes.NewReader(append([]byte(nil), pre...)), conn)
	}
	c := &wsConn{conn: conn, topics: topics, out: make(chan []byte, wsBuffer), done: make(chan struct{})}
	go c.writeLoop()
	hub.join(c)
	go c.readLoop(src)
}
