package borgo

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const checkSecret = "a-test-secret-of-at-least-32-bytes-long"

// the check is process state, as the routes are: registered for one test and
// removed after it
func withCheck(t *testing.T, check func(*http.Request, SessionInfo) bool) {
	t.Helper()
	CheckSession(check)
	t.Cleanup(func() { sessionCheck.Store(nil) })
}

func TestSessionRecordsWhenItWasIssuedToTheMillisecond(t *testing.T) {
	t.Setenv("SESSION_SECRET", checkSecret)
	before := time.Now().Truncate(time.Millisecond)
	cookie := setAndExtract(t, testSession{User: "ada"}, time.Hour)
	after := time.Now()

	var seen SessionInfo
	withCheck(t, func(_ *http.Request, s SessionInfo) bool { seen = s; return true })
	got, ok := GetSession[testSession](sessionRequest(cookie))
	if !ok || got.User != "ada" {
		t.Fatalf("a session the check accepted did not read back: %+v %v", got, ok)
	}
	// at whole seconds a cutoff set in the same second as a login would
	// revoke the login, or spare a session issued just before the cutoff
	if seen.IssuedAt.Before(before) || seen.IssuedAt.After(after) {
		t.Fatalf("IssuedAt %v is outside [%v, %v]", seen.IssuedAt, before, after)
	}
	if string(seen.Data) != `{"user":"ada","role":""}` {
		t.Errorf("the check saw data %s", seen.Data)
	}
}

func TestARevokedSessionIsNoSession(t *testing.T) {
	t.Setenv("SESSION_SECRET", checkSecret)
	cookie := setAndExtract(t, testSession{User: "ada", Role: "admin"}, time.Hour)

	cutoff := time.Now().Add(time.Minute)
	withCheck(t, func(_ *http.Request, s SessionInfo) bool { return s.IssuedAt.After(cutoff) })
	if _, ok := GetSession[testSession](sessionRequest(cookie)); ok {
		t.Fatal("a session issued before the cutoff still read back")
	}
	if hasValidSession(sessionRequest(cookie)) {
		t.Fatal("the auth guard let a revoked session through")
	}

	// the same cookie, a cutoff before it was issued: a session again. The
	// cookie was never rewritten, the answer is decided at each read
	cutoff = time.Now().Add(-time.Minute)
	if _, ok := GetSession[testSession](sessionRequest(cookie)); !ok {
		t.Fatal("a session issued after the cutoff did not read back")
	}
}

// the check judges sessions this server signed, and nothing else: a check
// that accepts everything must not turn a forged or expired cookie into one
func TestTheCheckNeverSeesAnUnverifiedSession(t *testing.T) {
	t.Setenv("SESSION_SECRET", checkSecret)
	var calls atomic.Int32
	withCheck(t, func(*http.Request, SessionInfo) bool { calls.Add(1); return true })

	cookie := setAndExtract(t, testSession{User: "ada"}, time.Hour)
	tampered := &http.Cookie{Name: cookie.Name, Value: cookie.Value[:len(cookie.Value)-2] + "xx"}
	expired := setAndExtract(t, testSession{User: "ada"}, -time.Hour)
	for name, c := range map[string]*http.Cookie{"tampered": tampered, "expired": expired, "absent": nil} {
		if data, ok := sessionData(sessionRequest(c)); ok {
			t.Errorf("%s: a check that accepts everything made it a session: %s", name, data)
		}
	}
	if n := calls.Load(); n != 0 {
		t.Errorf("the check was asked about %d unverified sessions", n)
	}

	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)
	req := httptest.NewRequest(http.MethodGet, "/app", nil)
	req.AddCookie(tampered)
	front.ServeHTTP(httptest.NewRecorder(), req)
	if _, present := seen[sessionHeader]; present {
		t.Errorf("a tampered cookie reached the render service as a session header: %q", seen.Get(sessionHeader))
	}
}

