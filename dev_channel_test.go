package borgo

import (
	"bufio"
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// one browser on the channel: the stream, read line by line
type devPeer struct {
	t   *testing.T
	res *http.Response
	br  *bufio.Reader
}

func openDevChannel(t *testing.T, base string) *devPeer {
	t.Helper()
	res, err := http.Get(base + "/__borgo/dev")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("answered %d %q", res.StatusCode, res.Header.Get("Content-Type"))
	}
	return &devPeer{t: t, res: res, br: bufio.NewReader(res.Body)}
}

// closed before the test server: its Close waits for every stream to end,
// and a stream ends when the browser's side goes
func (p *devPeer) close() { p.res.Body.Close() }

// the next field line, comments and blank lines skipped - and the blank
// line that must follow it read too: EventSource dispatches an event only
// at a blank line, so a frame without one is a frame the browser never sees
func (p *devPeer) next(within time.Duration) string {
	p.t.Helper()
	got := make(chan string, 1)
	go func() {
		for {
			line, err := p.br.ReadString('\n')
			if err != nil {
				got <- "EOF: " + err.Error()
				return
			}
			line = strings.TrimRight(line, "\r\n")
			if line == "" || strings.HasPrefix(line, ":") {
				continue
			}
			if end, err := p.br.ReadString('\n'); err != nil || strings.TrimRight(end, "\r\n") != "" {
				got <- "NOT TERMINATED: " + line
				return
			}
			got <- line
			return
		}
	}()
	select {
	case line := <-got:
		return line
	case <-time.After(within):
		p.t.Fatal("nothing arrived")
		return ""
	}
}

// every stream gone: the server's side unsubscribes a little after the
// browser's side closes
func awaitNoStreams(t *testing.T, ch *devChannel) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		ch.mu.Lock()
		n := len(ch.subs)
		ch.mu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("a closed stream is still subscribed")
}

