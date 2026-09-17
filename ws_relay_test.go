package borgo

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// a dev relay unless configured otherwise: with no CanSubscribe registered a
// production relay admits nothing, and these tests are about the relay
func startRelay(t *testing.T, configure func(r *wsRelay)) (*wsRelay, string) {
	t.Helper()
	relay := newWSRelay(wsRelayOptions{dev: true})
	if configure != nil {
		configure(relay)
	}
	srv := &http.Server{Handler: relay}
	armStreamShutdown(srv)
	base := serveOn(t, srv)
	t.Cleanup(func() { srv.Close() })
	return relay, base
}

func relayRequest(query, origin string, extra string) []byte {
	return []byte("GET /ws?" + query + " HTTP/1.1\r\nHost: app.test\r\nOrigin: " + origin + "\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" + extra + "\r\n")
}

func joinRelay(t *testing.T, base, query string) *wsPeer {
	t.Helper()
	p := dialWSRaw(t, base, relayRequest(query, "http://app.test", "Sec-WebSocket-Version: 13\r\n"))
	if p.res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("?%s answered %d", query, p.res.StatusCode)
	}
	return p
}

func (p *wsPeer) publish(msg string) {
	p.t.Helper()
	p.send(textFrame(msg))
}

// nextEvent is the next event that is not a count
func (p *wsPeer) nextEvent(within time.Duration) string {
	p.t.Helper()
	for {
		f := p.nextData(within)
		if f.opcode != wsOpText {
			p.t.Fatalf("expected an event, got %#x %q", f.opcode, f.payload)
		}
		if !strings.Contains(string(f.payload), `"event":"__count"`) {
			return string(f.payload)
		}
	}
}

func countFrame(topic string, n int) string {
	return fmt.Sprintf(`{"topic":%s,"event":"__count","data":%d}`, jsQuote(topic), n)
}

// awaitCount reads until this socket is told the topic holds n subscribers
func (p *wsPeer) awaitCount(topic string, n int, within time.Duration) {
	p.t.Helper()
	want := countFrame(topic, n)
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		f, err := p.next(time.Until(deadline))
		if err != nil {
			break
		}
		if string(f.payload) == want {
			return
		}
	}
	p.t.Fatalf("never told %s", want)
}

func TestWSEventFrameIsWhatBunWrote(t *testing.T) {
	cases := []struct {
		topic, event string
		data         json.RawMessage
		want         string
	}{
		{"a", "say", json.RawMessage(`{"x":"<b>&"}`), `{"topic":"a","event":"say","data":{"x":"<b>&"}}`},
		// JSON.stringify leaves out a key whose value is undefined
		{"a", "ping", nil, `{"topic":"a","event":"ping"}`},
		{"a", "none", json.RawMessage(`null`), `{"topic":"a","event":"none","data":null}`},
		{"a", "spaced", json.RawMessage("{ \"k\" :\n[1, 2] }"), `{"topic":"a","event":"spaced","data":{"k":[1,2]}}`},
		{"<t>", "é", json.RawMessage(`1`), `{"topic":"<t>","event":"é","data":1}`},
	}
	for _, tc := range cases {
		frame, err := wsEventFrame(tc.topic, jsonText(tc.event), tc.data)
		if err != nil {
			t.Fatal(err)
		}
		if frame[0] != 0x81 || int(frame[1]) != len(frame)-2 {
			t.Fatalf("not one short text frame: % x", frame[:2])
		}
		if got := string(frame[2:]); got != tc.want {
			t.Errorf("\n got %s\nwant %s", got, tc.want)
		}
	}
}

func TestWSRelayDeliversToItsSubscribersAndEchoesTheSender(t *testing.T) {
	_, base := startRelay(t, nil)
	p := joinRelay(t, base, "topics=a")
	q := joinRelay(t, base, "topics=a,b")
	o := joinRelay(t, base, "topics=b")
	p.awaitCount("a", 2, 2*time.Second)
	q.awaitCount("b", 2, 2*time.Second)
	o.awaitCount("b", 2, 2*time.Second)

	p.publish(`{"topic":"a","event":"say","data":{"x":"<1>"},"extra":true}`)
	want := `{"topic":"a","event":"say","data":{"x":"<1>"}}`
	if got := p.nextEvent(2 * time.Second); got != want {
		t.Errorf("the sender's echo: %s", got)
	}
	if got := q.nextEvent(2 * time.Second); got != want {
		t.Errorf("the other subscriber: %s", got)
	}
	// o holds only b: the first event it sees is the one sent there
	q.publish(`{"topic":"b","event":"only-b"}`)
	if got := o.nextEvent(2 * time.Second); got != `{"topic":"b","event":"only-b"}` {
		t.Errorf("a socket on b alone was sent %s", got)
	}
}

