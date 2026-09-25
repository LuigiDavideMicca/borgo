package borgo

// The server side of RFC 6455 that borgo's topic relay needs, on the standard
// library. Phase 3 of 0.30 moves the relay from bun into the go front: the
// numbers that chose it are in bench/results/spikes (a relay here held 33.8
// KiB per socket and reached a thousand subscribers in 10.6 ms, against 42
// KiB and 23.2 ms for bun behind a lean forwarder).
//
// This file is the protocol and nothing else - the handshake, frames, the
// close codes and the rules today's relay applies to a handshake - as pure
// functions, so every guard is tested without a socket. The relay that uses
// them is a separate step.

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// the same sixteen bytes for every websocket server there is: RFC 6455
// section 1.3 writes them out, and the accept they hash into proves to the
// client that this answer was written by something that read the handshake,
// not by a cache or a proxy replaying a 101 it did not understand
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	// one message, fragments summed: the relay's cap, the same as bun's today
	wsMaxMessage = 1 << 20
	// the client refuses both at the call site (MAX_TOPIC_LENGTH in index.ts)
	// and the server refuses them again on the handshake
	wsMaxTopics      = 32
	wsMaxTopicLength = 128
)

// close codes (RFC 6455 section 7.4.1), and borgo's own for a refused origin,
// which the client treats as final and does not redial
const (
	wsCloseNormal          = 1000
	wsCloseGoingAway       = 1001
	wsCloseProtocolError   = 1002
	wsCloseInvalidPayload  = 1007
	wsClosePolicyViolation = 1008
	wsCloseTooBig          = 1009
	wsCloseTryAgainLater   = 1013
	wsCloseOriginRefused   = 4403
)

const (
	wsOpContinuation byte = 0x0
	wsOpText         byte = 0x1
	wsOpBinary       byte = 0x2
	wsOpClose        byte = 0x8
	wsOpPing         byte = 0x9
	wsOpPong         byte = 0xa
)

