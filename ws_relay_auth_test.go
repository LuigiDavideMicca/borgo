package borgo

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// the log is written from the sockets' goroutines: a plain buffer read by
// the test would be a data race
type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// a refused topic is a completed upgrade closed with 4403 naming the topic:
// the client treats it as final, and a page never sees a count for it
func TestWSRelayRefusesATopicTheCheckRefuses(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(func(_ *http.Request, topic string) bool { return topic == "a" })
	relay, base := startRelay(t, nil)

	refused := dialWSRaw(t, base, relayRequest("topics=a,b", "http://app.test", "Sec-WebSocket-Version: 13\r\n"))
	if refused.res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("answered %d, want a completed upgrade", refused.res.StatusCode)
	}
	f := refused.nextData(2 * time.Second)
	if f.opcode != wsOpClose {
		t.Fatalf("a refused topic was answered with %#x %q, not a close", f.opcode, f.payload)
	}
	code, _ := wsCloseCode(f.payload)
	if code != wsCloseOriginRefused || !strings.Contains(string(f.payload[2:]), `"b"`) {
		t.Fatalf("closed with %d %q; want 4403 naming the topic", code, f.payload[2:])
	}
	refused.ended()
	waitFor(t, func() bool {
		relay.mu.Lock()
		defer relay.mu.Unlock()
		return len(relay.topics) == 0
	}, "the refused socket to hold nothing")

	// the topic it may hold, alone, is a subscription like before
	p := joinRelay(t, base, "topics=a")
	p.awaitCount("a", 1, 2*time.Second)
}

func TestWSRelayWithoutACheckDevIsOpenAndProductionRefuses(t *testing.T) {
	resetTopicChecks(t)
	_, dev := startRelay(t, func(r *wsRelay) { r.opts.dev = true })
	p := joinRelay(t, dev, "topics=anything")
	p.awaitCount("anything", 1, 2*time.Second)

	_, prod := startRelay(t, func(r *wsRelay) { r.opts.dev = false })
	q := dialWSRaw(t, prod, relayRequest("topics=anything", "http://app.test", "Sec-WebSocket-Version: 13\r\n"))
	if q.res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("answered %d", q.res.StatusCode)
	}
	q.closed(wsCloseOriginRefused, "no borgo.CanSubscribe", time.Second)
}

// a publish the check refuses is dropped and the socket kept: a page
// publishing where it may only read is a bug in the page, said once
func TestWSRelayDropsAPublishTheCheckRefusesAndSaysSoOnce(t *testing.T) {
	resetTopicChecks(t)
	CanPublish(func(_ *http.Request, topic string) bool { return topic != "ro" })
	var logged syncBuffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)
	_, base := startRelay(t, func(r *wsRelay) { r.opts.dev = true })
	p := joinRelay(t, base, "topics=a,ro")
	q := joinRelay(t, base, "topics=a,ro")
	q.awaitCount("ro", 2, 2*time.Second)

	for range 3 {
		p.publish(`{"topic":"ro","event":"write"}`)
	}
	sentinel := `{"topic":"a","event":"sentinel"}`
	p.publish(sentinel)
	if got := q.nextEvent(2 * time.Second); got != sentinel {
		t.Fatalf("the other subscriber was sent %s before the sentinel", got)
	}
	if got := p.nextEvent(2 * time.Second); got != sentinel {
		t.Fatalf("the sender's socket was not kept: %s", got)
	}
	if n := strings.Count(logged.String(), "refused by borgo.CanPublish"); n != 1 {
		t.Errorf("the refusal was logged %d times for one socket:\n%s", n, logged.String())
	}
}

// with no CanPublish, a socket may publish to what it may hold
func TestWSRelayPublishFollowsTheSubscriptionByDefault(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(admitAll)
	_, base := startRelay(t, nil)
	p := joinRelay(t, base, "topics=ro")
	p.awaitCount("ro", 1, 2*time.Second)
	p.publish(`{"topic":"ro","event":"write"}`)
	if got := p.nextEvent(2 * time.Second); got != `{"topic":"ro","event":"write"}` {
		t.Fatalf("got %s", got)
	}
}

