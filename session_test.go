package borgo

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type testSession struct {
	User string `json:"user"`
	Role string `json:"role"`
}

func sessionRequest(cookie *http.Cookie) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if cookie != nil {
		r.AddCookie(cookie)
	}
	return r
}

func setAndExtract(t *testing.T, v any, maxAge time.Duration) *http.Cookie {
	t.Helper()
	w := httptest.NewRecorder()
	if err := SetSession(w, v, maxAge); err != nil {
		t.Fatal(err)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("want one cookie, got %d", len(cookies))
	}
	return cookies[0]
}

func TestSessionRoundTrip(t *testing.T) {
	t.Setenv("SESSION_SECRET", "test-secret-long-enough-to-be-a-key")
	cookie := setAndExtract(t, testSession{User: "luigi", Role: "admin"}, time.Hour)

	if !cookie.HttpOnly || cookie.Path != "/" || cookie.SameSite != http.SameSiteLaxMode {
		t.Errorf("cookie attributes wrong: %+v", cookie)
	}
	got, ok := GetSession[testSession](sessionRequest(cookie))
	if !ok || got.User != "luigi" || got.Role != "admin" {
		t.Fatalf("round trip failed: %+v ok=%v", got, ok)
	}
}

func TestSessionRejects(t *testing.T) {
	t.Setenv("SESSION_SECRET", "test-secret-long-enough-to-be-a-key")
	valid := setAndExtract(t, testSession{User: "luigi"}, time.Hour)

	tamperedValue := valid.Value
	tamperedValue = strings.Replace(tamperedValue, tamperedValue[2:3], "x", 1)
	if tamperedValue == valid.Value {
		tamperedValue = "y" + tamperedValue[1:]
	}

	cases := []struct {
		name   string
		cookie *http.Cookie
		setup  func(t *testing.T)
	}{
		{"missing cookie", nil, nil},
		{"tampered payload", &http.Cookie{Name: "borgo_session", Value: tamperedValue}, nil},
		{"garbage value", &http.Cookie{Name: "borgo_session", Value: "not.a.session"}, nil},
		{"no signature separator", &http.Cookie{Name: "borgo_session", Value: "nodothere"}, nil},
		{"expired", setAndExtract(t, testSession{User: "luigi"}, -time.Second), nil},
		{"oversized value", &http.Cookie{Name: "borgo_session", Value: strings.Repeat("a", sessionCookieMaxLen+1) + ".sig"}, nil},
		{"wrong secret", valid, func(t *testing.T) { t.Setenv("SESSION_SECRET", "other-secret-long-enough-to-be-key!") }},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.setup != nil {
				c.setup(t)
			}
			if got, ok := GetSession[testSession](sessionRequest(c.cookie)); ok {
				t.Fatalf("session accepted, want rejection: %+v", got)
			}
		})
	}
}

// cookie tossing: a request can carry more than one borgo_session, and
// net/http hands back the first one
func TestSessionDuplicateCookies(t *testing.T) {
	t.Setenv("SESSION_SECRET", "a-secret-that-is-at-least-32-bytes")
	mine := setAndExtract(t, testSession{User: "victim"}, time.Hour)
	attacker := setAndExtract(t, testSession{User: "attacker"}, time.Hour)

	request := func(values ...string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		for _, v := range values {
			r.AddCookie(&http.Cookie{Name: sessionCookie, Value: v})
		}
		return r
	}

	t.Run("a tossed valid session must not take over", func(t *testing.T) {
		for _, order := range [][]string{{attacker.Value, mine.Value}, {mine.Value, attacker.Value}} {
			got, ok := GetSession[testSession](request(order...))
			if ok {
				t.Fatalf("two signed sessions are ambiguous, got %+v", got)
			}
		}
	})

	t.Run("junk duplicates do not shadow the real session", func(t *testing.T) {
		for _, order := range [][]string{{"junk", mine.Value}, {mine.Value, "junk"}, {"a.b", mine.Value, "nodot"}} {
			got, ok := GetSession[testSession](request(order...))
			if !ok || got.User != "victim" {
				t.Fatalf("cookies %v: got %+v ok=%v, want the signed session", order, got, ok)
			}
		}
	})

	t.Run("an empty payload cookie is not a session", func(t *testing.T) {
		if _, ok := GetSession[testSession](request("." + sessionSign("", sessionSecret()))); ok {
			t.Fatal("a signed empty payload must not pass as a session")
		}
	})
}

