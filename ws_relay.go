package borgo

// The topic relay today's bun server runs, moved into the go front: topics
// fixed by ?topics= at the handshake, {"topic","event","data"} out, a
// browser's message relayed to its own topics and echoed back to it, and
// "__count" kept current for every topic. The wire is bun's, so the client
// does not change; where this differs, the difference is written beside it.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"
)

const wsCountEvent = "__count"

var wsCountEventJSON = json.RawMessage(`"` + wsCountEvent + `"`)

// one "__count" per topic per window, whatever joined or left during it. bun
// sent one on every join and every leave to every subscriber: a thousand
// sockets opening together was half a million messages in the phase 3 spike.
// What a window sends is always the count as it stands when the window closes
var wsCountWindow = 50 * time.Millisecond

type wsRelayOptions struct {
	security      *securityConfig
	trusted       []*net.IPNet
	allowNoOrigin bool
}

type wsRelay struct {
	opts   wsRelayOptions
	window time.Duration

	// mu also orders the fan-out: every subscriber of a topic sees its events
	// in one order, as bun's single thread gave them. Held through a publish,
	// which is cheap because a send never waits
	mu       sync.Mutex
	topics   map[string]map[*wsConn]struct{}
	changed  map[string]struct{}
	counting bool
}

func newWSRelay(opts wsRelayOptions) *wsRelay {
	return &wsRelay{
		opts:    opts,
		window:  wsCountWindow,
		topics:  map[string]map[*wsConn]struct{}{},
		changed: map[string]struct{}{},
	}
}

// wsEnvelope is an event as bun's JSON.stringify wrote it: these three names
// in this order, and no "data" when a browser sent none. The event is JSON
// text, not a string: a browser's event name travels as it was written, lone
// surrogate escapes included, which a go string would turn into U+FFFD
type wsEnvelope struct {
	Topic string          `json:"topic"`
	Event json.RawMessage `json:"event"`
	Data  json.RawMessage `json:"data,omitempty"`
}

// jsonText is a string as JSON.stringify writes it
func jsonText(s string) json.RawMessage {
	return json.RawMessage(jsQuote(s))
}

// wsEventJSON encodes an event once for every subscriber it goes to, without
// the html escaping encoding/json adds and JSON.stringify never did
func wsEventJSON(topic string, event, data json.RawMessage) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(wsEnvelope{Topic: topic, Event: event, Data: data}); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

func wsEventFrame(topic string, event, data json.RawMessage) ([]byte, error) {
	body, err := wsEventJSON(topic, event, data)
	if err != nil {
		return nil, err
	}
	return wsFrame(wsOpText, body), nil
}

// ServeHTTP answers /ws in bun's order: the origin, then the topics, then the
// handshake itself.
func (h *wsRelay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	handshake := wsHandshakeRefusal(r)
	if why := wsOriginRefusal(r, h.opts.trusted, h.opts.allowNoOrigin); why != "" {
		// logged: the browser is told nothing it can show
		log.Printf("borgo: /ws refused: %s", why)
		if handshake.status != 0 {
			http.Error(w, handshake.reason, handshake.status)
			return
		}
		// completed and then closed, not answered 403: a refused handshake
		// reaches a page as "connection closed" with no status at all, and a
		// close code is the one thing the client can read - 4403 is final,
		// where anything else is redialled
		c := h.upgrade(w, r)
		if c == nil {
			return
		}
		c.close(wsCloseOriginRefused, why)
		c.serve(nil, nil)
		return
	}
	topics, why := wsTopics(r.URL.RawQuery)
	if why != "" {
		log.Printf("borgo: /ws refused: %s", why)
		http.Error(w, why, http.StatusBadRequest)
		return
	}
	if handshake.status != 0 {
		http.Error(w, handshake.reason, handshake.status)
		return
	}
	c := h.upgrade(w, r)
	if c == nil {
		return
	}
	// joined before the socket is served: one that ends at once must still
	// find itself there to leave
	h.join(c, topics)
	c.serveAsync(shutdownSignal(r),
		func(payload []byte) { h.fromClient(topics, payload) },
		func() { h.leave(c, topics) })
}