// net/http cancels the request's context the moment the handler returns,
// and the relay's handler returns while the socket lives: a check on a
// later publish would see a dead context, and a db.QueryContext in it would
// fail at once (found by the verifier). The socket's own context lives as
// long as the socket, and ends with it
func TestWSRelayChecksGetAContextThatLivesWithTheSocket(t *testing.T) {
	resetTopicChecks(t)
	// the state as the check saw it: the handshake's request context is
	// cancelled the moment the handler returns, which is before this test
	// looks, so Err is read inside the check
	type seenCtx struct {
		err error
		ctx context.Context
	}
	seen := make(chan seenCtx, 8)
	CanSubscribe(func(r *http.Request, _ string) bool { seen <- seenCtx{r.Context().Err(), r.Context()}; return true })
	CanPublish(func(r *http.Request, _ string) bool { seen <- seenCtx{r.Context().Err(), r.Context()}; return true })
	relay, base := startRelay(t, nil)
	p := joinRelay(t, base, "topics=a")
	p.awaitCount("a", 1, 2*time.Second)
	if handshake := <-seen; handshake.err != nil {
		t.Fatalf("CanSubscribe ran on a context that was already %v", handshake.err)
	}
	p.publish(`{"topic":"a","event":"e"}`)
	if got := p.nextEvent(2 * time.Second); got != `{"topic":"a","event":"e"}` {
		t.Fatalf("got %s", got)
	}
	publish := <-seen
	if publish.err != nil {
		t.Fatalf("CanPublish ran on a context that was already %v", publish.err)
	}
	// and it ends with the socket
	p.conn.Close()
	select {
	case <-publish.ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the socket ended and its context did not")
	}
	waitFor(t, func() bool {
		relay.mu.Lock()
		defer relay.mu.Unlock()
		return len(relay.topics) == 0
	}, "the relay to forget the socket")
}

// a check that waits on the context is let go by a shutdown: the socket is
// closed with 1001 and forgotten, instead of held until the check returns
func TestWSRelayShutdownLetsABlockedCheckGo(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(admitAll)
	CanPublish(func(r *http.Request, _ string) bool {
		<-r.Context().Done()
		return false
	})
	relay := newWSRelay(wsRelayOptions{})
	srv := &http.Server{Handler: relay}
	armStreamShutdown(srv)
	base := serveOn(t, srv)
	defer srv.Close()
	p := joinRelay(t, base, "topics=a")
	p.awaitCount("a", 1, 2*time.Second)
	p.publish(`{"topic":"a","event":"blocks"}`)
	time.Sleep(100 * time.Millisecond) // the check is now waiting
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go srv.Shutdown(ctx)
	p.closed(wsCloseGoingAway, "shutting down", 2*time.Second)
	waitFor(t, func() bool {
		relay.mu.Lock()
		defer relay.mu.Unlock()
		return len(relay.topics) == 0
	}, "the relay to forget a socket whose check was blocked")
}

// a panicking check is said once per socket, and its stack once per process:
// the store behind a check being down is the likeliest way to hit it, and
// every message of every socket would otherwise carry two kilobytes of it
func TestWSRelayAPanickingCheckDoesNotFloodTheLog(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(admitAll)
	CanPublish(func(*http.Request, string) bool { panic("the store is down") })
	var logged syncBuffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)
	_, base := startRelay(t, nil)
	p := joinRelay(t, base, "topics=a")
	q := joinRelay(t, base, "topics=a")
	q.awaitCount("a", 2, 2*time.Second)
	for range 5 {
		p.publish(`{"topic":"a","event":"e"}`)
	}
	for range 5 {
		q.publish(`{"topic":"a","event":"e"}`)
	}
	// nothing is relayed: the log is what says the messages were seen
	waitFor(t, func() bool { return strings.Count(logged.String(), "CanPublish panicked") >= 2 }, "both sockets' panics to be logged")
	time.Sleep(200 * time.Millisecond) // the other eight messages, if they were going to be logged
	out := logged.String()
	if n := strings.Count(out, "CanPublish panicked"); n != 2 {
		t.Errorf("the panic was logged %d times for two sockets sending five each:\n%s", n, out)
	}
	// one stack, by the marker the line carries: a stack itself says
	// "goroutine" more than once
	if n := strings.Count(out, "(the stack, once per process)"); n != 1 {
		t.Errorf("the stack was logged %d times", n)
	}
	// the panic line is the socket's one line: no second "refused by" for it
	if n := strings.Count(out, "refused by borgo.CanPublish"); n != 0 {
		t.Errorf("a panicking check was also logged as a refusal %d times", n)
	}
}