// a >68-year maxAge must not wrap a 32-bit cookie MaxAge into a deletion
func TestSessionMaxAgeClamps(t *testing.T) {
	t.Setenv("SESSION_SECRET", "test-secret-long-enough-to-be-a-key")
	cookie := setAndExtract(t, testSession{User: "luigi"}, 100*365*24*time.Hour)
	if cookie.MaxAge <= 0 {
		t.Fatalf("MaxAge = %d, want a positive clamped value", cookie.MaxAge)
	}
	if _, ok := GetSession[testSession](sessionRequest(cookie)); !ok {
		t.Fatal("long-lived session must round trip")
	}
}

// SESSION_SECURE was an == "1" test, so SESSION_SECURE=true - the spelling
// every other boolean env in the ecosystem takes - read as false and issued a
// session cookie without Secure, which the browser then sends back over plain
// http. A downgrade must never be the silent reading of a value.
func TestSessionSecureAcceptsTheUsualSpellings(t *testing.T) {
	t.Setenv("SESSION_SECRET", "a-secret-that-is-at-least-32-bytes")

	for _, v := range []string{"1", "t", "T", "true", "TRUE", "True"} {
		t.Setenv("SESSION_SECURE", v)
		if cookie := setAndExtract(t, testSession{User: "luigi"}, time.Hour); !cookie.Secure {
			t.Errorf("SESSION_SECURE=%q issued a cookie without Secure", v)
		}
		if secure, err := sessionSecure(); !secure || err != nil {
			t.Errorf("sessionSecure() = %v, %v for SESSION_SECURE=%q", secure, err, v)
		}
	}
	for _, v := range []string{"", "0", "f", "F", "false", "FALSE", "False"} {
		t.Setenv("SESSION_SECURE", v)
		if cookie := setAndExtract(t, testSession{User: "luigi"}, time.Hour); cookie.Secure {
			t.Errorf("SESSION_SECURE=%q issued a Secure cookie", v)
		}
	}
}

// like the BORGO_*_TIMEOUT family: a value the package does not understand is
// a refusal, not a fallback to the insecure default
func TestSessionSecureRejectsGarbage(t *testing.T) {
	for _, v := range []string{"yes", "on", "secure", "2", "-1", " 1", "true ", "https"} {
		t.Run(v, func(t *testing.T) {
			t.Setenv("SESSION_SECURE", v)
			secure, err := sessionSecure()
			if err == nil {
				t.Fatalf("SESSION_SECURE=%q was accepted; an unrecognised value must not quietly drop Secure", v)
			}
			if !strings.Contains(err.Error(), "SESSION_SECURE") {
				t.Fatalf("error does not name the variable: %v", err)
			}
			if secure {
				t.Fatalf("SESSION_SECURE=%q reported as secure alongside its error", v)
			}
		})
	}
}

// and the boot reads it, so a typo is a startup failure rather than something
// the first handler that writes a cookie finds out about
func TestStartupValidatesSessionSecure(t *testing.T) {
	t.Setenv("SESSION_SECURE", "yes")
	err := CheckEnv()
	if err == nil || !strings.Contains(err.Error(), "SESSION_SECURE") {
		t.Fatalf("CheckEnv() = %v, want a refusal naming the variable", err)
	}
}