// what bun's JSON.parse would have read: the last of two keys, and a binary
// message as a string
func TestWSRelayReadsMessagesAsJSONParseDoes(t *testing.T) {
	_, base := startRelay(t, nil)
	p := joinRelay(t, base, "topics=a")
	q := joinRelay(t, base, "topics=a")
	q.awaitCount("a", 2, 2*time.Second)

	p.publish(`{"topic":"a","event":"one","event":"two","data":1,"data":2}`)
	if got := q.nextEvent(2 * time.Second); got != `{"topic":"a","event":"two","data":2}` {
		t.Errorf("duplicate keys: %s", got)
	}
	p.send(testFrame{fin: true, opcode: wsOpBinary, payload: []byte(`{"topic":"a","event":"bin","data":null}`)})
	if got := q.nextEvent(2 * time.Second); got != `{"topic":"a","event":"bin","data":null}` {
		t.Errorf("a binary message: %s", got)
	}
}

func TestWSRelayDropsWhatABrowserMayNotPublish(t *testing.T) {
	_, base := startRelay(t, nil)
	p := joinRelay(t, base, "topics=a")
	q := joinRelay(t, base, "topics=a,b")
	q.awaitCount("a", 2, 2*time.Second)

	for _, bad := range []string{
		`{"topic":"b","event":"not its topic"}`,
		// the relay's own event: a browser would set everyone's count
		`{"topic":"a","event":"__count","data":999}`,
		`not json`,
		`null`,
		`[1]`,
		`"a"`,
		`{"topic":1,"event":"x"}`,
		`{"topic":"a"}`,
		`{"topic":"a","event":null}`,
		`{"topic":"a","event":7}`,
		// JSON.parse is case-sensitive, where a go struct would not be
		`{"TOPIC":"a","EVENT":"x"}`,
		`{"Topic":"a","event":"x"}`,
		`{"topic":"a","Event":"x"}`,
	} {
		p.publish(bad)
	}
	sentinel := `{"topic":"a","event":"sentinel"}`
	p.publish(sentinel)
	// read raw, counts included: the forged count is one of the things to catch
	for {
		f := q.nextData(2 * time.Second)
		if string(f.payload) == sentinel {
			break
		}
		forged := string(f.payload) == countFrame("a", 999)
		if forged || !strings.Contains(string(f.payload), `"event":"__count"`) {
			t.Fatalf("the other subscriber was sent %s before the sentinel", f.payload)
		}
	}
	if got := p.nextEvent(2 * time.Second); got != sentinel {
		t.Errorf("the sender was echoed %s before the sentinel", got)
	}
}

func TestWSRelayCountsAreCurrentAndCoalesced(t *testing.T) {
	relay, base := startRelay(t, nil)
	watcher := joinRelay(t, base, "topics=c")
	watcher.awaitCount("c", 1, 2*time.Second)

	// joins spread over many windows, so each window has some: one count per
	// join would be 200 frames, one per window is what the time allows
	peers := make([]*wsPeer, 200)
	start := time.Now()
	for i := range peers {
		peers[i] = joinRelay(t, base, "topics=c")
		time.Sleep(5 * time.Millisecond)
	}
	bound := int(time.Since(start)/wsCountWindow) + 5
	frames := 0
	deadline := time.Now().Add(5 * time.Second)
	for {
		f, err := watcher.next(time.Until(deadline))
		if err != nil {
			t.Fatalf("never told %s (%d counts seen): %v", countFrame("c", 201), frames, err)
		}
		if !strings.Contains(string(f.payload), `"__count"`) {
			continue
		}
		frames++
		if string(f.payload) == countFrame("c", 201) {
			break
		}
	}
	if frames > bound {
		t.Errorf("%d counts for 200 joins over %d windows: not coalesced", frames, bound-5)
	}

	for _, p := range peers[:50] {
		p.conn.Close()
	}
	watcher.awaitCount("c", 151, 5*time.Second)

	// and a topic nobody holds any more is forgotten
	for _, p := range peers[50:] {
		p.conn.Close()
	}
	watcher.conn.Close()
	waitFor(t, func() bool {
		relay.mu.Lock()
		defer relay.mu.Unlock()
		return len(relay.topics) == 0
	}, "the relay to forget a topic with no subscribers")
}