// wsAccept is Sec-WebSocket-Accept for a handshake's key.
func wsAccept(key string) string {
	sum := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// wsRefusal is why a request is not a handshake this server completes, and
// the status the answer carries. A zero status is a handshake.
type wsRefusal struct {
	status int
	reason string
}

func headerHasToken(h http.Header, name, token string) bool {
	for _, value := range h.Values(name) {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

// wsHandshakeRefusal checks the request line and headers of an upgrade.
// Anything that is not an upgrade at all is 426, as today's relay answers it;
// a version other than 13 is 426 too, and the caller names the one it speaks
// (RFC 6455 section 4.4); a key that is not 16 bytes is a malformed handshake.
func wsHandshakeRefusal(r *http.Request) wsRefusal {
	if r.Method != http.MethodGet || !r.ProtoAtLeast(1, 1) ||
		!headerHasToken(r.Header, "Upgrade", "websocket") || !headerHasToken(r.Header, "Connection", "upgrade") {
		return wsRefusal{http.StatusUpgradeRequired, "upgrade required"}
	}
	// one line each: a second Sec-WebSocket-Version or -Key is a client whose
	// handshake two intermediaries disagree about, and reading the first would
	// let the other one's value through
	if v := r.Header.Values("Sec-WebSocket-Version"); len(v) != 1 || v[0] != "13" {
		return wsRefusal{http.StatusUpgradeRequired, "websocket version 13 is the one this server speaks"}
	}
	k := r.Header.Values("Sec-WebSocket-Key")
	if len(k) == 0 {
		return wsRefusal{http.StatusUpgradeRequired, "no Sec-WebSocket-Key on the handshake"}
	}
	if len(k) > 1 {
		return wsRefusal{http.StatusUpgradeRequired, "one Sec-WebSocket-Key, and this handshake carries more"}
	}
	// 426 as today's relay answers it, though the key is the malformed part:
	// the status a refused handshake carries is part of the wire, and the
	// sentence saying which part is wrong is borgo's own addition
	key, err := base64.StdEncoding.DecodeString(k[0])
	if err != nil || len(key) != 16 {
		return wsRefusal{http.StatusUpgradeRequired, "Sec-WebSocket-Key must be 16 bytes in base64"}
	}
	return wsRefusal{}
}

// wsCloseError ends a connection with a close code: a protocol violation, a
// message over the cap, text that is not utf-8. Never a panic, never the
// process.
type wsCloseError struct {
	code   int
	reason string
}

func (e *wsCloseError) Error() string {
	return fmt.Sprintf("websocket close %d: %s", e.code, e.reason)
}

func wsProtocolError(reason string) error {
	return &wsCloseError{code: wsCloseProtocolError, reason: reason}
}

// wsMessage is one complete data message, or one control frame.
type wsMessage struct {
	opcode  byte
	payload []byte
}

// wsReader reads client frames and assembles fragmented messages.
type wsReader struct {
	src   io.Reader
	limit int

	fragmented bool
	opcode     byte
	partial    []byte
	head       [14]byte
}

func newWSReader(src io.Reader, limit int) *wsReader {
	return &wsReader{src: src, limit: limit}
}

// next returns the next complete data message, or a control frame as soon as
// it arrives: a ping in the middle of a fragmented message is answered then,
// not after the message ends. A violation is a *wsCloseError carrying the
// code the connection must close with; anything else is the connection's own
// read error.
func (rd *wsReader) next() (wsMessage, error) {
	head := rd.head[:]
	for {
		if _, err := io.ReadFull(rd.src, head[:2]); err != nil {
			return wsMessage{}, err
		}
		fin := head[0]&0x80 != 0
		if head[0]&0x70 != 0 {
			return wsMessage{}, wsProtocolError("reserved bits set, and no extension was negotiated")
		}
		opcode := head[0] & 0x0f
		masked := head[1]&0x80 != 0
		length := uint64(head[1] & 0x7f)
		switch length {
		case 126:
			if _, err := io.ReadFull(rd.src, head[2:4]); err != nil {
				return wsMessage{}, err
			}
			length = uint64(binary.BigEndian.Uint16(head[2:4]))
			if length < 126 {
				return wsMessage{}, wsProtocolError("a length that fits in 7 bits was sent in 16")
			}
		case 127:
			if _, err := io.ReadFull(rd.src, head[2:10]); err != nil {
				return wsMessage{}, err
			}
			length = binary.BigEndian.Uint64(head[2:10])
			if length>>63 != 0 {
				return wsMessage{}, wsProtocolError("a 64-bit length with its most significant bit set")
			}
			if length <= 0xffff {
				return wsMessage{}, wsProtocolError("a length that fits in 16 bits was sent in 64")
			}
		}
		if !masked {
			return wsMessage{}, wsProtocolError("a client frame must be masked")
		}
		control := opcode >= 0x8
		if control {
			if !fin {
				return wsMessage{}, wsProtocolError("a control frame cannot be fragmented")
			}
			if length > 125 {
				return wsMessage{}, wsProtocolError("a control frame carries at most 125 bytes")
			}
		} else if uint64(len(rd.partial))+length > uint64(rd.limit) {
			// refused on the declared length, before a byte of it is read or
			// allocated: a header claiming 2^40 bytes costs nothing
			return wsMessage{}, &wsCloseError{code: wsCloseTooBig, reason: fmt.Sprintf("a message over %d bytes", rd.limit)}
		}
		var mask [4]byte
		if _, err := io.ReadFull(rd.src, mask[:]); err != nil {
			return wsMessage{}, err
		}
		// allocated as the bytes arrive, not as declared: a header claiming
		// a megabyte and sending nothing held a megabyte for the whole read
		// deadline, per socket, for 14 bytes on the wire (found by the
		// verifier of the phase)
		payload, err := wsReadPayload(rd.src, length)
		if err != nil {
			return wsMessage{}, err
		}
		for i := range payload {
			payload[i] ^= mask[i&3]
		}

		switch opcode {
		case wsOpClose, wsOpPing, wsOpPong:
			return wsMessage{opcode: opcode, payload: payload}, nil
		case wsOpText, wsOpBinary:
			if rd.fragmented {
				return wsMessage{}, wsProtocolError("a new message began before the fragmented one ended")
			}
			if fin {
				return wsComplete(opcode, payload)
			}
			rd.fragmented, rd.opcode, rd.partial = true, opcode, payload
		case wsOpContinuation:
			if !rd.fragmented {
				return wsMessage{}, wsProtocolError("a continuation frame with no message to continue")
			}
			rd.partial = append(rd.partial, payload...)
			if fin {
				opcode, whole := rd.opcode, rd.partial
				rd.fragmented, rd.opcode, rd.partial = false, 0, nil
				return wsComplete(opcode, whole)
			}
		default:
			return wsMessage{}, wsProtocolError(fmt.Sprintf("opcode %#x is not defined", opcode))
		}
	}
}

// wsReadChunk is how much a frame's payload is allocated ahead of its bytes
const wsReadChunk = 64 << 10

// wsReadPayload reads length bytes, growing the buffer as they arrive: a
// declared length is a claim, and the memory follows the bytes, not the
// claim. A message under the chunk is one allocation, as before
func wsReadPayload(src io.Reader, length uint64) ([]byte, error) {
	buf := make([]byte, 0, min(length, wsReadChunk))
	for uint64(len(buf)) < length {
		n := int(min(uint64(wsReadChunk), length-uint64(len(buf))))
		start := len(buf)
		buf = slices.Grow(buf, n)[:start+n]
		if _, err := io.ReadFull(src, buf[start:]); err != nil {
			return nil, err
		}
	}
	return buf, nil
}

func wsComplete(opcode byte, payload []byte) (wsMessage, error) {
	if opcode == wsOpText && !utf8.Valid(payload) {
		return wsMessage{}, &wsCloseError{code: wsCloseInvalidPayload, reason: "a text message that is not utf-8"}
	}
	return wsMessage{opcode: opcode, payload: payload}, nil
}

// wsCloseCode reads a close frame's payload: no payload is no status (1005,
// never sent back); one byte, a code no endpoint may send, or a reason that
// is not utf-8 is itself a violation.
func wsCloseCode(payload []byte) (int, error) {
	if len(payload) == 0 {
		return 1005, nil
	}
	if len(payload) == 1 {
		return 0, wsProtocolError("a close payload of one byte")
	}
	code := int(binary.BigEndian.Uint16(payload[:2]))
	switch {
	// 1012-1014 are registered since the RFC, and 1013 is one this server sends
	case code >= 1000 && code <= 1003, code >= 1007 && code <= 1014, code >= 3000 && code <= 4999:
	default:
		return 0, wsProtocolError(fmt.Sprintf("close code %d may not be sent", code))
	}
	if !utf8.Valid(payload[2:]) {
		return 0, &wsCloseError{code: wsCloseInvalidPayload, reason: "a close reason that is not utf-8"}
	}
	return code, nil
}

// wsFrame is one unmasked, unfragmented server frame.
func wsFrame(opcode byte, payload []byte) []byte {
	n := len(payload)
	var frame []byte
	switch {
	case n < 126:
		frame = make([]byte, 2, 2+n)
		frame[1] = byte(n)
	case n <= 0xffff:
		frame = make([]byte, 4, 4+n)
		frame[1] = 126
		binary.BigEndian.PutUint16(frame[2:], uint16(n))
	default:
		frame = make([]byte, 10, 10+n)
		frame[1] = 127
		binary.BigEndian.PutUint64(frame[2:], uint64(n))
	}
	frame[0] = 0x80 | opcode
	return append(frame, payload...)
}

// wsCloseFrame carries a code and a reason cut to fit a control frame's 125
// bytes, on a character boundary: the reason is read by a person
func wsCloseFrame(code int, reason string) []byte {
	const room = 123
	if len(reason) > room {
		cut := room
		for cut > 0 && !utf8.RuneStart(reason[cut]) {
			cut--
		}
		reason = reason[:cut]
	}
	payload := make([]byte, 2, 2+len(reason))
	binary.BigEndian.PutUint16(payload, uint16(code))
	return wsFrame(wsOpClose, append(payload, reason...))
}

// jsQuote is JSON.stringify of a string: the refusal texts are the relay's
// today, and a client or a test that reads them keeps reading the same words.
// Written out because encoding/json escapes U+2028, U+2029 and, unless told
// otherwise, <, > and &, none of which JSON.stringify touches.
func jsQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// utf16Len is a javascript string's length, which is what the client's cap
// and today's relay measure a topic by
func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// utf16Prefix is s.slice(0, n) in javascript terms, cut on a character
// boundary so the text stays readable
func utf16Prefix(s string, n int) string {
	units := 0
	for i, r := range s {
		size := utf16.RuneLen(r)
		if size < 0 {
			size = 1
		}
		if units+size > n {
			return s[:i]
		}
		units += size
	}
	return s
}

// jsTrim is String.prototype.trim: unicode whitespace and the byte-order
// mark, but not U+0085, which javascript does not count as whitespace
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return r == 0xFEFF || (unicode.IsSpace(r) && r != 0x85)
	})
}

