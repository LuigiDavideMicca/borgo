package borgo

import (
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestWSAcceptIsTheRFCVector(t *testing.T) {
	// RFC 6455 section 1.3
	if got := wsAccept("dGhlIHNhbXBsZSBub25jZQ=="); got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("accept for the rfc's key is %q", got)
	}
}

func wsHandshakeRequest() *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/ws?topics=a", nil)
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Connection", "keep-alive, Upgrade")
	r.Header.Set("Sec-WebSocket-Version", "13")
	r.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	return r
}

func TestWSHandshakeRefusals(t *testing.T) {
	key := func(n int) string { return base64.StdEncoding.EncodeToString(make([]byte, n)) }
	cases := []struct {
		name   string
		edit   func(r *http.Request)
		status int
	}{
		{"a complete handshake", func(*http.Request) {}, 0},
		{"the upgrade token in any case", func(r *http.Request) { r.Header.Set("Upgrade", "WebSocket") }, 0},
		{"connection over two header lines", func(r *http.Request) {
			r.Header.Del("Connection")
			r.Header.Add("Connection", "keep-alive")
			r.Header.Add("Connection", "UPGRADE")
		}, 0},
		{"a post", func(r *http.Request) { r.Method = http.MethodPost }, http.StatusUpgradeRequired},
		{"http/1.0", func(r *http.Request) { r.Proto, r.ProtoMajor, r.ProtoMinor = "HTTP/1.0", 1, 0 }, http.StatusUpgradeRequired},
		{"no upgrade header", func(r *http.Request) { r.Header.Del("Upgrade") }, http.StatusUpgradeRequired},
		{"an upgrade to something else", func(r *http.Request) { r.Header.Set("Upgrade", "h2c") }, http.StatusUpgradeRequired},
		{"connection without upgrade", func(r *http.Request) { r.Header.Set("Connection", "keep-alive") }, http.StatusUpgradeRequired},
		{"upgrade only inside a longer token", func(r *http.Request) { r.Header.Set("Connection", "upgraded") }, http.StatusUpgradeRequired},
		{"version 8", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Version", "8") }, http.StatusUpgradeRequired},
		{"no version", func(r *http.Request) { r.Header.Del("Sec-WebSocket-Version") }, http.StatusUpgradeRequired},
		{"no key", func(r *http.Request) { r.Header.Del("Sec-WebSocket-Key") }, http.StatusUpgradeRequired},
		{"a key that is not base64", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Key", "not base64!") }, http.StatusUpgradeRequired},
		{"a key of 15 bytes", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Key", key(15)) }, http.StatusUpgradeRequired},
		{"a key of 17 bytes", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Key", key(17)) }, http.StatusUpgradeRequired},
		// two intermediaries disagreeing about the handshake: reading the first
		// line would let the other one's value through
		{"two version lines", func(r *http.Request) { r.Header.Add("Sec-WebSocket-Version", "8") }, http.StatusUpgradeRequired},
		{"two key lines, the valid one first", func(r *http.Request) { r.Header.Add("Sec-WebSocket-Key", "not base64!") }, http.StatusUpgradeRequired},
		{"two key lines, the valid one second", func(r *http.Request) {
			r.Header.Set("Sec-WebSocket-Key", "not base64!")
			r.Header.Add("Sec-WebSocket-Key", key(16))
		}, http.StatusUpgradeRequired},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := wsHandshakeRequest()
			tc.edit(r)
			got := wsHandshakeRefusal(r)
			if got.status != tc.status {
				t.Fatalf("status %d (%q), want %d", got.status, got.reason, tc.status)
			}
			if (got.status == 0) != (got.reason == "") {
				t.Fatalf("status %d with reason %q", got.status, got.reason)
			}
		})
	}
}

// testFrame is a client frame as the test wants it, including the ways a
// client can get one wrong
type testFrame struct {
	fin      bool
	rsv      byte // the three reserved bits, 0-7
	opcode   byte
	payload  []byte
	unmasked bool
	form     int    // 7, 16 or 64: how the length is written; 0 is the minimal form
	declared uint64 // the length the header claims, when not the payload's
}

func (f testFrame) bytes() []byte {
	first := f.opcode | f.rsv<<4
	if f.fin {
		first |= 0x80
	}
	n := uint64(len(f.payload))
	if f.declared != 0 {
		n = f.declared
	}
	maskBit := byte(0x80)
	if f.unmasked {
		maskBit = 0
	}
	form := f.form
	if form == 0 {
		switch {
		case n < 126:
			form = 7
		case n <= 0xffff:
			form = 16
		default:
			form = 64
		}
	}
	b := []byte{first}
	switch form {
	case 7:
		b = append(b, maskBit|byte(n))
	case 16:
		b = append(b, maskBit|126)
		b = binary.BigEndian.AppendUint16(b, uint16(n))
	case 64:
		b = append(b, maskBit|127)
		b = binary.BigEndian.AppendUint64(b, n)
	}
	if f.unmasked {
		return append(b, f.payload...)
	}
	mask := [4]byte{0x37, 0xfa, 0x21, 0x3d}
	b = append(b, mask[:]...)
	for i, c := range f.payload {
		b = append(b, c^mask[i&3])
	}
	return b
}

func textFrame(s string) testFrame {
	return testFrame{fin: true, opcode: wsOpText, payload: []byte(s)}
}

func frameStream(frames ...testFrame) []byte {
	var b []byte
	for _, f := range frames {
		b = append(b, f.bytes()...)
	}
	return b
}

func readFrames(input []byte, limit int) ([]wsMessage, error) {
	rd := newWSReader(bytes.NewReader(input), limit)
	var got []wsMessage
	for {
		m, err := rd.next()
		if err != nil {
			return got, err
		}
		got = append(got, m)
	}
}

func closeCodeOf(err error) int {
	var ce *wsCloseError
	if errors.As(err, &ce) {
		return ce.code
	}
	return 0
}

func TestWSReaderReadsEveryLengthForm(t *testing.T) {
	for _, n := range []int{0, 1, 125, 126, 127, 0xffff, 0x10000, 70000} {
		payload := strings.Repeat("a", n)
		got, err := readFrames(textFrame(payload).bytes(), wsMaxMessage)
		if err != io.EOF {
			t.Fatalf("%d bytes: ended with %v", n, err)
		}
		if len(got) != 1 || got[0].opcode != wsOpText || string(got[0].payload) != payload {
			t.Fatalf("%d bytes: read %d messages", n, len(got))
		}
	}
}

func TestWSReaderAssemblesFragmentsAndAnswersControlsBetweenThem(t *testing.T) {
	e := []byte("é")
	got, err := readFrames(frameStream(
		testFrame{opcode: wsOpText, payload: []byte("hel")},
		testFrame{fin: true, opcode: wsOpPing, payload: []byte("p")},
		testFrame{opcode: wsOpContinuation, payload: []byte("lo w")},
		// a character split across two frames is valid once joined
		testFrame{opcode: wsOpContinuation, payload: e[:1]},
		testFrame{fin: true, opcode: wsOpContinuation, payload: append(e[1:], "rld"...)},
		testFrame{fin: true, opcode: wsOpBinary, payload: []byte{0xff, 0x00}},
		testFrame{fin: true, opcode: wsOpPong},
	), wsMaxMessage)
	if err != io.EOF {
		t.Fatalf("ended with %v", err)
	}
	want := []wsMessage{
		{wsOpPing, []byte("p")},
		{wsOpText, []byte("hello wérld")},
		{wsOpBinary, []byte{0xff, 0x00}},
		{wsOpPong, []byte{}},
	}
	if len(got) != len(want) {
		t.Fatalf("read %d messages, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i].opcode != want[i].opcode || !bytes.Equal(got[i].payload, want[i].payload) {
			t.Errorf("message %d is %#x %q, want %#x %q", i, got[i].opcode, got[i].payload, want[i].opcode, want[i].payload)
		}
	}
}

func TestWSReaderTakesAMessageOfExactlyTheLimit(t *testing.T) {
	got, err := readFrames(frameStream(
		testFrame{opcode: wsOpText, payload: []byte("12345678")},
		testFrame{fin: true, opcode: wsOpContinuation, payload: []byte("abcdefgh")},
	), 16)
	if err != io.EOF || len(got) != 1 || len(got[0].payload) != 16 {
		t.Fatalf("a 16-byte message under a 16-byte limit: %d messages, %v", len(got), err)
	}
}

func TestWSReaderClosesOnEveryViolation(t *testing.T) {
	cases := []struct {
		name  string
		input []byte
		code  int
	}{
		{"an unmasked frame", testFrame{fin: true, opcode: wsOpText, payload: []byte("hi"), unmasked: true}.bytes(), wsCloseProtocolError},
		{"rsv1 with no extension", testFrame{fin: true, rsv: 4, opcode: wsOpText, payload: []byte("hi")}.bytes(), wsCloseProtocolError},
		{"rsv3 with no extension", testFrame{fin: true, rsv: 1, opcode: wsOpText, payload: []byte("hi")}.bytes(), wsCloseProtocolError},
		{"125 bytes written in 16", testFrame{fin: true, opcode: wsOpBinary, payload: make([]byte, 125), form: 16}.bytes(), wsCloseProtocolError},
		{"65535 bytes written in 64", testFrame{fin: true, opcode: wsOpBinary, payload: make([]byte, 0xffff), form: 64}.bytes(), wsCloseProtocolError},
		{"a 64-bit length with the top bit set", testFrame{fin: true, opcode: wsOpBinary, declared: 1 << 63, form: 64}.bytes(), wsCloseProtocolError},
		{"a ping of 126 bytes", testFrame{fin: true, opcode: wsOpPing, payload: make([]byte, 126)}.bytes(), wsCloseProtocolError},
		{"a fragmented close", testFrame{opcode: wsOpClose, payload: []byte{3, 232}}.bytes(), wsCloseProtocolError},
		{"a fragmented ping", testFrame{opcode: wsOpPing}.bytes(), wsCloseProtocolError},
		{"a continuation with nothing to continue", testFrame{fin: true, opcode: wsOpContinuation, payload: []byte("x")}.bytes(), wsCloseProtocolError},
		{"a text inside a fragmented text", frameStream(
			testFrame{opcode: wsOpText, payload: []byte("a")}, textFrame("b"),
		), wsCloseProtocolError},
		{"a binary inside a fragmented text", frameStream(
			testFrame{opcode: wsOpText, payload: []byte("a")}, testFrame{fin: true, opcode: wsOpBinary, payload: []byte("b")},
		), wsCloseProtocolError},
		{"opcode 0x3", testFrame{fin: true, opcode: 0x3}.bytes(), wsCloseProtocolError},
		{"opcode 0xb", testFrame{fin: true, opcode: 0xb}.bytes(), wsCloseProtocolError},
		{"a message over the limit", textFrame(strings.Repeat("a", 17)).bytes(), wsCloseTooBig},
		{"fragments that sum over the limit", frameStream(
			testFrame{opcode: wsOpText, payload: make([]byte, 10)},
			testFrame{fin: true, opcode: wsOpContinuation, payload: make([]byte, 7)},
		), wsCloseTooBig},
		// only the header is on the wire: a reader that read or allocated the
		// claimed terabyte before refusing would end on the stream instead
		{"a header claiming a terabyte", testFrame{fin: true, opcode: wsOpBinary, declared: 1 << 40}.bytes()[:10], wsCloseTooBig},
		{"text that is not utf-8", textFrame("\xff").bytes(), wsCloseInvalidPayload},
		{"text split into fragments that is not utf-8 joined", frameStream(
			testFrame{opcode: wsOpText, payload: []byte("\xe2\x82")},
			testFrame{fin: true, opcode: wsOpContinuation, payload: []byte("\x28")},
		), wsCloseInvalidPayload},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := readFrames(tc.input, 16)
			if len(got) != 0 {
				t.Errorf("delivered %d messages before refusing", len(got))
			}
			if code := closeCodeOf(err); code != tc.code {
				t.Fatalf("ended with %v (code %d), want %d", err, code, tc.code)
			}
		})
	}
	// and the 16-byte limit is not what refused the frames above that are larger
	if _, err := readFrames(testFrame{fin: true, opcode: wsOpBinary, payload: make([]byte, 125), form: 16}.bytes(), wsMaxMessage); closeCodeOf(err) != wsCloseProtocolError {
		t.Fatalf("a non-minimal length under the real limit: %v", err)
	}
}