func devPoke(t *testing.T, internal, key, path string, body string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, internal+path, strings.NewReader(body))
	if key != "" {
		req.Header.Set(internalKeyHeader, key)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

// what borgo dev does all day: the browser holds the stream on the public
// port, the orchestrator and the render service poke the internal one, and
// every browser is told, in the frames the websocket used to carry
func TestDevChannelCarriesThePokesToEveryBrowser(t *testing.T) {
	ch := newDevChannel()
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	public := httptest.NewServer(frontWith(t, renderer, frontOptions{trusted: trustAll, dev: true, devCh: ch}))
	defer public.Close()
	internal := httptest.NewServer(internalHandler(testInternalKey, nil, apiUnderTest(), ch.pokes()))
	defer internal.Close()

	// the frame the browser parses: one data line and the blank line that
	// ends the event, nothing else
	if f := devFrame(map[string]any{"type": "css"}); !bytes.HasSuffix(f, []byte{10, 10}) || bytes.Count(f, []byte{10}) != 2 {
		t.Fatalf("frame %q", f)
	}
	// closed again at the end, when nothing must remain: a Fatal before
	// then still lets the server close
	a := openDevChannel(t, public.URL)
	defer a.close()
	b := openDevChannel(t, public.URL)
	defer b.close()
	// the retry the browser is to use comes first, before anything to say
	if got := a.next(2 * time.Second); got != "retry: 300" {
		t.Fatalf("first line %q", got)
	}
	b.next(2 * time.Second)

	if code := devPoke(t, internal.URL, testInternalKey, "/__borgo/dev/css", ""); code != 204 {
		t.Fatalf("css poke answered %d", code)
	}
	for _, p := range []*devPeer{a, b} {
		if got := p.next(2 * time.Second); got != `data: {"type":"css"}` {
			t.Fatalf("css: got %q", got)
		}
	}
	before := time.Now().UnixMilli()
	if code := devPoke(t, internal.URL, testInternalKey, "/__borgo/dev/reload", ""); code != 204 {
		t.Fatalf("reload poke answered %d", code)
	}
	reload := a.next(2 * time.Second)
	if !strings.HasPrefix(reload, `data: {"stamp":`) || !strings.HasSuffix(reload, `,"type":"reload"}`) {
		t.Fatalf("reload: got %q", reload)
	}
	var stamp int64
	if _, err := parseJSONField(reload, "stamp", &stamp); err != nil || stamp < before {
		t.Fatalf("reload stamp %d (%v), poked at %d", stamp, err, before)
	}
	if got := b.next(2 * time.Second); got != reload {
		t.Fatalf("b was told %q, a %q", got, reload)
	}
	js := `{"files":["pages/index.tsx"],"chunks":{"index":"/assets/index-abc.js"},"stamp":1700000000000}`
	if code := devPoke(t, internal.URL, testInternalKey, "/__borgo/dev/js", js); code != 204 {
		t.Fatalf("js poke answered %d", code)
	}
	want := `data: {"chunks":{"index":"/assets/index-abc.js"},"files":["pages/index.tsx"],"stamp":1700000000000,"type":"js"}`
	if got := a.next(2 * time.Second); got != want {
		t.Fatalf("js: got %q", got)
	}
	// a browser that connects after the fact - reconnecting after a go
	// restart, or a tab opened on the overlay - is told the last js and the
	// last reload, in that order, and never the css
	c := openDevChannel(t, public.URL)
	defer c.close()
	c.next(2 * time.Second)
	if got := c.next(2 * time.Second); got != want {
		t.Fatalf("late js: got %q", got)
	}
	if got := c.next(2 * time.Second); got != reload {
		t.Fatalf("late reload: got %q", got)
	}
	// a css after the js changes nothing for a browser arriving later: the
	// js it is told is still the build's
	if code := devPoke(t, internal.URL, testInternalKey, "/__borgo/dev/css", ""); code != 204 {
		t.Fatalf("css poke answered %d", code)
	}
	d := openDevChannel(t, public.URL)
	defer d.close()
	d.next(2 * time.Second)
	if got := d.next(2 * time.Second); got != want {
		t.Fatalf("late js after a css: got %q", got)
	}
	if got := d.next(2 * time.Second); got != reload {
		t.Fatalf("late reload after a css: got %q", got)
	}
	// the css above reached the streams already open
	if got := a.next(2 * time.Second); got != `data: {"type":"css"}` {
		t.Fatalf("css after js: got %q", got)
	}
	// a js poke with nothing in it names empty sets, never nulls the
	// browser would index into
	if code := devPoke(t, internal.URL, testInternalKey, "/__borgo/dev/js", `{"stamp":9}`); code != 204 {
		t.Fatalf("empty js poke answered %d", code)
	}
	if got := a.next(2 * time.Second); got != `data: {"chunks":{},"files":[],"stamp":9,"type":"js"}` {
		t.Fatalf("empty js: got %q", got)
	}
	// and when every browser goes, nothing of them stays
	for _, p := range []*devPeer{a, b, c, d} {
		p.close()
	}
	awaitNoStreams(t, ch)
	// the render service was never asked for anything
	if seen != nil {
		t.Errorf("the render service was asked for %s", seen.Get("X-Test-Path"))
	}
}

// parseJSONField reads one integer field out of a data line
func parseJSONField(line, field string, into *int64) (bool, error) {
	i := strings.Index(line, `"`+field+`":`)
	if i < 0 {
		return false, nil
	}
	rest := line[i+len(field)+3:]
	end := strings.IndexAny(rest, ",}")
	if end < 0 {
		end = len(rest)
	}
	var n int64
	for _, c := range rest[:end] {
		if c < '0' || c > '9' {
			return false, errString("not a number: " + rest[:end])
		}
		n = n*10 + int64(c-'0')
	}
	*into = n
	return true, nil
}

type errString string

func (e errString) Error() string { return string(e) }

// the pokes are the internal listener's and the key's: the public port
// answers 404 to them (front_test.go), and without the key nothing is heard
func TestDevChannelPokesNeedTheKeyAndAShape(t *testing.T) {
	ch := newDevChannel()
	// the app's middleware never sees a poke: they are borgo's own, ahead
	// of it like the exports, and a poke answered is a poke that stops there
	probe := &probeMiddleware{}
	internal := httptest.NewServer(internalHandler(testInternalKey, probe.app(), apiUnderTest(), ch.pokes()))
	defer internal.Close()
	defer func() {
		if n := atomic.LoadInt32(&probe.seen); n != 0 {
			t.Errorf("the app's middleware saw %d pokes", n)
		}
	}()
	if code := devPoke(t, internal.URL, "", "/__borgo/dev/reload", ""); code == 204 {
		t.Fatal("a poke without the key was heard")
	}
	if code := devPoke(t, internal.URL, "wrong-"+testInternalKey, "/__borgo/dev/reload", ""); code == 204 {
		t.Fatal("a poke with a wrong key was heard")
	}
	for _, tc := range []struct {
		path, body string
		want       int
	}{
		{"/__borgo/dev/nope", "", 404},
		{"/__borgo/dev/js", "", 400},
		{"/__borgo/dev/js", `{"files":[],"chunks":{}}`, 400},
		{"/__borgo/dev/js", `{"files":[],"chunks":{},"stamp":0}`, 400},
		{"/__borgo/dev/js", strings.Repeat("x", devPokeMaxBody+1), 400},
		// valid json under the cut and over the limit: the size is the refusal
		{"/__borgo/dev/js", `{"files":[],"chunks":{},"stamp":5}` + strings.Repeat(" ", devPokeMaxBody), 400},
		{"/__borgo/dev/js", `{"files":[],"chunks":{},"stamp":5}`, 204},
		// the browser imports what the map names: nothing outside this app's assets
		{"/__borgo/dev/js", `{"files":[],"chunks":{"p":"https://evil.test/x.js"},"stamp":5}`, 400},
		{"/__borgo/dev/js", `{"files":[],"chunks":{"p":"//evil.test/x.js"},"stamp":5}`, 400},
		{"/__borgo/dev/js", `{"files":[],"chunks":{"p":"/assets/p-abc.js"},"stamp":5}`, 204},
	} {
		if code := devPoke(t, internal.URL, testInternalKey, tc.path, tc.body); code != tc.want {
			t.Errorf("%s %q: %d, want %d", tc.path, tc.body[:min(len(tc.body), 40)], code, tc.want)
		}
	}
	// only a post: what the browser's side answers to a get is the stream,
	// which the internal listener does not serve
	req, _ := http.NewRequest(http.MethodGet, internal.URL+"/__borgo/dev/reload", nil)
	req.Header.Set(internalKeyHeader, testInternalKey)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed || res.Header.Get("Allow") != http.MethodPost {
		t.Fatalf("GET on a poke: %d Allow %q", res.StatusCode, res.Header.Get("Allow"))
	}
	// the stream, on the browser's side, is a get
	w := httptest.NewRecorder()
	ch.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/__borgo/dev", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST on the stream: %d", w.Code)
	}
	// with no channel the internal listener's names fall through to the api
	plain := httptest.NewServer(internalHandler(testInternalKey, nil, apiUnderTest(), nil))
	defer plain.Close()
	if code := devPoke(t, plain.URL, testInternalKey, "/__borgo/dev/reload", ""); code == 204 {
		t.Fatal("a production listener heard a poke")
	}
}

// a browser that stopped reading does not hold the others: its frames are
// skipped, not queued for it. The frames are large enough to fill the
// socket buffers of a client that reads nothing, so its stream's writer is
// really stuck, and a publish that waited on it would wait here
func TestDevChannelSkipsABrowserThatStoppedReading(t *testing.T) {
	ch := newDevChannel()
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	public := httptest.NewServer(frontWith(t, renderer, frontOptions{trusted: trustAll, dev: true, devCh: ch}))
	defer public.Close()
	stuck := openDevChannel(t, public.URL)
	defer stuck.close()
	stuck.next(2 * time.Second)
	live := openDevChannel(t, public.URL)
	defer live.close()
	live.next(2 * time.Second)
	frame := devFrame(map[string]any{"type": "css", "pad": strings.Repeat("x", 256<<10)})
	done := make(chan struct{})
	go func() {
		for i := 0; i < 64; i++ {
			ch.publish("css", frame)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("publishing blocked on a browser that stopped reading")
	}
	if got := live.next(5 * time.Second); !bytes.Equal([]byte(got), bytes.TrimSpace(frame)) {
		t.Fatalf("the live browser got %d bytes, want %d", len(got), len(bytes.TrimSpace(frame)))
	}
}