// the reason reaches the page cut to a close frame's 123 bytes, and the
// verdict comes before the topic, which is the page's own string anyway
func TestWSRelayRefusalReasonSaysWhyBeforeTheTopic(t *testing.T) {
	resetTopicChecks(t)
	long := strings.Repeat("x", 128)
	CanSubscribe(func(_ *http.Request, topic string) bool { return topic != long })
	_, base := startRelay(t, nil)
	p := dialWSRaw(t, base, relayRequest("topics="+long, "http://app.test", "Sec-WebSocket-Version: 13\r\n"))
	f := p.nextData(2 * time.Second)
	reason := string(f.payload[2:])
	if f.opcode != wsOpClose || !strings.Contains(reason, "CanSubscribe") || !strings.Contains(reason, `"`+strings.Repeat("x", 40)+`"...`) {
		t.Fatalf("the page reads %q", reason)
	}
	_, prod := startRelay(t, func(r *wsRelay) { r.opts.dev = false })
	resetTopicChecks(t)
	// the production sentence is longer, so the topic shown is shorter: the
	// verdict and the "..." both fit the frame, for ascii and for 4-byte
	// characters alike
	for _, topic := range []string{long, strings.Repeat("😀", 64)} {
		q := dialWSRaw(t, prod, relayRequest("topics="+topic, "http://app.test", "Sec-WebSocket-Version: 13\r\n"))
		reason := string(q.nextData(2 * time.Second).payload[2:])
		if !strings.Contains(reason, "no borgo.CanSubscribe") || !strings.HasSuffix(reason, `"...`) {
			t.Fatalf("the page reads %q", reason)
		}
	}
}

