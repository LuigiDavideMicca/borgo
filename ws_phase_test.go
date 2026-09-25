package borgo

import (
	"bytes"
	"encoding/binary"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The seams between the steps of the phase, each held by a test the
// verifier of the phase found missing: the relay built from the environment
// and its production rule, the memory a frame header may claim, what a
// socket leaves behind, the session shared across an embedder's handshake,
// the 426 an opaque writer causes, the goroutines, the dev channel's burst,
// the metrics label and the refusal log lines.

// the rule of borgo start is the wire from the environment to the policy:
// with no BORGO_DEV and no check, a relay mounted from the environment
// refuses every subscription, and with BORGO_DEV=1 it admits them all
func TestRelayFromTheEnvironmentRefusesEverythingInProductionWithoutACheck(t *testing.T) {
	for _, tc := range []struct {
		dev      string
		admitted bool
	}{{"", false}, {"1", true}} {
		t.Run("BORGO_DEV="+tc.dev, func(t *testing.T) {
			resetTopicChecks(t)
			t.Setenv("BORGO_DEV", tc.dev)
			withProcessRelay(t, nil)
			relay, err := mountRelay(nil)
			if err != nil {
				t.Fatal(err)
			}
			srv := httptest.NewServer(relay)
			defer srv.Close()
			p := joinRelay(t, srv.URL, "topics=secret")
			if tc.admitted {
				p.awaitCount("secret", 1, 2*time.Second)
				return
			}
			p.closed(wsCloseOriginRefused, "no borgo.CanSubscribe", 2*time.Second)
		})
	}
}

// a frame header claiming a megabyte, and no byte of it: the memory follows
// the bytes that arrive, not the claim, so a client that sends headers
// alone holds nothing for the read deadline
func TestAClaimedFrameLengthAllocatesNothingBeforeItsBytes(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(admitAll)
	relay := newWSRelay(wsRelayOptions{dev: true})
	srv := httptest.NewServer(relay)
	defer srv.Close()
	// the header of a masked text frame of exactly the largest message
	header := []byte{0x81, 0xff}
	header = binary.BigEndian.AppendUint64(header, uint64(wsMaxMessage))
	header = append(header, 1, 2, 3, 4)
	const sockets = 32
	peers := make([]*wsPeer, 0, sockets)
	for i := 0; i < sockets; i++ {
		p := joinRelay(t, srv.URL, "topics=a")
		p.awaitCount("a", i+1, 2*time.Second)
		peers = append(peers, p)
	}
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	for _, p := range peers {
		if _, err := p.conn.Write(header); err != nil {
			t.Fatal(err)
		}
	}
	// the readers have taken the header and wait for the payload
	time.Sleep(300 * time.Millisecond)
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	grew := int64(after.HeapInuse) - int64(before.HeapInuse)
	if grew > sockets*wsReadChunk*2 {
		t.Fatalf("%d headers claiming %d bytes each grew the heap by %d bytes", sockets, wsMaxMessage, grew)
	}
}

// a socket holding several topics leaves them all when it goes: nothing of
// it in the table, and the counts of its topics not lying forever
func TestTheRelayForgetsAMultiTopicSocket(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(admitAll)
	relay := newWSRelay(wsRelayOptions{dev: true})
	srv := httptest.NewServer(relay)
	defer srv.Close()
	p := joinRelay(t, srv.URL, "topics=x,y,z")
	p.awaitCount("z", 1, 2*time.Second)
	p.conn.Close()
	waitFor(t, func() bool {
		relay.mu.Lock()
		defer relay.mu.Unlock()
		return len(relay.topics) == 0 && len(relay.changed) == 0
	}, "the socket's topics to be forgotten")
}

// an embedder mounts Realtime() on a server of its own, with none of
// Serve's chain in front: the session is still read once for a handshake
// over many topics, not once per topic
func TestAnEmbeddersHandshakeReadsTheSessionOnce(t *testing.T) {
	resetTopicChecks(t)
	t.Setenv("SESSION_SECRET", checkSecret)
	t.Setenv("BORGO_DEV", "1")
	var checks int32
	withCheck(t, func(*http.Request, SessionInfo) bool {
		atomic.AddInt32(&checks, 1)
		return true
	})
	CanSubscribe(func(r *http.Request, topic string) bool {
		_, ok := GetSession[testSession](r)
		return ok
	})
	withProcessRelay(t, nil)
	srv := httptest.NewServer(Realtime())
	defer srv.Close()
	cookie := setAndExtract(t, testSession{User: "ada"}, time.Hour)
	topics := make([]string, 32)
	for i := range topics {
		topics[i] = "t" + strconv.Itoa(i)
	}
	p := dialWSRaw(t, srv.URL, wsHandshakeOn("/ws?topics="+strings.Join(topics, ","), "Cookie: "+cookie.Name+"="+cookie.Value))
	if p.res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("answered %d", p.res.StatusCode)
	}
	p.awaitCount("t0", 1, 2*time.Second)
	if got := atomic.LoadInt32(&checks); got != 1 {
		t.Fatalf("the session was checked %d times for one handshake", got)
	}
}

// a wrapper without Unwrap in front of the relay: the browser sees 426 and
// redials forever, so the operator is told why, once
type opaqueWriter struct{ http.ResponseWriter }