func TestWSReaderEndsOnTheStreamWhenAFrameIsCut(t *testing.T) {
	whole := frameStream(textFrame(strings.Repeat("z", 200)))
	for cut := 1; cut < len(whole); cut++ {
		got, err := readFrames(whole[:cut], wsMaxMessage)
		if len(got) != 0 || closeCodeOf(err) != 0 || (err != io.EOF && err != io.ErrUnexpectedEOF) {
			t.Fatalf("cut at %d: %d messages, %v", cut, len(got), err)
		}
	}
}

func TestWSCloseCodes(t *testing.T) {
	payload := func(code int, reason string) []byte {
		return append(binary.BigEndian.AppendUint16(nil, uint16(code)), reason...)
	}
	cases := []struct {
		name    string
		payload []byte
		code    int // the code read, or the code the connection closes with
		refused bool
	}{
		{"no payload", nil, 1005, false},
		{"one byte", []byte{3}, wsCloseProtocolError, true},
		{"1000 with a reason", payload(1000, "bye"), 1000, false},
		{"1001", payload(1001, ""), 1001, false},
		{"1003", payload(1003, ""), 1003, false},
		{"1004, reserved", payload(1004, ""), wsCloseProtocolError, true},
		{"1005, never sent", payload(1005, ""), wsCloseProtocolError, true},
		{"1006, never sent", payload(1006, ""), wsCloseProtocolError, true},
		{"1007", payload(1007, ""), 1007, false},
		{"1011", payload(1011, ""), 1011, false},
		{"1013", payload(1013, ""), 1013, false},
		{"1014", payload(1014, ""), 1014, false},
		{"1015, never sent", payload(1015, ""), wsCloseProtocolError, true},
		{"999", payload(999, ""), wsCloseProtocolError, true},
		{"2999", payload(2999, ""), wsCloseProtocolError, true},
		{"3000", payload(3000, ""), 3000, false},
		{"4999", payload(4999, ""), 4999, false},
		{"5000", payload(5000, ""), wsCloseProtocolError, true},
		{"a reason that is not utf-8", payload(1000, "\xff"), wsCloseInvalidPayload, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, err := wsCloseCode(tc.payload)
			if tc.refused {
				if got := closeCodeOf(err); got != tc.code {
					t.Fatalf("refused with %v (code %d), want %d", err, got, tc.code)
				}
				return
			}
			if err != nil || code != tc.code {
				t.Fatalf("read %d, %v; want %d", code, err, tc.code)
			}
		})
	}
}