func TestAPanickingCheckIsNoSessionNotACrash(t *testing.T) {
	t.Setenv("SESSION_SECRET", checkSecret)
	cookie := setAndExtract(t, testSession{User: "ada"}, time.Hour)
	var logged bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logged)
	t.Cleanup(func() { log.SetOutput(previous) })

	withCheck(t, func(*http.Request, SessionInfo) bool { panic("revocation store down") })
	if _, ok := GetSession[testSession](sessionRequest(cookie)); ok {
		t.Fatal("a check that panicked left the session standing")
	}
	if !strings.Contains(logged.String(), "revocation store down") {
		t.Errorf("the panic was not logged: %q", logged.String())
	}
}

func TestASessionWithoutIssuedAtReadsAsTheEpoch(t *testing.T) {
	t.Setenv("SESSION_SECRET", checkSecret)
	// what every borgo before 0.30 wrote: exp and data, nothing else
	envelope := fmt.Sprintf(`{"exp":%d,"data":{"user":"ada"}}`, time.Now().Add(time.Hour).Unix())
	payload := base64.RawURLEncoding.EncodeToString([]byte(envelope))
	cookie := &http.Cookie{Name: sessionCookie, Value: payload + "." + sessionSign(payload, checkSecret)}

	var seen SessionInfo
	withCheck(t, func(_ *http.Request, s SessionInfo) bool {
		seen = s
		return s.IssuedAt.After(time.Unix(1, 0))
	})
	if _, ok := GetSession[testSession](sessionRequest(cookie)); ok {
		t.Fatal("a session with no issue time survived a cutoff one second after the epoch")
	}
	if !seen.IssuedAt.Equal(time.Unix(0, 0)) {
		t.Errorf("IssuedAt of an old session %v, want the epoch", seen.IssuedAt)
	}
}

func TestCheckSessionRefusesWhatWouldNeverRun(t *testing.T) {
	expectPanic := func(want string, register func()) {
		t.Helper()
		defer func() {
			t.Helper()
			msg, _ := recover().(string)
			if !strings.Contains(msg, want) {
				t.Errorf("want a panic naming %q, got %q", want, msg)
			}
		}()
		register()
	}
	accept := func(*http.Request, SessionInfo) bool { return true }

	expectPanic("nil check", func() { CheckSession(nil) })

	withCheck(t, accept)
	expectPanic("already registered", func() { CheckSession(accept) })
	sessionCheck.Store(nil)

	routesMu.Lock()
	served = true
	routesMu.Unlock()
	defer func() {
		routesMu.Lock()
		served = false
		routesMu.Unlock()
	}()
	expectPanic("after borgo.Serve", func() { CheckSession(accept) })
	if sessionCheck.Load() != nil {
		t.Error("a refused late registration was stored anyway")
	}
}

// the app's middleware reads the session, then what it guards reads it
// again: two reads, and a check that queries a store must query it once
func readsTwice(t *testing.T) (*appMiddleware, http.Handler) {
	app := &appMiddleware{wrap: func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, ok := GetSession[testSession](r); !ok {
				http.Error(w, "no session", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := GetSession[testSession](r); !ok {
			t.Error("the handler read no session the middleware had read")
		}
		w.WriteHeader(http.StatusNoContent)
	})
	return app, handler
}

func TestTheCheckRunsOncePerRequestOnEveryDoor(t *testing.T) {
	t.Setenv("SESSION_SECRET", checkSecret)
	var calls atomic.Int32
	withCheck(t, func(*http.Request, SessionInfo) bool { calls.Add(1); return true })
	cookie := setAndExtract(t, testSession{User: "ada"}, time.Hour)

	app, handler := readsTwice(t)
	doors := []struct {
		name string
		h    http.Handler
		key  bool
	}{
		{"internal", internalHandler(testInternalKey, app, handler), true},
		{"api-only", apiOnlyHandler(nil, 1<<20, app, handler), false},
	}
	for _, door := range doors {
		calls.Store(0)
		for i := range 2 {
			req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
			req.AddCookie(cookie)
			if door.key {
				req.Header.Set(internalKeyHeader, testInternalKey)
			}
			w := httptest.NewRecorder()
			door.h.ServeHTTP(w, req)
			if w.Code != http.StatusNoContent {
				t.Fatalf("%s: %d %s", door.name, w.Code, w.Body)
			}
			if n := calls.Load(); n != int32(i+1) {
				t.Fatalf("%s: the check ran %d times after %d requests", door.name, n, i+1)
			}
		}
	}

	// the public port: the middleware reads it, the front reads it again to
	// hand it to the render service
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontWith(t, renderer, frontOptions{trusted: trustAll, app: app})
	calls.Store(0)
	req := httptest.NewRequest(http.MethodGet, "/app", nil)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	front.ServeHTTP(w, req)
	if seen.Get(sessionHeader) == "" {
		t.Fatalf("front: no session reached the render service: %d %s", w.Code, w.Body)
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("front: the check ran %d times for one request", n)
	}
}

func TestTheFrontHandsARevokedSessionToNobody(t *testing.T) {
	t.Setenv("SESSION_SECRET", checkSecret)
	withCheck(t, func(*http.Request, SessionInfo) bool { return false })
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)

	req := httptest.NewRequest(http.MethodGet, "/app", nil)
	req.AddCookie(setAndExtract(t, testSession{User: "ada"}, time.Hour))
	front.ServeHTTP(httptest.NewRecorder(), req)
	if seen == nil {
		t.Fatal("the page never reached the render service")
	}
	if got := seen.Get(sessionHeader); got != "" {
		t.Errorf("a revoked session was handed to the render service: %q", got)
	}
}

