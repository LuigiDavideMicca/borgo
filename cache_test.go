package borgo

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCacheHeaders(t *testing.T) {
	cases := []struct {
		name string
		set  func(w *httptest.ResponseRecorder)
		want string
	}{
		{"max age", func(w *httptest.ResponseRecorder) { Cache(w, 5*time.Minute) }, "public, max-age=300"},
		{
			"stale while revalidate",
			func(w *httptest.ResponseRecorder) { Cache(w, time.Minute, 10*time.Minute) },
			"public, max-age=60, stale-while-revalidate=600",
		},
		{"no cache", func(w *httptest.ResponseRecorder) { NoCache(w) }, "no-store"},
		{"negative age", func(w *httptest.ResponseRecorder) { Cache(w, -time.Hour) }, "public, max-age=0"},
		{
			// over 2^31-1 seconds: must stay exact on 32-bit platforms too
			"a century",
			func(w *httptest.ResponseRecorder) { Cache(w, 100*365*24*time.Hour) },
			"public, max-age=3153600000",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			c.set(w)
			if got := w.Header().Get("Cache-Control"); got != c.want {
				t.Fatalf("Cache-Control = %q, want %q", got, c.want)
			}
		})
	}
}

// ORDER MUST NOT DECIDE WHETHER A SESSION IS SHAREABLE.
//
// The Set-Cookie downgrade used to be a one-shot test inside Cache, so it only
// saw the cookies that happened to be set already. Cache before SetSession
// emitted `public` and the session cookie was then attached to a response that
// had just told every shared cache it was free to store and re-serve it. RFC
// 9111 3.5 lists `public` as one of the directives that authorises a shared
// cache to store a Set-Cookie response, so this is the exact combination that
// hands one user's session to the next requester through a CDN.
//
// cache.go called the order dependence intentional and documented "set cookies
// first". A rule the caller has to remember is not a guard.
func TestCacheIsPrivateWhateverOrderTheCookieWasSetIn(t *testing.T) {
	t.Setenv("SESSION_SECRET", strings.Repeat("k", 32))

	orders := []struct {
		name string
		run  func(w http.ResponseWriter) error
	}{
		{"cookie first, then Cache", func(w http.ResponseWriter) error {
			if err := SetSession(w, map[string]string{"user": "luigi"}, time.Hour); err != nil {
				return err
			}
			Cache(w, 5*time.Minute)
			return nil
		}},
		// the order that used to ship `public` on a response carrying a session
		{"Cache first, then cookie", func(w http.ResponseWriter) error {
			Cache(w, 5*time.Minute)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}},
		{"Cache first, then a logout", func(w http.ResponseWriter) error {
			Cache(w, 5*time.Minute)
			ClearSession(w)
			return nil
		}},
		{"Cache first, then a plain cookie the app set itself", func(w http.ResponseWriter) error {
			Cache(w, 5*time.Minute)
			http.SetCookie(w, &http.Cookie{Name: "cart", Value: "7", Path: "/"})
			return nil
		}},
		{"Cache first, cookie second, stale-while-revalidate kept", func(w http.ResponseWriter) error {
			Cache(w, time.Minute, 10*time.Minute)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}},
	}

	for _, o := range orders {
		t.Run(o.name, func(t *testing.T) {
			// through the real middleware chain: the commit-time half of the
			// guard is where an order-independent answer can exist at all
			h := recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if err := o.run(w); err != nil {
					t.Fatalf("setup: %v", err)
				}
				w.Write([]byte("body"))
			})))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))

			res := w.Result()
			if len(res.Header.Values("Set-Cookie")) == 0 {
				t.Fatal("no Set-Cookie on the response; the case proves nothing")
			}
			got := res.Header.Get("Cache-Control")
			if strings.HasPrefix(got, "public") {
				t.Fatalf("Cache-Control = %q on a response carrying Set-Cookie: a shared cache may store and re-serve it", got)
			}
			if !strings.HasPrefix(got, "private") {
				t.Fatalf("Cache-Control = %q, want it downgraded to private", got)
			}
			// the downgrade narrows the scope and nothing else
			if !strings.Contains(got, "max-age=") {
				t.Fatalf("Cache-Control = %q, want the max-age preserved", got)
			}
		})
	}
}

// the guard only ever narrows: it must not invent a header, touch a response
// with no cookie, or overwrite a scope the handler chose deliberately
func TestPrivateIfCookiesOnlyNarrows(t *testing.T) {
	cases := []struct {
		name    string
		cookie  bool
		initial string
		want    string
	}{
		{"no cookie leaves public alone", false, "public, max-age=60", "public, max-age=60"},
		{"no cookie and no header stays empty", false, "", ""},
		{"a cookie with no Cache-Control invents none", true, "", ""},
		{"already private is untouched", true, "private, max-age=60", "private, max-age=60"},
		{"no-store is untouched", true, "no-store", "no-store"},
		{"public is downgraded, the rest of the value kept", true, "public, max-age=60, stale-while-revalidate=600", "private, max-age=60, stale-while-revalidate=600"},
		// "public-something" is not the public directive
		{"a directive merely starting with public is not public", true, "publicish, max-age=60", "publicish, max-age=60"},
		// the directive name is case-insensitive, and need not come first
		{"uppercase PUBLIC is still the public directive", true, "PUBLIC, max-age=60", "private, max-age=60"},
		{"public last in the list is found too", true, "max-age=60, public", "max-age=60, private"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := http.Header{}
			if c.initial != "" {
				h.Set("Cache-Control", c.initial)
			}
			if c.cookie {
				h.Add("Set-Cookie", "a=1")
			}
			privateIfCookies(h)
			if got := h.Get("Cache-Control"); got != c.want {
				t.Fatalf("Cache-Control = %q, want %q", got, c.want)
			}
		})
	}
}