func TestWSServerFramesUseTheMinimalLengthAndNoMask(t *testing.T) {
	for _, n := range []int{0, 125, 126, 0xffff, 0x10000} {
		payload := bytes.Repeat([]byte{'q'}, n)
		frame := wsFrame(wsOpText, payload)
		if frame[0] != 0x81 {
			t.Fatalf("%d bytes: first byte %#x", n, frame[0])
		}
		if frame[1]&0x80 != 0 {
			t.Fatalf("%d bytes: a server frame is masked", n)
		}
		var length uint64
		var head int
		switch l := frame[1] & 0x7f; {
		case n < 126:
			length, head = uint64(l), 2
		case n <= 0xffff:
			if l != 126 {
				t.Fatalf("%d bytes: length marker %d", n, l)
			}
			length, head = uint64(binary.BigEndian.Uint16(frame[2:])), 4
		default:
			if l != 127 {
				t.Fatalf("%d bytes: length marker %d", n, l)
			}
			length, head = binary.BigEndian.Uint64(frame[2:]), 10
		}
		if length != uint64(n) || len(frame) != head+n || !bytes.Equal(frame[head:], payload) {
			t.Fatalf("%d bytes: header says %d, frame is %d bytes", n, length, len(frame))
		}
	}
}

func TestWSCloseFrameFitsAControlFrameAndKeepsTheReasonReadable(t *testing.T) {
	cases := []struct {
		reason string
		kept   string
	}{
		{"topic refused", "topic refused"},
		{strings.Repeat("a", 123), strings.Repeat("a", 123)},
		{strings.Repeat("a", 124), strings.Repeat("a", 123)},
		// two bytes a character: 61 fit whole, and the 62nd is not cut in half
		{strings.Repeat("è", 100), strings.Repeat("è", 61)},
	}
	for _, tc := range cases {
		frame := wsCloseFrame(wsCloseOriginRefused, tc.reason)
		if frame[0] != 0x88 || int(frame[1]) != len(frame)-2 || len(frame)-2 > 125 {
			t.Fatalf("a close frame of %d bytes with header %#x %d", len(frame), frame[0], frame[1])
		}
		code, err := wsCloseCode(frame[2:])
		if err != nil || code != wsCloseOriginRefused {
			t.Fatalf("the frame reads back as %d, %v", code, err)
		}
		if got := string(frame[4:]); got != tc.kept {
			t.Errorf("reason kept as %q, want %q", got, tc.kept)
		}
	}
}

