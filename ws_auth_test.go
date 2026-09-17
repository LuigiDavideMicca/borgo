package borgo

import (
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// resetTopicChecks clears the registry for one test: registration is
// once-per-process in production, so tests take turns
func resetTopicChecks(t *testing.T) {
	t.Helper()
	reset := func() {
		subscribeCheck.Store(nil)
		publishCheck.Store(nil)
		// the stack of a panicking check is said once per process: once per
		// test here, or the order of the tests would decide who sees it
		topicCheckStackOnce.Delete("CanSubscribe")
		topicCheckStackOnce.Delete("CanPublish")
	}
	reset()
	t.Cleanup(reset)
}

func admitAll(*http.Request, string) bool { return true }

func TestCanSubscribeRegistersLikeCheckSession(t *testing.T) {
	resetTopicChecks(t)
	panicsWith(t, "nil check", func() { CanSubscribe(nil) })
	panicsWith(t, "nil check", func() { CanPublish(nil) })
	CanSubscribe(admitAll)
	panicsWith(t, "already registered", func() { CanSubscribe(admitAll) })
	CanPublish(admitAll)
	panicsWith(t, "already registered", func() { CanPublish(admitAll) })

	restoreRegistry(t)
	routesMu.Lock()
	served = true
	routesMu.Unlock()
	resetTopicChecks(t)
	panicsWith(t, "after borgo.Serve", func() { CanSubscribe(admitAll) })
	panicsWith(t, "after borgo.Serve", func() { CanPublish(admitAll) })
}

func TestWithoutACheckDevIsOpenAndProductionRefuses(t *testing.T) {
	resetTopicChecks(t)
	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	if why := (wsTopicPolicy{dev: true}).subscribeRefusal(r, "chat:1"); why != "" {
		t.Errorf("dev refused: %s", why)
	}
	why := (wsTopicPolicy{dev: false}).subscribeRefusal(r, "chat:1")
	if !strings.Contains(why, `"chat:1"`) || !strings.Contains(why, "CanSubscribe") {
		t.Errorf("production refusal does not say what to do: %q", why)
	}
	// publishing follows the subscription when no CanPublish is registered
	if !(wsTopicPolicy{}).publishAllowed(r, "chat:1", nil) {
		t.Error("a publish to a held topic was refused with no CanPublish registered")
	}
	// and startup says which rule is in force
	if n := wsPolicyNotice(true); !strings.Contains(n, "open") {
		t.Errorf("dev notice: %q", n)
	}
	if n := wsPolicyNotice(false); !strings.Contains(n, "refused") {
		t.Errorf("production notice: %q", n)
	}
	CanSubscribe(admitAll)
	if n := wsPolicyNotice(false); n != "" {
		t.Errorf("a registered check still prints %q", n)
	}
}

func TestChecksSeeTheRequestAndTheTopicAndDecidePerTopic(t *testing.T) {
	resetTopicChecks(t)
	t.Setenv("SESSION_SECRET", checkSecret)
	CanSubscribe(func(r *http.Request, topic string) bool {
		s, ok := GetSession[testSession](r)
		return ok && strings.HasPrefix(topic, "user:"+s.User)
	})
	CanPublish(func(r *http.Request, topic string) bool {
		return !strings.HasSuffix(topic, ":readonly")
	})
	signed := httptest.NewRequest(http.MethodGet, "/ws", nil)
	signed.AddCookie(setAndExtract(t, testSession{User: "ada"}, time.Hour))
	anon := httptest.NewRequest(http.MethodGet, "/ws", nil)
	p := wsTopicPolicy{}
	for _, tc := range []struct {
		name  string
		r     *http.Request
		topic string
		want  bool
	}{
		{"her own", signed, "user:ada:inbox", true},
		{"her own, read only", signed, "user:ada:readonly", true},
		{"another's", signed, "user:bob:inbox", false},
		{"no session", anon, "user:ada:inbox", false},
		{"the count is a topic too", anon, "user:ada", false},
	} {
		if got := p.subscribeRefusal(tc.r, tc.topic) == ""; got != tc.want {
			t.Errorf("%s: subscribe %q admitted=%v", tc.name, tc.topic, got)
		}
	}
	if p.publishAllowed(signed, "user:ada:readonly", nil) {
		t.Error("a publish to a read-only topic was admitted")
	}
	if !p.publishAllowed(signed, "user:ada:inbox", nil) {
		t.Error("a publish to her own topic was refused")
	}
}

func TestACheckThatPanicsRefuses(t *testing.T) {
	resetTopicChecks(t)
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)
	CanSubscribe(func(*http.Request, string) bool { panic("the store is down") })
	CanPublish(func(*http.Request, string) bool { panic("the store is down") })
	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	if why := (wsTopicPolicy{dev: true}).subscribeRefusal(r, "t"); why == "" {
		t.Error("a panicking CanSubscribe admitted the topic")
	}
	if (wsTopicPolicy{}).publishAllowed(r, "t", nil) {
		t.Error("a panicking CanPublish admitted the publish")
	}
}

// a check reads the session as a handler does: CheckSession's own hook runs
// once for the request, not once per topic, and a session it revoked holds
// no topic
func TestACheckMayReadTheSessionWithoutRecursing(t *testing.T) {
	resetTopicChecks(t)
	t.Setenv("SESSION_SECRET", checkSecret)
	var calls atomic.Int32
	revoked := false
	withCheck(t, func(r *http.Request, s SessionInfo) bool {
		calls.Add(1)
		return !revoked
	})
	CanSubscribe(func(r *http.Request, topic string) bool {
		_, ok := GetSession[testSession](r)
		return ok
	})
	var refusals []string
	// behind the front every request carries its shared answer
	h := withSessionOnce(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := wsTopicPolicy{}
		for _, topic := range []string{"a", "b", "c"} {
			if why := p.subscribeRefusal(r, topic); why != "" {
				refusals = append(refusals, why)
			}
		}
	}))
	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	req.AddCookie(setAndExtract(t, testSession{User: "ada"}, time.Hour))
	h.ServeHTTP(httptest.NewRecorder(), req)
	if len(refusals) != 0 {
		t.Fatalf("refused: %q", refusals)
	}
	if n := calls.Load(); n != 1 {
		t.Errorf("CheckSession ran %d times for one request with three topics", n)
	}
	// the same cookie, revoked: the topic check reads no session
	revoked = true
	refusals = nil
	h.ServeHTTP(httptest.NewRecorder(), req)
	if len(refusals) != 3 {
		t.Fatalf("a revoked session was admitted to %d of 3 topics", 3-len(refusals))
	}
}