// a window sends the topics that changed in it, and no others: a socket on a
// quiet topic hears its own count once, however busy the topic beside it is
func TestWSRelayCountsOnlyTheTopicsThatChanged(t *testing.T) {
	_, base := startRelay(t, nil)
	quiet := joinRelay(t, base, "topics=quiet")
	quiet.awaitCount("quiet", 1, 2*time.Second)
	for range 4 {
		joinRelay(t, base, "topics=busy")
		time.Sleep(3 * wsCountWindow)
	}
	quiet.publish(`{"topic":"quiet","event":"sentinel"}`)
	f := quiet.nextData(2 * time.Second)
	if string(f.payload) != `{"topic":"quiet","event":"sentinel"}` {
		t.Fatalf("a quiet topic was sent %s", f.payload)
	}
}

func TestWSRelayShutdownClosesEverySubscriber(t *testing.T) {
	relay := newWSRelay(wsRelayOptions{dev: true})
	srv := &http.Server{Handler: relay}
	armStreamShutdown(srv)
	base := serveOn(t, srv)
	defer srv.Close()
	p := joinRelay(t, base, "topics=a")
	p.awaitCount("a", 1, 2*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go srv.Shutdown(ctx)
	p.closed(wsCloseGoingAway, "shutting down", time.Second)
}

func TestWSRelayGivesEverySubscriberTheSameOrder(t *testing.T) {
	relay, base := startRelay(t, nil)
	// enough subscribers that a fan-out takes long enough for two publishers
	// to cross inside it, were the lock let go before the sends
	const subscribers, publishers, each = 100, 8, 200
	peers := make([]*wsPeer, subscribers)
	for i := range peers {
		peers[i] = joinRelay(t, base, "topics=d")
	}
	peers[0].awaitCount("d", subscribers, 5*time.Second)

	// every subscriber reads while the publishers run, and 1600 events go out
	// in a few milliseconds: a burst that closed every one of these sockets
	// with 1013 when a socket held 256 frames, however fast it read
	orders := make([]string, subscribers)
	var readers sync.WaitGroup
	for i, p := range peers {
		readers.Add(1)
		go func() {
			defer readers.Done()
			var b strings.Builder
			for got := 0; got < publishers*each; {
				f, err := p.next(10 * time.Second)
				if err != nil {
					b.WriteString("ended: " + err.Error())
					break
				}
				if f.opcode == wsOpClose {
					code, _ := wsCloseCode(f.payload)
					fmt.Fprintf(&b, "ended: closed %d %q", code, f.payload[min(2, len(f.payload)):])
					break
				}
				// a count or a ping is not one of the events
				if f.opcode != wsOpText || strings.Contains(string(f.payload), `"__count"`) {
					continue
				}
				b.Write(f.payload)
				b.WriteByte('\n')
				got++
			}
			orders[i] = b.String()
		}()
	}
	var publishing sync.WaitGroup
	for g := range publishers {
		publishing.Add(1)
		go func() {
			defer publishing.Done()
			for i := range each {
				relay.publish("d", jsonText(fmt.Sprintf("g%d-%d", g, i)), nil)
			}
		}()
	}
	publishing.Wait()
	readers.Wait()
	if n := strings.Count(orders[0], "\n"); n != publishers*each || strings.Contains(orders[0], "ended: ") {
		tail := orders[0][max(0, len(orders[0])-160):]
		t.Fatalf("subscriber 0 read %d of %d events, ending with: %s", n, publishers*each, tail)
	}
	for i := 1; i < subscribers; i++ {
		if orders[i] != orders[0] {
			t.Fatalf("subscriber %d was sent the same events in another order than subscriber 0", i)
		}
	}
}

func TestWSRelayClosesTheSlowSubscriberAndKeepsTheOthers(t *testing.T) {
	relay, base := startRelay(t, nil)
	slow := joinRelay(t, base, "topics=e")
	fast := joinRelay(t, base, "topics=e")
	fast.awaitCount("e", 2, 2*time.Second)

	// 12 MiB in all: more than loopback buffers and the slow socket's queue
	// hold, at a pace the reading socket keeps up with
	const total = 3000
	body := json.RawMessage(`"` + strings.Repeat("z", 4<<10) + `"`)
	got := make(chan int, 1)
	go func() {
		n := 0
		for n < total {
			f, err := fast.next(10 * time.Second)
			if err != nil {
				break
			}
			head := f.payload[:min(len(f.payload), 64)]
			if strings.Contains(string(head), fmt.Sprintf(`"event":"n%d"`, n)) {
				n++
			}
		}
		got <- n
	}()
	for i := range total {
		relay.publish("e", jsonText(fmt.Sprintf("n%d", i)), body)
		if i%32 == 0 {
			time.Sleep(time.Millisecond)
		}
	}
	if n := <-got; n != total {
		t.Fatalf("the reading subscriber got %d of %d in order", n, total)
	}
	// the one that read nothing was closed, and was never waited for
	for {
		f, err := slow.next(10 * time.Second)
		if err != nil {
			t.Fatalf("the slow subscriber was never closed: %v", err)
		}
		if f.opcode == wsOpClose {
			if code, _ := wsCloseCode(f.payload); code != wsCloseTryAgainLater {
				t.Fatalf("closed with %d, want 1013", code)
			}
			break
		}
	}
}

// bun asked the origin first, then the topics, then the handshake
func TestWSRelayRefusesInBunsOrder(t *testing.T) {
	_, base := startRelay(t, nil)
	cases := []struct {
		name    string
		request []byte
		status  int
		body    string
		close   int
	}{
		{"a foreign origin, a good handshake, bad topics", relayRequest("topics=a%2Cb", "http://evil.test", "Sec-WebSocket-Version: 13\r\n"),
			101, "", wsCloseOriginRefused},
		{"a foreign origin on a request that is no upgrade",
			[]byte("GET /ws?topics=a HTTP/1.1\r\nHost: app.test\r\nOrigin: http://evil.test\r\n\r\n"), 426, "upgrade required", 0},
		{"bad topics before a bad version", relayRequest("topics=a%2Cb", "http://app.test", "Sec-WebSocket-Version: 8\r\n"),
			400, `topic "a,b" contains ","`, 0},
		{"good topics and a bad version", relayRequest("topics=a", "http://app.test", "Sec-WebSocket-Version: 8\r\n"),
			426, "websocket version 13", 0},
		{"no upgrade at all", []byte("GET /ws?topics=a HTTP/1.1\r\nHost: app.test\r\nOrigin: http://app.test\r\n\r\n"),
			426, "upgrade required", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := dialWSRaw(t, base, tc.request)
			if p.res.StatusCode != tc.status {
				t.Fatalf("answered %d, want %d", p.res.StatusCode, tc.status)
			}
			if tc.close != 0 {
				p.closed(tc.close, "is not this server", time.Second)
				return
			}
			body := make([]byte, 512)
			n, _ := bufio.NewReader(p.res.Body).Read(body)
			if !strings.Contains(string(body[:n]), tc.body) {
				t.Fatalf("body %q does not say %q", body[:n], tc.body)
			}
		})
	}
}