// wsTopicSeparatorRefusal is bun's topicRejection, word for word: said on the
// handshake and on a publish alike
func wsTopicSeparatorRefusal(topic string) string {
	if !strings.Contains(topic, ",") {
		return ""
	}
	return "topic " + jsQuote(topic) + ` contains ",", which separates topics on the wire (/ws?topics=a,b) and cannot appear inside one - rename the topic`
}

// wsTopics reads the topics of a handshake as today's relay does: the first
// topics= pair of the raw query, split on the comma as written, each part
// with + as a space, percent-decoded and trimmed, empty parts skipped. A
// refusal is a 400 with these words, which today's relay also logs.
func wsTopics(rawQuery string) ([]string, string) {
	// bun reads the query off a parsed URL, so the target is normalised first:
	// a raw '#' starts a fragment, and a byte that is not utf-8 becomes U+FFFD.
	// Only a non-browser client can send either - a browser percent-encodes
	// both - but the topic a client thinks it asked for must be the topic it gets
	if cut := strings.IndexByte(rawQuery, '#'); cut >= 0 {
		rawQuery = rawQuery[:cut]
	}
	rawQuery = strings.ToValidUTF8(rawQuery, "�")
	raw := ""
	for _, pair := range strings.Split(rawQuery, "&") {
		if strings.HasPrefix(pair, "topics=") {
			raw = strings.TrimPrefix(pair, "topics=")
			break
		}
	}
	var topics []string
	for _, part := range strings.Split(raw, ",") {
		decoded, err := url.PathUnescape(strings.ReplaceAll(part, "+", " "))
		if err != nil || !utf8.ValidString(decoded) {
			return nil, "topics is not a decodable query value: " + jsQuote(utf16Prefix(part, 40))
		}
		topic := jsTrim(decoded)
		if topic == "" {
			continue
		}
		if why := wsTopicSeparatorRefusal(topic); why != "" {
			return nil, why
		}
		topics = append(topics, topic)
	}
	var refusals []string
	for _, topic := range topics {
		if n := utf16Len(topic); n > wsMaxTopicLength {
			shown := utf16Prefix(topic, 40)
			more := ""
			if shown != topic {
				more = "..."
			}
			refusals = append(refusals, fmt.Sprintf("topic %s%s is %d characters, over the %d a topic may have - shorten the name", jsQuote(shown), more, n, wsMaxTopicLength))
			break
		}
	}
	if len(topics) > wsMaxTopics {
		refusals = append(refusals, fmt.Sprintf("%d topics on one socket, over the %d it accepts - subscribe to fewer, or spread them over more sockets", len(topics), wsMaxTopics))
	}
	if len(refusals) > 0 {
		return nil, strings.Join(refusals, "; ")
	}
	return topics, ""
}