func FuzzWSReader(f *testing.F) {
	f.Add(frameStream(textFrame("hello")))
	f.Add(frameStream(
		testFrame{opcode: wsOpText, payload: []byte("he")},
		testFrame{fin: true, opcode: wsOpPing, payload: []byte("x")},
		testFrame{fin: true, opcode: wsOpContinuation, payload: []byte("llo")},
	))
	f.Add(frameStream(testFrame{fin: true, opcode: wsOpBinary, payload: make([]byte, 300)}))
	f.Add(frameStream(testFrame{fin: true, opcode: wsOpClose, payload: []byte{0x03, 0xe8, 'o', 'k'}}))
	f.Add([]byte{0x81, 0xff, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 1, 2, 3, 4})
	f.Fuzz(func(t *testing.T, input []byte) {
		const limit = 256
		rd := newWSReader(bytes.NewReader(input), limit)
		for {
			m, err := rd.next()
			if err != nil {
				var ce *wsCloseError
				switch {
				case errors.As(err, &ce):
					if ce.code != wsCloseProtocolError && ce.code != wsCloseInvalidPayload && ce.code != wsCloseTooBig {
						t.Fatalf("closed with %d", ce.code)
					}
					if frame := wsCloseFrame(ce.code, ce.reason); len(frame) > 127 {
						t.Fatalf("a close frame of %d bytes", len(frame))
					}
				case err != io.EOF && err != io.ErrUnexpectedEOF:
					t.Fatalf("ended with %v", err)
				}
				return
			}
			switch m.opcode {
			case wsOpClose, wsOpPing, wsOpPong:
				if len(m.payload) > 125 {
					t.Fatalf("a control frame of %d bytes", len(m.payload))
				}
			case wsOpText, wsOpBinary:
				if len(m.payload) > limit {
					t.Fatalf("a message of %d bytes over a limit of %d", len(m.payload), limit)
				}
				if m.opcode == wsOpText && !utf8.Valid(m.payload) {
					t.Fatalf("text that is not utf-8: %q", m.payload)
				}
			default:
				t.Fatalf("delivered opcode %#x", m.opcode)
			}
		}
	})
}