func (h *wsRelay) upgrade(w http.ResponseWriter, r *http.Request) *wsConn {
	c, err := wsUpgrade(w, r, h.opts.security)
	// any other error has the connection taken, and the response with it
	if errors.Is(err, errWSNotHijacked) {
		http.Error(w, "upgrade required", http.StatusUpgradeRequired)
	}
	return c
}

func (h *wsRelay) join(c *wsConn, topics []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, topic := range topics {
		subs := h.topics[topic]
		if subs == nil {
			subs = map[*wsConn]struct{}{}
			h.topics[topic] = subs
		}
		subs[c] = struct{}{}
		h.changed[topic] = struct{}{}
	}
	h.countSoon()
}

func (h *wsRelay) leave(c *wsConn, topics []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, topic := range topics {
		subs := h.topics[topic]
		delete(subs, c)
		if len(subs) == 0 {
			delete(h.topics, topic)
		}
		h.changed[topic] = struct{}{}
	}
	h.countSoon()
}

// countSoon arms the window, once; called with mu held
func (h *wsRelay) countSoon() {
	if h.counting || len(h.changed) == 0 {
		return
	}
	h.counting = true
	time.AfterFunc(h.window, h.sendCounts)
}

func (h *wsRelay) sendCounts() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.counting = false
	for topic := range h.changed {
		delete(h.changed, topic)
		subs := h.topics[topic]
		frame, err := wsEventFrame(topic, wsCountEventJSON, json.RawMessage(strconv.Itoa(len(subs))))
		if err != nil {
			continue
		}
		for c := range subs {
			c.send(frame)
		}
	}
}

// publish sends one event to every subscriber of the topic, the sender
// included - bun's server.publish did, and a page renders its own message
// from the echo. A subscriber that has fallen behind is closed by its send,
// never waited for.
func (h *wsRelay) publish(topic string, event, data json.RawMessage) error {
	frame, err := wsEventFrame(topic, event, data)
	if err != nil {
		return err
	}
	h.publishFrame(topic, frame)
	return nil
}

func (h *wsRelay) publishFrame(topic string, frame []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.topics[topic] {
		c.send(frame)
	}
}

// fromClient relays what a browser publishes, on the topics its own socket
// holds, as bun's relay did: "topic" and "event" both strings, "data" passed
// on as it came, and anything else dropped in silence - a client sending
// garbage learns nothing from an answer.
func (h *wsRelay) fromClient(topics []string, payload []byte) {
	// a text message is utf-8 already; a binary one was read by bun as a
	// string, with each broken sequence replaced. Relayed as it came, it would
	// reach every subscriber inside a text frame that is not utf-8, and each
	// browser would close its socket (1007) - one sender taking a topic down
	if !utf8.Valid(payload) {
		payload = wsDecodeUTF8(payload)
	}
	// a map, not a struct: struct fields would also take "TOPIC" and "Event",
	// which JSON.parse does not
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil {
		return
	}
	topicJSON := fields["topic"]
	topic, ok := jsonString(topicJSON)
	// half of a surrogate pair decodes to U+FFFD here and stays itself in
	// JSON.parse, so a topic spelled with one could match a held "�"
	// that bun would never have matched: no held topic contains one
	if !ok || loneSurrogate(topicJSON) || !slices.Contains(topics, topic) {
		return
	}
	event, ok := jsonString(fields["event"])
	// "__count" is the relay's own: a browser sending one would set every
	// other subscriber's count. bun relayed it; this does not
	if !ok || event == wsCountEvent {
		return
	}
	h.publish(topic, fields["event"], fields["data"])
}

// jsonString is a JSON string value, and not anything else that would decode
func jsonString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var s string
	return s, json.Unmarshal(raw, &s) == nil
}

// loneSurrogate reports a \u escape in a JSON string that is half of a
// UTF-16 pair with no other half
func loneSurrogate(raw []byte) bool {
	s := string(raw)
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' {
			continue
		}
		if i+1 < len(s) && s[i+1] != 'u' {
			// an escaped character, a backslash among them
			i++
			continue
		}
		hi, ok := hex4(s, i+2)
		if !ok {
			return false
		}
		switch {
		case hi >= 0xDC00 && hi <= 0xDFFF:
			return true
		case hi >= 0xD800 && hi <= 0xDBFF:
			lo, ok := hex4(s, i+8)
			if !ok || s[i+6] != '\\' || s[i+7] != 'u' || lo < 0xDC00 || lo > 0xDFFF {
				return true
			}
			i += 11
		default:
			i += 5
		}
	}
	return false
}