func TestAnOpaqueWriterIsNamedInTheLogOnce(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(admitAll)
	relay := newWSRelay(wsRelayOptions{dev: true})
	var logged syncBuffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)
	wsNotHijackedSaid.Store(false)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		relay.ServeHTTP(opaqueWriter{w}, r)
	}))
	defer srv.Close()
	for i := 0; i < 3; i++ {
		p := dialWSRaw(t, srv.URL, wsHandshakeOn("/ws?topics=a"))
		if p.res.StatusCode != http.StatusUpgradeRequired {
			t.Fatalf("answered %d", p.res.StatusCode)
		}
	}
	if got := logged.String(); strings.Count(got, "Unwrap") != 1 {
		t.Fatalf("log:\n%s", got)
	}
}

// a handshake that completed and ended leaves no goroutine behind it
func TestNoGoroutineOutlivesItsSocket(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(admitAll)
	relay := newWSRelay(wsRelayOptions{dev: true})
	srv := httptest.NewServer(relay)
	defer srv.Close()
	warm := joinRelay(t, srv.URL, "topics=a")
	warm.awaitCount("a", 1, 2*time.Second)
	warm.conn.Close()
	waitFor(t, func() bool {
		relay.mu.Lock()
		defer relay.mu.Unlock()
		return len(relay.topics) == 0
	}, "the first socket to go")
	before := runtime.NumGoroutine()
	for i := 0; i < 50; i++ {
		p := joinRelay(t, srv.URL, "topics=a")
		p.awaitCount("a", 1, 2*time.Second)
		p.conn.Close()
		waitFor(t, func() bool {
			relay.mu.Lock()
			defer relay.mu.Unlock()
			return len(relay.topics) == 0
		}, "the socket to go")
	}
	waitFor(t, func() bool { return runtime.NumGoroutine() <= before+2 }, "the goroutines to return to the baseline")
}

// pokes back to back: every one reaches a browser that is reading
func TestABurstOfPokesReachesEveryBrowser(t *testing.T) {
	ch := newDevChannel()
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	public := httptest.NewServer(frontWith(t, renderer, frontOptions{trusted: trustAll, dev: true, devCh: ch}))
	defer public.Close()
	p := openDevChannel(t, public.URL)
	defer p.close()
	p.next(2 * time.Second)
	for i := 0; i < 6; i++ {
		ch.publish("css", devFrame(map[string]any{"type": "css", "n": i}))
	}
	for i := 0; i < 6; i++ {
		want := "data: " + strings.TrimSpace(string(devFrame(map[string]any{"type": "css", "n": i})))[6:]
		if got := p.next(2 * time.Second); got != want {
			t.Fatalf("frame %d: got %q, want %q", i, got, want)
		}
	}
}

// the front counts /ws under its own label, so a dashboard sees handshakes
func TestTheFrontLabelsWsForTheCounters(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(admitAll)
	relay := newWSRelay(wsRelayOptions{dev: true})
	withProcessRelay(t, relay)
	m := newMetrics(time.Now())
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	srv := httptest.NewServer(frontWith(t, renderer, frontOptions{trusted: trustAll, metrics: m, ws: relay}))
	defer srv.Close()
	p := joinRelay(t, srv.URL, "topics=a")
	p.awaitCount("a", 1, 2*time.Second)
	if out := m.render(time.Now()); !strings.Contains(out, `route="/ws"`) {
		t.Fatalf("no /ws series in:\n%s", out)
	}
}

// what the browser is told nothing about is in the log: an origin refused,
// and a handshake refused with a 400
func TestTheRelayLogsWhatItRefuses(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(admitAll)
	relay := newWSRelay(wsRelayOptions{dev: true})
	var logged syncBuffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)
	srv := httptest.NewServer(relay)
	defer srv.Close()
	q := dialWSRaw(t, srv.URL, bytes.Replace(wsHandshakeOn("/ws?topics=a"), []byte("Origin: http://app.test"), []byte("Origin: http://evil.test"), 1))
	q.closed(wsCloseOriginRefused, "origin", 2*time.Second)
	bad := dialWSRaw(t, srv.URL, wsHandshakeOn("/ws"))
	if bad.res.StatusCode != http.StatusBadRequest {
		t.Fatalf("no topics answered %d", bad.res.StatusCode)
	}
	io.Copy(io.Discard, bad.res.Body)
	got := logged.String()
	for _, want := range []string{"borgo: /ws refused: origin", "borgo: /ws refused: no topics"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in the log:\n%s", want, got)
		}
	}
}

// the startup line about the relay's rule says what is true of this
// process: open under BORGO_DEV=1, refused without, nothing once a check is
// registered
func TestTheRelayNoticeSaysWhatThisProcessDoes(t *testing.T) {
	resetTopicChecks(t)
	if got := wsPolicyNotice(true); !strings.Contains(got, "BORGO_DEV=1") || !strings.Contains(got, "open") || !strings.Contains(got, "unset BORGO_DEV") {
		t.Errorf("dev notice: %q", got)
	}
	if got := wsPolicyNotice(false); !strings.Contains(got, "refused") || strings.Contains(got, "open to every socket") {
		t.Errorf("production notice: %q", got)
	}
	CanSubscribe(admitAll)
	if got := wsPolicyNotice(true); got != "" {
		t.Errorf("with a check registered: %q", got)
	}
}