// CheckEnv is what an embedder that never calls Serve runs at startup, so it
// has to cover both variables and pass a healthy environment
func TestCheckEnv(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)

	t.Run("a short secret is refused", func(t *testing.T) {
		t.Setenv("SESSION_SECRET", "too-short")
		err := CheckEnv()
		if err == nil || !strings.Contains(err.Error(), "SESSION_SECRET") {
			t.Fatalf("CheckEnv() = %v, want a refusal naming SESSION_SECRET", err)
		}
	})
	t.Run("an unset secret only warns", func(t *testing.T) {
		t.Setenv("SESSION_SECRET", "")
		if err := CheckEnv(); err != nil {
			t.Fatalf("CheckEnv() = %v, want nil: an app with no sessions is legitimate", err)
		}
	})
	t.Run("a usable environment passes", func(t *testing.T) {
		t.Setenv("SESSION_SECRET", "a-secret-that-is-at-least-32-bytes")
		t.Setenv("SESSION_SECURE", "true")
		if err := CheckEnv(); err != nil {
			t.Fatalf("CheckEnv() = %v, want nil", err)
		}
	})
}

// An embedder mounting these handlers on its own mux never passes through
// CheckEnv - the case sessionSecret's own comment calls out - and a misspelt
// SESSION_SECURE reached it as a panic inside the first request that wrote a
// cookie. It comes back as an error now, with no cookie issued: refusing to
// start a session is the closed direction, panicking in a handler is not.
func TestInvalidSessionSecureIsAnErrorNotAPanic(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(os.Stderr)
	t.Setenv("SESSION_SECRET", "a-secret-that-is-at-least-32-bytes")
	t.Setenv("SESSION_SECURE", "yes")

	t.Run("SetSession refuses", func(t *testing.T) {
		w := httptest.NewRecorder()
		err := SetSession(w, testSession{User: "luigi"}, time.Hour)
		if err == nil || !strings.Contains(err.Error(), "SESSION_SECURE") {
			t.Fatalf("SetSession = %v, want a refusal naming SESSION_SECURE", err)
		}
		if len(w.Result().Cookies()) != 0 {
			t.Fatal("no session may be issued while SESSION_SECURE is unreadable")
		}
	})

	// logging out is the one thing that must still work: a clear without
	// Secure still deletes the cookie, a panicking handler leaves it live
	t.Run("ClearSession still clears", func(t *testing.T) {
		w := httptest.NewRecorder()
		ClearSession(w)
		cookies := w.Result().Cookies()
		if len(cookies) != 1 || cookies[0].MaxAge != -1 || cookies[0].Value != "" {
			t.Fatalf("clear cookie wrong: %+v", cookies)
		}
		if cookies[0].Secure {
			t.Error("the deletion must not carry a Secure this process cannot vouch for")
		}
	})
}

func TestClearSession(t *testing.T) {
	w := httptest.NewRecorder()
	ClearSession(w)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].MaxAge != -1 || cookies[0].Value != "" {
		t.Fatalf("clear cookie wrong: %+v", cookies)
	}
}

// "A maxAge of zero or less writes an already-expired session" was true only
// for the negative half: net/http omits Max-Age entirely for 0, which is a
// browser-session cookie rather than a deletion, and the envelope's Exp read
// exactly now against an exclusive check, so the session stayed valid for the
// rest of the current second. A logout that leaves the principal usable is a
// silent open failure.
func TestSetSessionZeroMaxAgeIsAlreadyExpired(t *testing.T) {
	t.Setenv("SESSION_SECRET", "a-secret-that-is-at-least-32-bytes")

	for _, maxAge := range []time.Duration{0, -time.Second, -time.Hour} {
		t.Run(maxAge.String(), func(t *testing.T) {
			w := httptest.NewRecorder()
			if err := SetSession(w, testSession{User: "luigi"}, maxAge); err != nil {
				t.Fatal(err)
			}
			// on the wire: Max-Age=0, which is the deletion. The attribute
			// missing altogether would keep the cookie for the window's life
			header := w.Result().Header.Get("Set-Cookie")
			if !strings.Contains(header, "Max-Age=0") {
				t.Errorf("Set-Cookie = %q, want Max-Age=0", header)
			}
			cookie := w.Result().Cookies()[0]
			if cookie.MaxAge >= 0 {
				t.Errorf("MaxAge = %d, want the already-expired -1", cookie.MaxAge)
			}
			// and server-side, in case a copy of the value is replayed
			if got, ok := GetSession[testSession](sessionRequest(cookie)); ok {
				t.Errorf("the session still verifies: %+v", got)
			}
		})
	}
}