// a handler that swaps the cookie mid-request is answered about the new one
func TestTheSharedAnswerFollowsTheCookie(t *testing.T) {
	t.Setenv("SESSION_SECRET", checkSecret)
	var calls atomic.Int32
	withCheck(t, func(_ *http.Request, s SessionInfo) bool {
		calls.Add(1)
		return !strings.Contains(string(s.Data), "mallory")
	})
	ada := setAndExtract(t, testSession{User: "ada"}, time.Hour)
	mallory := setAndExtract(t, testSession{User: "mallory"}, time.Hour)

	h := withSessionOnce(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := GetSession[testSession](r); !ok {
			t.Error("ada's session did not read back")
		}
		r.Header.Del("Cookie")
		r.AddCookie(mallory)
		if _, ok := GetSession[testSession](r); ok {
			t.Error("the second cookie was answered from the first one's result")
		}
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(ada)
	h.ServeHTTP(httptest.NewRecorder(), req)
	if n := calls.Load(); n != 2 {
		t.Errorf("the check ran %d times for two different cookies", n)
	}
}

// the natural mistake: a check that calls GetSession to find the user. It
// must neither recurse nor deadlock on the request's shared answer
func TestACheckThatReadsTheSessionItJudges(t *testing.T) {
	t.Setenv("SESSION_SECRET", checkSecret)
	withCheck(t, func(r *http.Request, _ SessionInfo) bool {
		me, ok := GetSession[testSession](r)
		return ok && me.User == "ada"
	})
	ada := setAndExtract(t, testSession{User: "ada"}, time.Hour)
	mallory := setAndExtract(t, testSession{User: "mallory"}, time.Hour)

	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, ok := GetSession[testSession](sessionRequest(ada)); !ok {
			t.Error("without a door: ada was refused")
		}
		if _, ok := GetSession[testSession](sessionRequest(mallory)); ok {
			t.Error("without a door: mallory was let through")
		}
		h := withSessionOnce(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, ok := GetSession[testSession](r); !ok {
				t.Error("through a door: ada was refused")
			}
		}))
		h.ServeHTTP(httptest.NewRecorder(), sessionRequest(ada))
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a check reading its own session never returned")
	}
}

type countingHandler struct{ n int }

func (c *countingHandler) ServeHTTP(http.ResponseWriter, *http.Request) { c.n++ }

// an app that revokes nothing pays nothing: no wrapper, no context value
func TestNoCheckMeansNoWrapper(t *testing.T) {
	h := &countingHandler{}
	if withSessionOnce(h) != http.Handler(h) {
		t.Fatal("withSessionOnce wrapped a door with no check registered")
	}
}