func TestWSRelayAnswersWhenTheConnectionCannotBeTaken(t *testing.T) {
	relay := newWSRelay(wsRelayOptions{})
	r := wsHandshakeRequest()
	r.Host = "app.test"
	r.Header.Set("Origin", "http://app.test")
	w := httptest.NewRecorder() // no Hijack, as over HTTP/2
	relay.ServeHTTP(w, r)
	if w.Code != http.StatusUpgradeRequired {
		t.Fatalf("answered %d", w.Code)
	}
}

func TestWSPublishEventRefusesTopicsNoOneCanHold(t *testing.T) {
	relay, base := startRelay(t, nil)
	for _, topic := range []string{"", "   ", " a", "a\t", "a,b", strings.Repeat("x", 129), strings.Repeat("😀", 65), revalidateTopic} {
		if err := relay.publishEvent(topic, "e", 1); err == nil {
			t.Errorf("topic %q was published", topic)
		}
	}
	// characters as javascript counts them: 64 of these are 128
	for _, topic := range []string{strings.Repeat("x", 128), strings.Repeat("😀", 64)} {
		if err := relay.publishEvent(topic, "e", 1); err != nil {
			t.Errorf("a topic of 128 characters: %v", err)
		}
	}
	if err := relay.publishEvent("a", "e", make(chan int)); err == nil || !strings.Contains(err.Error(), "does not encode") {
		t.Errorf("data that is not json: %v", err)
	}

	p := joinRelay(t, base, "topics=a")
	p.awaitCount("a", 1, 2*time.Second)
	if err := relay.publishEvent("a", "created", map[string]any{"html": "<b>", "n": 1}); err != nil {
		t.Fatal(err)
	}
	if got := p.nextEvent(2 * time.Second); got != `{"topic":"a","event":"created","data":{"html":"<b>","n":1}}` {
		t.Errorf("got %s", got)
	}
	if err := relay.publishEvent("a", "nothing", nil); err != nil {
		t.Fatal(err)
	}
	if got := p.nextEvent(2 * time.Second); got != `{"topic":"a","event":"nothing","data":null}` {
		t.Errorf("got %s", got)
	}
}