// withoutDefaultPort drops the port a scheme does not spell, as a URL parser
// does: nginx's common "proxy_set_header Host $host:$server_port" would
// otherwise make every page's own origin a foreign one, and the client treats
// the refusal as final and never redials.
func withoutDefaultPort(host, scheme string) string {
	h, port, err := net.SplitHostPort(host)
	// ":80" is a port and no host: dropping the port would leave "", which any
	// other host that normalises to nothing would then equal
	if err != nil || h == "" {
		return host
	}
	switch {
	case strings.EqualFold(scheme, "http") && port == "80":
	case strings.EqualFold(scheme, "https") && port == "443":
	default:
		return host
	}
	if strings.Contains(h, ":") {
		// an ipv6 literal is spelled with its brackets everywhere else
		return "[" + h + "]"
	}
	return h
}

// wsOriginRefusal is why a handshake's Origin is not this server, or "".
// Scheme and host, not host alone, and no Origin at all is a refusal unless
// BORGO_WS_ALLOW_NO_ORIGIN admits it: browsers attach cookies to a websocket
// handshake from any page, so this is the guard. The scheme a proxy declares
// is believed only from a trusted proxy - today's relay believed it from
// anyone, reasoning that whoever sets it sets Origin too; here the rule is the
// front's, one rule for every forwarded fact.
//
// That one rule also makes this deliberately more permissive than bun in one
// place, and a parity run will find it: behind a TLS-terminating proxy that
// declares https, bun compares the origin against the host of its own
// cleartext listener and refuses the page's own origin, while here the
// declared scheme decides both the comparison and which port is the default.
// What the wider set admits is the page's own origin spelled with or without
// that port, and nothing else - the scheme still has to match.
func wsOriginRefusal(r *http.Request, trusted []*net.IPNet, allowNoOrigin bool) string {
	values, present := r.Header["Origin"]
	if !present {
		if allowNoOrigin {
			return ""
		}
		return "no Origin header on the handshake: a non-browser client needs BORGO_WS_ALLOW_NO_ORIGIN=1"
	}
	// two Origin lines read as one value, as fetch's Headers.get joins them,
	// and no single origin is that
	origin := strings.Join(values, ", ")
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if peerTrusted(r.RemoteAddr, trusted) {
		if declared := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); declared != "" {
			scheme = declared
		}
	}
	// url.Parse is stricter than a browser's URL parser on spellings a browser
	// never sends ("http:app.test", an empty or zero-padded port, an ipv6
	// address written another way): refusing more of those costs nothing, since
	// a client that can choose its Origin can choose a matching one anyway
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || !strings.EqualFold(withoutDefaultPort(u.Host, scheme), withoutDefaultPort(r.Host, scheme)) ||
		!strings.EqualFold(u.Scheme, scheme) {
		return fmt.Sprintf("origin %s is not this server (%s): /ws accepts the page's own origin only", jsQuote(utf16Prefix(origin, 80)), r.Host)
	}
	return ""
}