// the shortest session that is not a logout still is one
func TestSetSessionKeepsShortLivedSessions(t *testing.T) {
	t.Setenv("SESSION_SECRET", "a-secret-that-is-at-least-32-bytes")
	for _, maxAge := range []time.Duration{time.Millisecond, time.Second, time.Minute} {
		cookie := setAndExtract(t, testSession{User: "luigi"}, maxAge)
		if cookie.MaxAge < 1 {
			t.Errorf("maxAge %v: cookie MaxAge = %d, want at least 1", maxAge, cookie.MaxAge)
		}
		if _, ok := GetSession[testSession](sessionRequest(cookie)); !ok {
			t.Errorf("maxAge %v: a live session must verify", maxAge)
		}
	}
}

// pooled macs must not outlive the secret they were built for
func TestSessionSignFollowsTheSecret(t *testing.T) {
	t.Setenv("SESSION_SECRET", "first-secret-first-secret-first-x")
	first := sessionSign("a-payload", sessionSecret())
	t.Setenv("SESSION_SECRET", "second-secret-second-secret-second")
	second := sessionSign("a-payload", sessionSecret())
	t.Setenv("SESSION_SECRET", "first-secret-first-secret-first-x")
	again := sessionSign("a-payload", sessionSecret())

	if first == second {
		t.Fatal("a rotated secret must produce a different signature")
	}
	if first != again {
		t.Fatal("the same secret must produce the same signature")
	}
}

func TestSessionConcurrentRoundTrips(t *testing.T) {
	t.Setenv("SESSION_SECRET", "a-secret-that-is-at-least-32-bytes")
	var wg sync.WaitGroup
	for i := range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			want := testSession{User: fmt.Sprintf("user-%d", i), Role: "member"}
			for range 20 {
				w := httptest.NewRecorder()
				if err := SetSession(w, want, time.Hour); err != nil {
					t.Errorf("user %d: %v", i, err)
					return
				}
				got, ok := GetSession[testSession](sessionRequest(w.Result().Cookies()[0]))
				if !ok || got != want {
					t.Errorf("user %d: round trip gave %+v ok=%v", i, got, ok)
					return
				}
			}
		}()
	}
	wg.Wait()
}

func TestSessionSecretRequired(t *testing.T) {
	t.Setenv("SESSION_SECRET", "")
	// an error, not a panic: the process is already serving requests
	if err := SetSession(httptest.NewRecorder(), testSession{}, time.Hour); !errors.Is(err, ErrNoSessionSecret) {
		t.Fatalf("want ErrNoSessionSecret, got %v", err)
	}
}

func TestSetSessionWithoutSecretIsAnError(t *testing.T) {
	t.Setenv("SESSION_SECRET", "")
	w := httptest.NewRecorder()
	// a missing secret must not panic: the app is already serving, and a
	// login that answers 500 is recoverable where a dead handler is not
	err := SetSession(w, map[string]string{"user": "ada"}, time.Hour)
	if !errors.Is(err, ErrNoSessionSecret) {
		t.Fatalf("want ErrNoSessionSecret, got %v", err)
	}
	if len(w.Result().Cookies()) != 0 {
		t.Fatal("no cookie may be written without a secret")
	}
}
