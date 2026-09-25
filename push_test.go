package borgo

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// the relay is process state, as the checks are: a test that mounts one
// leaves none behind
func withProcessRelay(t *testing.T, relay *wsRelay) {
	t.Helper()
	prev := processRelay.Swap(relay)
	t.Cleanup(func() { processRelay.Store(prev) })
}

func TestPushWithNoRelayNamesWhereOneComesFrom(t *testing.T) {
	withProcessRelay(t, nil)
	err := Push("live", "created", "x")
	if err == nil || !strings.Contains(err.Error(), "borgo.Realtime()") || !strings.Contains(err.Error(), "/ws") {
		t.Fatalf("got %v", err)
	}
}

func TestPushReachesTheProcessRelaysSubscribers(t *testing.T) {
	resetTopicChecks(t)
	relay, base := startRelay(t, nil)
	withProcessRelay(t, relay)
	p := joinRelay(t, base, "topics=live")
	p.awaitCount("live", 1, 2*time.Second)
	if err := Push("live", "task-created", "write the docs"); err != nil {
		t.Fatal(err)
	}
	if got := p.nextEvent(2 * time.Second); got != `{"topic":"live","event":"task-created","data":"write the docs"}` {
		t.Fatalf("got %s", got)
	}
	// what no subscriber could ever receive is an error, as publishEvent says
	if err := Push("a,b", "e", 1); err == nil || !strings.Contains(err.Error(), "borgo.Push") {
		t.Fatalf("a topic with a comma: %v", err)
	}
	// and a topic nobody holds right now is delivered to nobody, not an error
	if err := Push("nobody", "e", 1); err != nil {
		t.Fatalf("an unheld topic: %v", err)
	}
}

// the push road of 0.22 carried a key; a deployment upgraded with its
// variables still set would run on a rule that no longer exists
func TestRetiredPushVariablesStopTheBoot(t *testing.T) {
	for _, name := range []string{"BORGO_PUSH_KEY", "BORGO_PUSH_INSECURE"} {
		// a value of only whitespace is set too: refused by name, not trimmed
		// into silence
		for _, value := range []string{"x", " "} {
			t.Run(name+"="+value, func(t *testing.T) {
				t.Setenv(name, value)
				err := retiredPushEnv()
				if err == nil || !strings.Contains(err.Error(), name) || !strings.Contains(err.Error(), "0.30") {
					t.Fatalf("got %v", err)
				}
				if err := CheckEnv(); err == nil || !strings.Contains(err.Error(), name) {
					t.Fatalf("CheckEnv let the boot continue: %v", err)
				}
			})
		}
	}
	t.Setenv("BORGO_PUSH_KEY", "k")
	t.Setenv("BORGO_PUSH_INSECURE", "1")
	if err := retiredPushEnv(); err == nil || !strings.Contains(err.Error(), "BORGO_PUSH_KEY, BORGO_PUSH_INSECURE are") {
		t.Fatalf("two at once: %v", err)
	}
	t.Setenv("BORGO_PUSH_KEY", "")
	t.Setenv("BORGO_PUSH_INSECURE", "")
	if err := retiredPushEnv(); err != nil {
		t.Fatalf("nothing set: %v", err)
	}
	// FRONT_URL named the front server; the name is an app's now, on both
	// halves, and a value left over from 0.22 is a url nothing posts to
	t.Setenv("FRONT_URL", "http://front.invalid")
	if err := retiredPushEnv(); err != nil {
		t.Fatalf("FRONT_URL refused: %v", err)
	}
}

func TestCheckEnvRefusesAnUnreadableNoOriginSwitch(t *testing.T) {
	t.Setenv("BORGO_WS_ALLOW_NO_ORIGIN", "yes")
	if err := CheckEnv(); err == nil || !strings.Contains(err.Error(), "BORGO_WS_ALLOW_NO_ORIGIN") {
		t.Fatalf("got %v", err)
	}
}

func TestRevalidateWithNoCacheIsANoOpThatStillRefusesNonsense(t *testing.T) {
	if err := Revalidate(""); err == nil || !strings.Contains(err.Error(), "empty path") {
		t.Errorf("an empty path: %v", err)
	}
	if err := Revalidate("blog"); err == nil {
		t.Error("a path without its slash was accepted")
	}
	if err := RevalidateTag("  "); err == nil || !strings.Contains(err.Error(), "empty tag") {
		t.Errorf("a blank tag: %v", err)
	}
	if err := Revalidate("/blog"); err != nil {
		t.Errorf("no cache in this process: %v", err)
	}
	if err := RevalidateTag("posts"); err != nil {
		t.Errorf("no cache in this process: %v", err)
	}
}

// an app on a server of its own mounts the relay itself, and gets the one
// relay the process has
func TestRealtimeIsTheProcessRelayAndOnlyOne(t *testing.T) {
	withProcessRelay(t, nil)
	t.Setenv("BORGO_DEV", "1")
	first := Realtime()
	relay, ok := first.(*wsRelay)
	if !ok || processRelay.Load() != relay {
		t.Fatalf("Realtime returned %T, and the process holds %v", first, processRelay.Load())
	}
	if Realtime() != first {
		t.Fatal("a second Realtime is another relay")
	}
	// the environment was read at the first mount: a variable that turns
	// unreadable afterwards does not turn the handler into a 500, and the
	// boot's own mount finds the relay the embedder made
	t.Setenv("BORGO_WS_ALLOW_NO_ORIGIN", "yes")
	if Realtime() != first {
		t.Fatal("a mounted relay was configured again from the environment")
	}
	if got, err := mountRelay(nil); err != nil || got != relay {
		t.Fatalf("mountRelay after Realtime: %v, %v", got, err)
	}
	// Push reaches it
	srv := httptest.NewServer(first)
	defer srv.Close()
	p := joinRelay(t, srv.URL, "topics=live")
	// the 101 carries the security headers from the environment's default:
	// an embedder's own wrappers never see a hijacked response
	for _, kv := range staticSecurity {
		if got := p.res.Header.Get(kv[0]); got != kv[1] {
			t.Errorf("the 101 carries %s: %q, want %q", kv[0], got, kv[1])
		}
	}
	p.awaitCount("live", 1, 2*time.Second)
	if err := Push[any]("live", "e", nil); err != nil {
		t.Fatal(err)
	}
	if got := p.nextEvent(2 * time.Second); got != `{"topic":"live","event":"e","data":null}` {
		t.Fatalf("got %s", got)
	}
}

// an embedder never runs CheckEnv unless it calls it: a relay that cannot
// be configured answers with the reason rather than panicking at mount
func TestRealtimeWithABadEnvironmentAnswersWhy(t *testing.T) {
	withProcessRelay(t, nil)
	t.Setenv("BORGO_WS_ALLOW_NO_ORIGIN", "yes")
	h := Realtime()
	if processRelay.Load() != nil {
		t.Fatal("a relay was mounted on a refused environment")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/ws", nil))
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "BORGO_WS_ALLOW_NO_ORIGIN") {
		t.Fatalf("answered %d %q", w.Code, w.Body.String())
	}
}