func TestWSTopicsAreReadAsTodaysRelayReadsThem(t *testing.T) {
	list := func(n int, prefix string) string {
		parts := make([]string, n)
		for i := range parts {
			parts[i] = fmt.Sprintf("%s%d", prefix, i)
		}
		return strings.Join(parts, ",")
	}
	emoji := strings.Repeat("😀", 65) // 130 utf-16 units
	cases := []struct {
		name    string
		query   string
		topics  []string
		refusal string
	}{
		{"no query", "", nil, ""},
		{"an empty value", "topics=", nil, ""},
		{"two topics", "topics=a,b", []string{"a", "b"}, ""},
		{"the first topics pair, decoded and trimmed", "x=1&topics=a%20b,+c+&topics=z", []string{"a b", "c"}, ""},
		{"a longer name is not the pair", "topicsx=a&topics=b", []string{"b"}, ""},
		{"empty parts skipped", "topics=a,,%20,b", []string{"a", "b"}, ""},
		{"a colon", "topics=chat%3Aroom", []string{"chat:room"}, ""},
		{"utf-8", "topics=%E2%9C%93", []string{"✓"}, ""},
		{"nbsp and bom trimmed", "topics=%C2%A0a%EF%BB%BF", []string{"a"}, ""},
		// a raw '#' or a byte that is not utf-8 reaches here only from a
		// non-browser client, and is read as the url parser in front of today's
		// relay reads it: a fragment, and the replacement character
		{"a raw fragment marker", "topics=a#b", []string{"a"}, ""},
		{"a raw fragment marker after two topics", "topics=a,b#c", []string{"a", "b"}, ""},
		{"a raw byte that is not utf-8", "topics=\xff", []string{"�"}, ""},
		{"next-line kept, as javascript keeps it", "topics=%C2%85a", []string{"a"}, ""},
		{"a broken escape", "topics=ok,%zz", nil, `topics is not a decodable query value: "%zz"`},
		{"an escape that is not utf-8", "topics=%FF", nil, `topics is not a decodable query value: "%FF"`},
		{"a broken escape, shown to 40", "topics=%zz" + strings.Repeat("a", 50), nil,
			`topics is not a decodable query value: "%zz` + strings.Repeat("a", 37) + `"`},
		{"a comma decoded inside a topic", "topics=a%2Cb", nil,
			`topic "a,b" contains ",", which separates topics on the wire (/ws?topics=a,b) and cannot appear inside one - rename the topic`},
		{"32 topics", "topics=" + list(32, "t"), strings.Split(list(32, "t"), ","), ""},
		{"33 topics", "topics=" + list(33, "t"), nil,
			"33 topics on one socket, over the 32 it accepts - subscribe to fewer, or spread them over more sockets"},
		{"128 characters", "topics=" + strings.Repeat("a", 128), []string{strings.Repeat("a", 128)}, ""},
		{"129 characters", "topics=" + strings.Repeat("a", 129), nil,
			`topic "` + strings.Repeat("a", 40) + `"... is 129 characters, over the 128 a topic may have - shorten the name`},
		{"characters counted as javascript counts them", "topics=" + strings.Repeat("%F0%9F%98%80", 65), nil,
			`topic "` + strings.Repeat("😀", 20) + `"... is 130 characters, over the 128 a topic may have - shorten the name`},
		{"64 emoji fit", "topics=" + strings.Repeat("%F0%9F%98%80", 64), []string{emoji[:len(emoji)-4]}, ""},
		{"both refusals", "topics=" + list(32, "t") + "," + strings.Repeat("b", 130), nil,
			`topic "` + strings.Repeat("b", 40) + `"... is 130 characters, over the 128 a topic may have - shorten the name; ` +
				"33 topics on one socket, over the 32 it accepts - subscribe to fewer, or spread them over more sockets"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			topics, refusal := wsTopics(tc.query)
			if refusal != tc.refusal {
				t.Fatalf("refusal\n got %q\nwant %q", refusal, tc.refusal)
			}
			if strings.Join(topics, "\x00") != strings.Join(tc.topics, "\x00") || len(topics) != len(tc.topics) {
				t.Fatalf("topics %q, want %q", topics, tc.topics)
			}
		})
	}
}