// bun read a binary message with String(raw), which replaces every broken
// sequence; relayed as it came, it would reach every subscriber in a text
// frame that is not utf-8, and each browser would close its socket with 1007
// - one sender taking a topic down, found by the verifier
func TestWSRelayRelaysABinaryMessageAsBunReadIt(t *testing.T) {
	_, base := startRelay(t, nil)
	p := joinRelay(t, base, "topics=a")
	q := joinRelay(t, base, "topics=a")
	q.awaitCount("a", 2, 2*time.Second)
	p.send(testFrame{fin: true, opcode: wsOpBinary, payload: []byte("{\"topic\":\"a\",\"event\":\"e\",\"data\":\"x\xff\"}")})
	if got := q.nextEvent(2 * time.Second); got != `{"topic":"a","event":"e","data":"x�"}` {
		t.Errorf("got %s", got)
	}
	// and the frame that carried it is utf-8, or the browser would not have
	// let it through
	p.send(testFrame{fin: true, opcode: wsOpBinary, payload: []byte("{\"topic\":\"a\",\"event\":\"\xe2\x82\",\"data\":{\"k\xed\xa0\x80\":1}}")})
	if got := q.nextEvent(2 * time.Second); got != `{"topic":"a","event":"�","data":{"k���":1}}` || !utf8.ValidString(got) {
		t.Errorf("got %s", got)
	}
}

// the WHATWG decoder, as bun's String(buffer) runs it: measured on bun 1.4.0
func TestWSDecodeUTF8IsTheWHATWGDecoder(t *testing.T) {
	cases := []struct {
		in   []byte
		want string
	}{
		{[]byte("x\xff"), "x�"},
		{[]byte("\xe2\x82"), "�"},
		{[]byte("\xe2\x82x"), "�x"},
		{[]byte("\xed\xa0\x80"), "���"},
		{[]byte("\xf0\x80\x80"), "���"},
		{[]byte("\xc0\xaf"), "��"},
		{[]byte("\xf4\x90\x80\x80"), "����"},
		{[]byte("\xf0\x9f\x98"), "�"},
		{[]byte("\x80\x80"), "��"},
		{[]byte("\xe0\x80\x80"), "���"},
		{[]byte("\xf5\x80"), "��"},
		{[]byte("é😀"), "é😀"},
		// valid sequences whose first continuation byte has a narrower range
		// than the rest: the range must widen again after it
		{[]byte("\xe0\xa0\x80\xf0\x90\x80\x80"), "ࠀ\U00010000"},
		// the edges of every lead byte's range, one on each side: a range one
		// byte too wide lets bytes that are not utf-8 through whole, which is
		// the failure the decoder exists to stop (found by the verifier)
		{[]byte("\xc1\x80"), "��"},
		{[]byte("\xe0\x90\x80"), "���"},
		{[]byte("\xed\x9f\xbf"), "퟿"},
		{[]byte("\xef\xbf\xbd"), "�"},
		{[]byte("\xf0\x8f\x80\x80"), "����"},
		{[]byte("\xf4\x8f\xbf\xbf"), "\U0010FFFF"},
		{[]byte("\xf1\x80\x80\x80"), "\U00040000"},
		{[]byte(""), ""},
	}
	for _, tc := range cases {
		got := wsDecodeUTF8(tc.in)
		// the property, before the comparison: a comparison by code point
		// reads a broken byte as U+FFFD and cannot see it
		if !utf8.Valid(got) {
			t.Errorf("% x: decoded to % x, which is not utf-8", tc.in, got)
		}
		if string(got) != tc.want {
			t.Errorf("% x: got %q, want %q", tc.in, got, tc.want)
		}
	}
}