func hex4(s string, at int) (uint64, bool) {
	if at < 0 || at+4 > len(s) {
		return 0, false
	}
	v, err := strconv.ParseUint(s[at:at+4], 16, 16)
	return v, err == nil
}

// wsDecodeUTF8 is a binary message read as text the way bun read it: the
// WHATWG decoder, one U+FFFD for each maximal subpart of a broken sequence.
// utf8.DecodeRune and strings.ToValidUTF8 each count them differently
func wsDecodeUTF8(b []byte) []byte {
	out := make([]byte, 0, len(b)+8)
	for i := 0; i < len(b); {
		c := b[i]
		if c < 0x80 {
			out = append(out, c)
			i++
			continue
		}
		need, lo, hi := 0, byte(0x80), byte(0xBF)
		switch {
		case c >= 0xC2 && c <= 0xDF:
			need = 1
		case c == 0xE0:
			need, lo = 2, 0xA0
		case c == 0xED:
			need, hi = 2, 0x9F
		case c >= 0xE1 && c <= 0xEF:
			need = 2
		case c == 0xF0:
			need, lo = 3, 0x90
		case c == 0xF4:
			need, hi = 3, 0x8F
		case c >= 0xF1 && c <= 0xF3:
			need = 3
		default:
			out = utf8.AppendRune(out, utf8.RuneError)
			i++
			continue
		}
		j := i + 1
		for k := 0; k < need; k++ {
			if j >= len(b) || b[j] < lo || b[j] > hi {
				break
			}
			lo, hi = 0x80, 0xBF
			j++
		}
		if j-i == need+1 {
			out = append(out, b[i:j]...)
		} else {
			// the maximal subpart is replaced whole; the byte that broke it
			// starts the next sequence
			out = utf8.AppendRune(out, utf8.RuneError)
		}
		i = j
	}
	return out
}

// publishEvent is borgo.Push's side of the relay. A topic no subscriber can
// ever hold is an error here, where bun answered 204 for anything without a
// comma and dropped the message; so is an event larger than the largest a
// client may send, which could not fit a subscriber's queue with anything
// else in it.
func (h *wsRelay) publishEvent(topic, event string, data any) error {
	if why := wsPublishTopicRefusal(topic); why != "" {
		return fmt.Errorf("borgo.Push: %s", why)
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(data); err != nil {
		return fmt.Errorf("borgo.Push: the data for %s/%s does not encode as json: %w", topic, event, err)
	}
	body, err := wsEventJSON(topic, jsonText(event), bytes.TrimSuffix(b.Bytes(), []byte("\n")))
	if err != nil {
		return fmt.Errorf("borgo.Push: %w", err)
	}
	if len(body) > wsMaxMessage {
		return fmt.Errorf("borgo.Push: the event %s/%s is %d bytes, over the %d a websocket message may be here - push an id and let the page fetch the rest", topic, event, len(body), wsMaxMessage)
	}
	h.publishFrame(topic, wsFrame(wsOpText, body))
	return nil
}

func wsPublishTopicRefusal(topic string) string {
	if topic == revalidateTopic {
		return revalidateTopic + " is not a topic: the page cache lives in the go front, where borgo.Revalidate is a local call"
	}
	if why := wsTopicSeparatorRefusal(topic); why != "" {
		return why
	}
	if jsTrim(topic) == "" {
		return fmt.Sprintf("topic %s names nothing a page can subscribe to", jsQuote(topic))
	}
	if jsTrim(topic) != topic {
		return fmt.Sprintf("topic %s can never be subscribed to: a handshake trims the whitespace around each topic", jsQuote(topic))
	}
	if n := utf16Len(topic); n > wsMaxTopicLength {
		return fmt.Sprintf("topic %s... is %d characters, over the %d a subscriber may ask for", jsQuote(utf16Prefix(topic, 40)), n, wsMaxTopicLength)
	}
	return ""
}