// a CanSubscribe blocked on the request's context at the handshake is let
// go by Shutdown, not held for the whole grace: net/http never cancels an
// active request's context on Shutdown, so the shutdown latch does it here
func TestWSRelayShutdownLetsABlockedHandshakeCheckGo(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(func(r *http.Request, _ string) bool {
		<-r.Context().Done()
		return false
	})
	relay := newWSRelay(wsRelayOptions{})
	srv := &http.Server{Handler: relay}
	armStreamShutdown(srv)
	base := serveOn(t, srv)
	defer srv.Close()
	// written by hand and not read: no answer comes while the check blocks
	conn, err := net.Dial("tcp", strings.TrimPrefix(base, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.Write(relayRequest("topics=a", "http://app.test", "Sec-WebSocket-Version: 13\r\n"))
	// the check is blocked inside the handshake now; the grace is long, and
	// the shutdown must not wait for it
	time.Sleep(100 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	if err := srv.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v after %v", err, time.Since(start))
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("shutdown waited %v for a check blocked at the handshake", took)
	}
}

// the socket's one log line may have been an ordinary refusal: the first
// panic of a check in the process is still said, with its stack
func TestWSRelayAPanicAfterARefusalIsStillSaidOnce(t *testing.T) {
	resetTopicChecks(t)
	CanSubscribe(admitAll)
	CanPublish(func(_ *http.Request, topic string) bool {
		if topic == "boom" {
			panic("the store is down")
		}
		return topic != "ro"
	})
	var logged syncBuffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)
	_, base := startRelay(t, nil)
	p := joinRelay(t, base, "topics=ro,boom,ok")
	p.awaitCount("ok", 1, 2*time.Second)
	p.publish(`{"topic":"ro","event":"e"}`)
	p.publish(`{"topic":"boom","event":"e"}`)
	p.publish(`{"topic":"ok","event":"sentinel"}`)
	if got := p.nextEvent(2 * time.Second); got != `{"topic":"ok","event":"sentinel"}` {
		t.Fatalf("got %s", got)
	}
	out := logged.String()
	if strings.Count(out, "refused by borgo.CanPublish") != 1 || strings.Count(out, "CanPublish panicked") != 1 {
		t.Errorf("log:\n%s", out)
	}
}

// a socket asking for nothing can receive nothing and publish nothing: bun
// kept it open, here it is a 400, so an anonymous caller in production holds
// no goroutines for a socket that means nothing
func TestWSRelayRefusesAHandshakeWithNoTopics(t *testing.T) {
	resetTopicChecks(t)
	_, base := startRelay(t, nil)
	for _, query := range []string{"", "topics=", "topics=,,+", "x=1"} {
		p := dialWSRaw(t, base, relayRequest(query, "http://app.test", "Sec-WebSocket-Version: 13\r\n"))
		if p.res.StatusCode != http.StatusBadRequest {
			t.Errorf("?%s answered %d", query, p.res.StatusCode)
		}
	}
}

// judged at the handshake: a session revoked afterwards keeps its socket
// until it ends, and is refused at its next handshake - the rule the godoc
// states, held to
func TestWSRelayRevocationTakesEffectAtTheNextHandshake(t *testing.T) {
	resetTopicChecks(t)
	t.Setenv("SESSION_SECRET", checkSecret)
	revoked := false
	withCheck(t, func(*http.Request, SessionInfo) bool { return !revoked })
	CanSubscribe(func(r *http.Request, _ string) bool { _, ok := GetSession[testSession](r); return ok })
	_, base := startRelay(t, nil)
	cookie := setAndExtract(t, testSession{User: "ada"}, time.Hour)
	extra := "Sec-WebSocket-Version: 13\r\nCookie: " + cookie.Name + "=" + cookie.Value + "\r\n"
	p := dialWSRaw(t, base, relayRequest("topics=a", "http://app.test", extra))
	p.awaitCount("a", 1, 2*time.Second)
	revoked = true
	p.publish(`{"topic":"a","event":"still"}`)
	if got := p.nextEvent(2 * time.Second); got != `{"topic":"a","event":"still"}` {
		t.Fatalf("got %s", got)
	}
	q := dialWSRaw(t, base, relayRequest("topics=a", "http://app.test", extra))
	q.closed(wsCloseOriginRefused, "CanSubscribe", time.Second)
}

// the check reads the session the front verified, from the handshake's own
// cookie: the very hole piazza opened the plan with, closed on the wire
func TestWSRelayChecksReadTheSessionOnTheHandshake(t *testing.T) {
	resetTopicChecks(t)
	t.Setenv("SESSION_SECRET", checkSecret)
	CanSubscribe(func(r *http.Request, topic string) bool {
		s, ok := GetSession[testSession](r)
		return ok && topic == "channel:"+s.User
	})
	_, base := startRelay(t, nil)
	cookie := setAndExtract(t, testSession{User: "3"}, time.Hour)

	anon := dialWSRaw(t, base, relayRequest("topics=channel:3", "http://app.test", "Sec-WebSocket-Version: 13\r\n"))
	anon.closed(wsCloseOriginRefused, "channel:3", time.Second)

	member := dialWSRaw(t, base, relayRequest("topics=channel:3", "http://app.test",
		"Sec-WebSocket-Version: 13\r\nCookie: "+cookie.Name+"="+cookie.Value+"\r\n"))
	member.awaitCount("channel:3", 1, 2*time.Second)

	other := dialWSRaw(t, base, relayRequest("topics=channel:4", "http://app.test",
		"Sec-WebSocket-Version: 13\r\nCookie: "+cookie.Name+"="+cookie.Value+"\r\n"))
	other.closed(wsCloseOriginRefused, "channel:4", time.Second)
}