func TestJSQuoteIsJSONStringify(t *testing.T) {
	cases := map[string]string{
		"plain":      `"plain"`,
		`a"b\c`:      `"a\"b\\c"`,
		"\b\f\n\r\t": `"\b\f\n\r\t"`,
		"\x00\x1f":   `"` + string(rune(92)) + `u0000` + string(rune(92)) + `u001f"`,
		"<a>&  ":     "\"<a>&  \"",
		"\x7f é":     "\"\x7f é\"",
	}
	for in, want := range cases {
		if got := jsQuote(in); got != want {
			t.Errorf("jsQuote(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWSOriginRefusal(t *testing.T) {
	_, proxy, _ := net.ParseCIDR("10.0.0.0/8")
	trusted := []*net.IPNet{proxy}
	notThis := func(origin string) string {
		return fmt.Sprintf("origin %s is not this server (app.test): /ws accepts the page's own origin only", jsQuote(origin))
	}
	long := "http://" + strings.Repeat("x", 200)
	cases := []struct {
		name    string
		remote  string
		origins []string // nil: no Origin header
		proto   string
		tls     bool
		allow   bool
		refusal string
	}{
		{"no origin", "203.0.113.9:1", nil, "", false, false,
			"no Origin header on the handshake: a non-browser client needs BORGO_WS_ALLOW_NO_ORIGIN=1"},
		{"no origin, admitted", "203.0.113.9:1", nil, "", false, true, ""},
		{"the page's own origin", "203.0.113.9:1", []string{"http://app.test"}, "", false, false, ""},
		{"the host in another case", "203.0.113.9:1", []string{"http://APP.test"}, "", false, false, ""},
		{"admitting no origin admits no other", "203.0.113.9:1", []string{"http://evil.test"}, "", false, true, notThis("http://evil.test")},
		{"https against a cleartext connection", "203.0.113.9:1", []string{"https://app.test"}, "", false, false, notThis("https://app.test")},
		{"a suffix of the host", "203.0.113.9:1", []string{"http://app.test.evil.test"}, "", false, false, notThis("http://app.test.evil.test")},
		{"another port", "203.0.113.9:1", []string{"http://app.test:8080"}, "", false, false, notThis("http://app.test:8080")},
		{"a sandboxed page", "203.0.113.9:1", []string{"null"}, "", false, false, notThis("null")},
		{"an empty origin", "203.0.113.9:1", []string{""}, "", false, false, notThis("")},
		{"two origin lines", "203.0.113.9:1", []string{"http://app.test", "http://app.test"}, "", false, false, notThis("http://app.test, http://app.test")},
		{"https declared by a trusted proxy", "10.1.2.3:1", []string{"https://app.test"}, "https", false, false, ""},
		{"the first declared scheme, trimmed, in any case", "10.1.2.3:1", []string{"https://app.test"}, " HTTPS , http", false, false, ""},
		{"https declared by anyone else", "203.0.113.9:1", []string{"https://app.test"}, "https", false, false, notThis("https://app.test")},
		{"a cleartext origin behind a proxy that says https", "10.1.2.3:1", []string{"http://app.test"}, "https", false, false, notThis("http://app.test")},
		{"https on the connection itself", "203.0.113.9:1", []string{"https://app.test"}, "", true, false, ""},
		{"a long origin, shown to 80", "203.0.113.9:1", []string{long}, "", false, false, notThis(long[:80])},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "http://app.test/ws", nil)
			r.RemoteAddr = tc.remote
			for _, o := range tc.origins {
				r.Header.Add("Origin", o)
			}
			if tc.proto != "" {
				r.Header.Set("X-Forwarded-Proto", tc.proto)
			}
			if tc.tls {
				r.TLS = &tls.ConnectionState{}
			}
			if got := wsOriginRefusal(r, trusted, tc.allow); got != tc.refusal {
				t.Fatalf("refusal\n got %q\nwant %q", got, tc.refusal)
			}
		})
	}
}