// a topic or event spelled with half a surrogate pair: JSON.parse keeps it,
// a go string turns it into U+FFFD, so it could match a held "�" bun
// never matched - and the event goes out as it was written, for the same
// reason in the other direction
func TestWSRelayKeepsLoneSurrogatesOutOfTopicsAndAsTheyAreInEvents(t *testing.T) {
	_, base := startRelay(t, nil)
	p := joinRelay(t, base, "topics=%EF%BF%BD,a")
	q := joinRelay(t, base, "topics=%EF%BF%BD,a")
	q.awaitCount("a", 2, 2*time.Second)
	p.publish(`{"topic":"\ud800","event":"x"}`)
	p.publish(`{"topic":"\udc00","event":"x"}`)
	p.publish(`{"topic":"\ud83d\ude00\udc00","event":"x"}`)
	p.publish(`{"topic":"a","event":"\ud800","data":1}`)
	if got := q.nextEvent(2 * time.Second); got != `{"topic":"a","event":"\ud800","data":1}` {
		t.Errorf("got %s", got)
	}
	// and a real pair in the topic is a real character: held as such
	r := joinRelay(t, base, "topics=%F0%9F%98%80")
	r.awaitCount("😀", 1, 2*time.Second)
	r.publish(`{"topic":"\ud83d\ude00","event":"pair"}`)
	if got := r.nextEvent(2 * time.Second); got != `{"topic":"😀","event":"pair"}` {
		t.Errorf("got %s", got)
	}
}

func TestWSLoneSurrogate(t *testing.T) {
	for raw, want := range map[string]bool{
		`"\ud800"`:             true,
		`"\udc00"`:             true,
		`"\ud83d\ude00"`:       false,
		`"\ud83d\ude00\udc00"`: true,
		`"\ud83d\u0041"`:       true,
		// a high surrogate followed by an escape that is not a low one, and by
		// the letters of one with no backslash before them (the re-verification)
		`"\ud800\ue000"`: true,
		`"\ud800Xude00"`: true,
		`"\\ud800"`:      false,
		`"a\\\ud800"`:    true,
		`"plain"`:        false,
		`"\u0041"`:       false,
		`"\ud8"`:         false,
	} {
		if got := loneSurrogate([]byte(raw)); got != want {
			t.Errorf("loneSurrogate(%s) = %v", raw, got)
		}
	}
}

// the largest message a client may send fits a subscriber's queue with room:
// at a queue of one message, the frame around it never fit, and one legal
// message closed every subscriber of the topic with 1013 (found by the verifier)
func TestWSRelayCarriesTheLargestMessage(t *testing.T) {
	_, base := startRelay(t, nil)
	p := joinRelay(t, base, "topics=a")
	q := joinRelay(t, base, "topics=a")
	q.awaitCount("a", 2, 2*time.Second)
	head := `{"topic":"a","event":"big","data":"`
	msg := head + strings.Repeat("z", wsMaxMessage-len(head)-2) + `"}`
	if len(msg) != wsMaxMessage {
		t.Fatalf("the message is %d bytes", len(msg))
	}
	p.publish(msg)
	if got := q.nextEvent(10 * time.Second); len(got) != wsMaxMessage {
		t.Fatalf("the subscriber was sent %d bytes: %.60s", len(got), got)
	}
	if got := p.nextEvent(10 * time.Second); len(got) != wsMaxMessage {
		t.Fatalf("the sender was echoed %d bytes", len(got))
	}
}