// the port a scheme does not spell is not part of the host: nginx's common
// "proxy_set_header Host $host:$server_port" would otherwise make every page's
// own origin foreign, and the client treats that refusal as final
func TestWSOriginAcceptsTheSchemesDefaultPort(t *testing.T) {
	cases := []struct {
		name, host, origin string
		tls                bool
		refused            bool
	}{
		{"the port in Host only", "app.test:80", "http://app.test", false, false},
		{"the port in Origin only", "app.test", "http://app.test:80", false, false},
		{"the port on both sides", "app.test:80", "http://app.test:80", false, false},
		{"443 in Host, over tls", "app.test:443", "https://app.test", true, false},
		{"443 in Origin, over tls", "app.test", "https://app.test:443", true, false},
		{"an ipv6 host keeping its brackets", "[::1]:80", "http://[::1]", false, false},
		{"the http port under https", "app.test:443", "https://app.test:80", true, true},
		{"a port the scheme does spell", "app.test:8080", "http://app.test", false, true},
		{"443 without tls", "app.test:443", "http://app.test", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/ws", nil)
			r.Host = tc.host
			r.Header.Set("Origin", tc.origin)
			if tc.tls {
				r.TLS = &tls.ConnectionState{}
			}
			refusal := wsOriginRefusal(r, nil, false)
			if tc.refused != (refusal != "") {
				t.Fatalf("Host %q, Origin %q: refusal %q", tc.host, tc.origin, refusal)
			}
		})
	}
}

// an origin with no host never matches, not even a request that lost its own:
// "http://" against an empty Host would otherwise compare equal
func TestWSOriginWithNoHostIsRefused(t *testing.T) {
	// a request can reach a handler with no Host at all (net/http refuses an
	// absent header, not an empty one), and a bare ":80" is a port with no host
	for _, tc := range []struct{ host, origin string }{
		{"", "http://"},
		{"", "http://:80"},
		{":80", "http://"},
	} {
		r := httptest.NewRequest(http.MethodGet, "/ws", nil)
		r.Host = tc.host
		r.Header.Set("Origin", tc.origin)
		if wsOriginRefusal(r, nil, false) == "" {
			t.Errorf("Host %q admitted origin %q", tc.host, tc.origin)
		}
	}
}

// the refusal is read in a log by whoever is trying to connect: it must say
// which way the handshake is wrong
func TestWSKeyRefusalsSayWhichWay(t *testing.T) {
	none := wsHandshakeRequest()
	none.Header.Del("Sec-WebSocket-Key")
	many := wsHandshakeRequest()
	many.Header.Add("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	if got := wsHandshakeRefusal(none).reason; got != "no Sec-WebSocket-Key on the handshake" {
		t.Errorf("a handshake with no key is refused with %q", got)
	}
	if got := wsHandshakeRefusal(many).reason; !strings.Contains(got, "carries more") {
		t.Errorf("a handshake with two keys is refused with %q", got)
	}
}

// the client refuses a long topic before dialling, and treats 4403 as final:
// the two sides are separate languages, so the numbers are read from source
func TestWSConstantsMatchTheClient(t *testing.T) {
	src, err := os.ReadFile("packages/borgo/src/index.ts")
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]int{
		"CLOSE_ORIGIN_REFUSED": wsCloseOriginRefused,
		"MAX_TOPIC_LENGTH":     wsMaxTopicLength,
	} {
		m := regexp.MustCompile(`(?m)^const ` + name + ` = (\d+);`).FindSubmatch(src)
		if m == nil {
			t.Fatalf("index.ts no longer declares %s", name)
		}
		if string(m[1]) != fmt.Sprint(want) {
			t.Errorf("the client's %s is %s, the server's %d", name, m[1], want)
		}
	}
}