// and from the server side the same bound is an error, not a 1013 for
// everyone with a nil back to the caller
func TestWSPublishEventRefusesWhatNoSubscriberCouldReceive(t *testing.T) {
	relay, base := startRelay(t, nil)
	p := joinRelay(t, base, "topics=a")
	p.awaitCount("a", 1, 2*time.Second)
	err := relay.publishEvent("a", "big", strings.Repeat("z", wsMaxMessage))
	if err == nil || !strings.Contains(err.Error(), "over the") {
		t.Fatalf("an event over the largest message: %v", err)
	}
	// the bound is on the whole event as written, and exact
	empty, _ := wsEventJSON("a", jsonText("fits"), json.RawMessage(`""`))
	room := wsMaxMessage - len(empty)
	if err := relay.publishEvent("a", "fits", strings.Repeat("z", room+1)); err == nil {
		t.Fatal("an event one byte over the largest message was published")
	}
	if err := relay.publishEvent("a", "fits", strings.Repeat("z", room)); err != nil {
		t.Fatal(err)
	}
	if got := p.nextEvent(10 * time.Second); !strings.HasPrefix(got, `{"topic":"a","event":"fits"`) || len(got) != wsMaxMessage {
		t.Fatalf("got %d bytes: %.60s", len(got), got)
	}
}

// joined before the socket is served: one that ends in the packet that
// carried its handshake must still be there to leave
func TestWSRelayForgetsASocketThatEndsAtOnce(t *testing.T) {
	relay, base := startRelay(t, nil)
	for range 20 {
		p := dialWSRaw(t, base, append(relayRequest("topics=gone", "http://app.test", "Sec-WebSocket-Version: 13\r\n"),
			testFrame{fin: true, opcode: wsOpClose, payload: []byte{0x03, 0xe8}}.bytes()...))
		// the close is echoed, then the socket ends
		if f := p.nextData(2 * time.Second); f.opcode != wsOpClose {
			t.Fatalf("expected the close echoed, got %#x %q", f.opcode, f.payload)
		}
		p.ended()
	}
	waitFor(t, func() bool {
		relay.mu.Lock()
		defer relay.mu.Unlock()
		return len(relay.topics) == 0
	}, "the relay to forget sockets that ended at once")
}

// 426 is for a connection that could not be taken; once it is taken, the
// response is the socket's, and nothing may be written to it
type hijackToBrokenConn struct {
	*httptest.ResponseRecorder
	wrote bool
}

func (h *hijackToBrokenConn) WriteHeader(code int) {
	h.wrote = true
	h.ResponseRecorder.WriteHeader(code)
}
func (h *hijackToBrokenConn) Write(p []byte) (int, error) {
	h.wrote = true
	return h.ResponseRecorder.Write(p)
}
func (h *hijackToBrokenConn) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	server, client := net.Pipe()
	client.Close() // the first write fails
	return server, bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server)), nil
}

func TestWSRelayWritesNothingAfterTheConnectionIsTaken(t *testing.T) {
	relay := newWSRelay(wsRelayOptions{})
	r := wsHandshakeRequest()
	r.Host = "app.test"
	r.Header.Set("Origin", "http://app.test")
	w := &hijackToBrokenConn{ResponseRecorder: httptest.NewRecorder()}
	relay.ServeHTTP(w, r)
	if w.wrote {
		t.Fatalf("answered %d %q on a connection that was already taken", w.Code, w.Body.String())
	}
}

// BORGO_WS_SPIKE_ADDR=host:port turns this test into the server the phase 3
// spike measures as road R (bench/tools/spike-ws.ts): the relay as written,
// nothing around it, until the process is killed
func TestWSRelaySpikeServer(t *testing.T) {
	addr := os.Getenv("BORGO_WS_SPIKE_ADDR")
	if addr == "" {
		t.Skip("BORGO_WS_SPIKE_ADDR is not set")
	}
	mux := http.NewServeMux()
	// dev: the spike registers no CanSubscribe, and measures the relay
	mux.Handle("/ws", newWSRelay(wsRelayOptions{dev: true}))
	mux.HandleFunc("/api/hello", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	t.Fatal(http.ListenAndServe(addr, mux))
}
