package borgo

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
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

// deliberately a different implementation from cache.go's splitter: a test
// that reuses the code under test cannot disagree with it
func stripQuoted(line string) string {
	var b strings.Builder
	quoted := false
	for i := 0; i < len(line); i++ {
		switch c := line[i]; {
		case c == '"':
			quoted = !quoted
			b.WriteByte(' ')
		case quoted:
			b.WriteByte(' ')
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// across every Cache-Control line, under the strict reading: a quoted
// argument is an argument, and an unterminated quote runs to the end of the line
func hasDirective(values []string, name string) bool {
	for _, v := range values {
		for _, field := range strings.Split(stripQuoted(v), ",") {
			got, _, _ := strings.Cut(field, "=")
			if strings.EqualFold(strings.TrimSpace(got), name) {
				return true
			}
		}
	}
	return false
}

// only the quoted arguments that are actually closed; an unterminated quote
// is left as an ordinary character. This is the reading a forbidden directive
// is hunted under: a balanced argument belongs to the handler, an unterminated
// quote is where a strict parser and a comma-splitting CDN disagree, and a
// directive only one of them sees is still one some cache will obey
func stripBalancedQuoted(line string) string {
	b := []byte(line)
	for i := 0; i < len(b); i++ {
		if b[i] != '"' {
			continue
		}
		end := -1
		for j := i + 1; j < len(b); j++ {
			if b[j] == '\\' {
				j++
				continue
			}
			if b[j] == '"' {
				end = j
				break
			}
		}
		if end < 0 {
			break
		}
		for k := i; k <= end; k++ {
			b[k] = ' '
		}
		i = end
	}
	return string(b)
}

func hasForbiddenDirective(values []string, name string) bool {
	for _, v := range values {
		for _, field := range strings.Split(stripBalancedQuoted(v), ",") {
			got, _, _ := strings.Cut(field, "=")
			if strings.EqualFold(strings.TrimSpace(got), name) {
				return true
			}
		}
	}
	return false
}

// bare token only: private="X" leaves the response storable by a shared
// cache (RFC 9111 5.2.2.7)
func hasBareDirective(values []string, name string) bool {
	for _, v := range values {
		for _, field := range strings.Split(stripQuoted(v), ",") {
			if strings.EqualFold(strings.TrimSpace(field), name) {
				return true
			}
		}
	}
	return false
}

func rawContains(values []string, s string) bool {
	for _, v := range values {
		if strings.Contains(v, s) {
			return true
		}
	}
	return false
}

// A response carrying a Set-Cookie must never ship `public`, however the
// handler ends and however the header was spelled: `public` is the directive
// that tells a shared cache it may store the response (RFC 9111 5.2.2.9), and
// that hands one user's session to the next requester through a CDN.
//
// Both axes vary on purpose: a handler that writes nothing never reaches a
// commit hook, and a ResponseRecorder shows the staged map rather than what
// net/http emits for it. The assertions are on the bytes a real server put on
// the wire.
func TestNoResponseWithASetCookieShipsPublicOnTheWire(t *testing.T) {
	t.Setenv("SESSION_SECRET", strings.Repeat("k", 32))

	setups := []struct {
		name  string
		run   func(w http.ResponseWriter) error
		check func(t *testing.T, values []string)
	}{
		{"cookie first, then Cache", func(w http.ResponseWriter) error {
			if err := SetSession(w, map[string]string{"user": "luigi"}, time.Hour); err != nil {
				return err
			}
			Cache(w, 5*time.Minute)
			return nil
		}, func(t *testing.T, v []string) {
			if !hasDirective(v, "private") || !hasDirective(v, "max-age") {
				t.Errorf("Cache-Control = %q, want it narrowed to private with the max-age kept", v)
			}
		}},
		// the order that once shipped `public` on a response carrying a session
		{"Cache first, then cookie", func(w http.ResponseWriter) error {
			Cache(w, 5*time.Minute)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if !hasDirective(v, "private") || !hasDirective(v, "max-age") {
				t.Errorf("Cache-Control = %q, want it narrowed to private with the max-age kept", v)
			}
		}},
		{"Cache first, then a logout", func(w http.ResponseWriter) error {
			Cache(w, 5*time.Minute)
			ClearSession(w)
			return nil
		}, func(t *testing.T, v []string) {
			if !hasDirective(v, "private") {
				t.Errorf("Cache-Control = %q, want private", v)
			}
		}},
		{"Cache first, then a plain cookie the app set itself", func(w http.ResponseWriter) error {
			Cache(w, 5*time.Minute)
			http.SetCookie(w, &http.Cookie{Name: "cart", Value: "7", Path: "/"})
			return nil
		}, func(t *testing.T, v []string) {
			if !hasDirective(v, "private") {
				t.Errorf("Cache-Control = %q, want private", v)
			}
		}},
		{"stale-while-revalidate survives the downgrade", func(w http.ResponseWriter) error {
			Cache(w, time.Minute, 10*time.Minute)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if !hasDirective(v, "private") || !hasDirective(v, "max-age") {
				t.Errorf("Cache-Control = %q, want private with the max-age kept", v)
			}
			if !rawContains(v, "stale-while-revalidate=600") {
				t.Errorf("Cache-Control = %q, want the stale-while-revalidate window kept", v)
			}
		}},
		// the guard narrows: dropping a no-store the handler added on its own line
		// would let a private cache store what the handler forbade
		{"the handler's own no-store on a second header line survives", func(w http.ResponseWriter) error {
			Cache(w, time.Minute)
			w.Header().Add("Cache-Control", "no-store")
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if !hasDirective(v, "no-store") {
				t.Errorf("Cache-Control = %q, want the handler's no-store kept", v)
			}
		}},
		// public on a line the guard never looked at is still public on the wire
		{"public on a second header line is downgraded too", func(w http.ResponseWriter) error {
			NoCache(w)
			w.Header().Add("Cache-Control", "public")
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if !hasDirective(v, "no-store") {
				t.Errorf("Cache-Control = %q, want the no-store kept", v)
			}
		}},
		// s-maxage is the directive addressed to shared caches by definition (RFC
		// 9111 5.2.2.10); replacing the literal token `public` alone shipped it
		{"s-maxage is dropped and the max-age kept", func(w http.ResponseWriter) error {
			w.Header().Set("Cache-Control", "s-maxage=600, max-age=60")
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if !hasDirective(v, "private") {
				t.Errorf("Cache-Control = %q, want private", v)
			}
			if !hasDirective(v, "max-age") {
				t.Errorf("Cache-Control = %q, want max-age kept: it is legitimate for a private cache", v)
			}
		}},
		// `private, s-maxage=600` tells a shared cache both that it may not store
		// the response and how long to keep it
		{"public beside s-maxage leaves no contradiction", func(w http.ResponseWriter) error {
			w.Header().Set("Cache-Control", "public, s-maxage=600")
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if !hasDirective(v, "private") {
				t.Errorf("Cache-Control = %q, want private", v)
			}
		}},
		// the argument of no-cache is a list of header field names, not of
		// directives
		{"a public inside a quoted argument is left alone", func(w http.ResponseWriter) error {
			w.Header().Set("Cache-Control", `no-cache="a, public, b", max-age=60`)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if !rawContains(v, `no-cache="a, public, b"`) {
				t.Errorf("Cache-Control = %q, want the handler's no-cache field list untouched", v)
			}
		}},
		// an unterminated quote is reachable the moment any part of the value is
		// interpolated; treating it as opening a string hid these directives from
		// the guard while a lenient cache obeyed them
		{"an unterminated quote does not hide s-maxage", func(w http.ResponseWriter) error {
			w.Header().Set("Cache-Control", `x=", s-maxage=600`)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, nil},
		{"an unterminated quote does not hide public", func(w http.ResponseWriter) error {
			w.Header().Set("Cache-Control", `s-maxage=600, x=", public`)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, nil},
		// the added private must not land inside the unterminated string it was
		// added because of
		{"an unterminated quote does not swallow the added private", func(w http.ResponseWriter) error {
			w.Header().Set("Cache-Control", `max-age=600, x="`)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, nil},
		// a private on a later line is behind an earlier line's open quote and
		// reaches no strict reader
		{"a private on a later line does not count behind an earlier open quote", func(w http.ResponseWriter) error {
			w.Header().Add("Cache-Control", "max-age=31536000, immutable")
			w.Header().Add("Cache-Control", `no-cache="a`)
			w.Header().Add("Cache-Control", "private")
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if !rawContains(v, "immutable") {
				t.Errorf("Cache-Control = %q, want the handler's immutable kept", v)
			}
		}},
		// a bare `public` and a bare `s-maxage` each alone on a line, inside a
		// quoted argument opened earlier and closed later: safe under the join, a
		// bare token to any reader that does not join first
		{"a quoted span crossing lines is emitted joined", func(w http.ResponseWriter) error {
			w.Header().Add("Cache-Control", `private, no-cache="a`)
			w.Header().Add("Cache-Control", "public")
			w.Header().Add("Cache-Control", "s-maxage=600")
			w.Header().Add("Cache-Control", `b"`)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if len(v) != 1 {
				t.Errorf("Cache-Control = %q on %d lines: a span crossing a boundary must ship as the one value it was read as, or a reader that does not join sees a bare public", v, len(v))
			}
			if !rawContains(v, `no-cache="a,public,s-maxage=600,b"`) {
				t.Errorf("Cache-Control = %q, want the handler's argument intact", v)
			}
		}},
		// same multi-line value, no quoted span crossing a boundary: must come back
		// as it arrived
		{"a multi-line value with no crossing span is left as it arrived", func(w http.ResponseWriter) error {
			w.Header().Add("Cache-Control", `private, no-cache="a, public"`)
			w.Header().Add("Cache-Control", "max-age=60")
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if !slices.Equal(v, []string{`private, no-cache="a, public"`, "max-age=60"}) {
				t.Errorf("Cache-Control = %q, want it back exactly as the handler set it", v)
			}
		}},
		// two cookie writes plus the commit guard: four passes over one value
		{"repeated guard passes do not accumulate private", func(w http.ResponseWriter) error {
			w.Header().Set("Cache-Control", `max-age=60, x="`)
			if err := SetSession(w, map[string]string{"user": "luigi"}, time.Hour); err != nil {
				return err
			}
			ClearSession(w)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if n := strings.Count(strings.Join(v, ","), "private"); n != 1 {
				t.Errorf("Cache-Control = %q carries %d privates, want exactly one", v, n)
			}
		}},
		// private="X" leaves the response storable by a shared cache (RFC 9111
		// 5.2.2.7), so it does not satisfy the guard
		{"a qualified private does not count as private", func(w http.ResponseWriter) error {
			w.Header().Set("Cache-Control", `private="X-Thing", max-age=600`)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if !rawContains(v, `private="X-Thing"`) {
				t.Errorf("Cache-Control = %q, want the handler's qualified private kept", v)
			}
		}},
	}

	// how the handler ends: only the rows that write anything reach a commit hook
	finishes := []struct {
		name string
		run  func(w http.ResponseWriter)
	}{
		{"returns without writing anything", func(w http.ResponseWriter) {}},
		{"writes a body", func(w http.ResponseWriter) { w.Write([]byte("body")) }},
		{"WriteHeader only", func(w http.ResponseWriter) { w.WriteHeader(http.StatusOK) }},
		{"Flush only", func(w http.ResponseWriter) {
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}},
		{"204", func(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) }},
		{"304", func(w http.ResponseWriter) { w.WriteHeader(http.StatusNotModified) }},
	}

	encodings := []string{"gzip", "identity"}

	for _, s := range setups {
		for _, f := range finishes {
			for _, enc := range encodings {
				t.Run(s.name+"/"+f.name+"/"+enc, func(t *testing.T) {
					srv := httptest.NewServer(recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if err := s.run(w); err != nil {
							t.Errorf("setup: %v", err)
							return
						}
						f.run(w)
					}))))
					defer srv.Close()

					req, err := http.NewRequest(http.MethodGet, srv.URL, nil)
					if err != nil {
						t.Fatal(err)
					}
					req.Header.Set("Accept-Encoding", enc)
					res, err := http.DefaultClient.Do(req)
					if err != nil {
						t.Fatal(err)
					}
					io.Copy(io.Discard, res.Body)
					res.Body.Close()

					if len(res.Header.Values("Set-Cookie")) == 0 {
						t.Fatal("no Set-Cookie on the wire; the case proves nothing")
					}
					cc := res.Header.Values("Cache-Control")
					// the two directives addressed to shared caches (RFC 9111 5.2.2.9,
					// 5.2.2.10): neither may reach the wire beside a cookie under either
					// reading of the line, because either is a cache someone runs
					for _, bad := range []string{"public", "s-maxage"} {
						if hasForbiddenDirective(cc, bad) {
							t.Fatalf("Cache-Control = %q ships %s on a response carrying Set-Cookie: a shared cache may store it and hand this session to the next requester", cc, bad)
						}
					}
					if !hasBareDirective(cc, "private") {
						t.Fatalf("Cache-Control = %q carries no bare private on a response carrying Set-Cookie", cc)
					}
					if s.check != nil {
						s.check(t, cc)
					}
				})
			}
		}
	}
}

// The guard runs up to four times on one response (Cache, SetSession or
// ClearSession, the gzip commit, recoverMiddleware's exit). A fixed point
// after the first pass is the property: `private` once accumulated without
// bound on any value with an unterminated quote, because the added token was
// judged per line
func TestPrivateIfCookiesReachesAFixedPoint(t *testing.T) {
	values := []string{
		"public, max-age=60",
		"no-store",
		"max-age=60",
		`max-age=60, x="`,
		`x=", public`,
		"s-maxage=600, max-age=60",
		`no-cache="a, public", max-age=60`,
		`private="X", max-age=600`,
		"",
	}

	for _, v := range values {
		t.Run(v, func(t *testing.T) {
			h := http.Header{}
			h.Add("Cache-Control", v)
			h.Add("Set-Cookie", "a=1")

			privateIfCookies(h)
			settled := slices.Clone(h.Values("Cache-Control"))
			for pass := 2; pass <= 5; pass++ {
				privateIfCookies(h)
				if got := h.Values("Cache-Control"); !slices.Equal(got, settled) {
					t.Fatalf("pass %d moved a settled response: %q -> %q", pass, settled, got)
				}
			}
		})
	}
}

// borgo's own session cookie is guarded without borgo's pipeline: on an
// embedder mux there is no commit-time guard, so SetSession and ClearSession
// enforce it themselves. No middleware here on purpose.
func TestSessionCookiesAreGuardedOnAnEmbedderMux(t *testing.T) {
	t.Setenv("SESSION_SECRET", strings.Repeat("k", 32))

	cases := []struct {
		name string
		run  func(w http.ResponseWriter) error
	}{
		{"cache then session", func(w http.ResponseWriter) error {
			Cache(w, 5*time.Minute)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}},
		{"session then cache", func(w http.ResponseWriter) error {
			if err := SetSession(w, map[string]string{"user": "luigi"}, time.Hour); err != nil {
				return err
			}
			Cache(w, 5*time.Minute)
			return nil
		}},
		{"cache then logout", func(w http.ResponseWriter) error {
			Cache(w, 5*time.Minute)
			ClearSession(w)
			return nil
		}},
		{"a hand-written s-maxage then session", func(w http.ResponseWriter) error {
			w.Header().Set("Cache-Control", "s-maxage=600, max-age=60")
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
				if err := c.run(w); err != nil {
					t.Errorf("setup: %v", err)
				}
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()

			res, err := http.Get(srv.URL)
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()

			if len(res.Header.Values("Set-Cookie")) == 0 {
				t.Fatal("no Set-Cookie on the wire; the case proves nothing")
			}
			cc := res.Header.Values("Cache-Control")
			for _, bad := range []string{"public", "s-maxage"} {
				if hasForbiddenDirective(cc, bad) {
					t.Fatalf("Cache-Control = %q ships %s beside a borgo session cookie on an embedder mux", cc, bad)
				}
			}
			if !hasBareDirective(cc, "private") {
				t.Fatalf("Cache-Control = %q, want a bare private", cc)
			}
		})
	}
}

// borgo.Middleware's doc says Serve is defined in terms of it; that is one
// line in serveContext and every other test builds the chain itself, so this
// one goes through borgo's own listener. The handler sets Cache-Control after
// the cookie and writes nothing: the order no call-site guard can close, and
// the ending net/http finishes on the handler's behalf. borgo.Cache would
// have passed either way, through SetSession's own call.
func TestBorgosOwnServerInstallsTheGuard(t *testing.T) {
	restoreRegistry(t)
	t.Setenv("SESSION_SECRET", strings.Repeat("k", 32))
	port := freePort(t)
	t.Setenv("API_PORT", port)

	Handle("GET /session", func(w http.ResponseWriter, r *http.Request) {
		if err := SetSession(w, map[string]string{"user": "luigi"}, time.Hour); err != nil {
			t.Errorf("setup: %v", err)
		}
		w.Header().Set("Cache-Control", "public, max-age=300")
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- ServeContext(ctx) }()

	var res *http.Response
	deadline := time.Now().Add(10 * time.Second)
	for {
		var err error
		res, err = http.Get("http://127.0.0.1:" + port + "/session")
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("borgo never came up on :%s (%v)", port, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()

	if len(res.Header.Values("Set-Cookie")) == 0 {
		t.Fatal("no Set-Cookie on the wire; the case proves nothing")
	}
	cc := res.Header.Values("Cache-Control")
	if hasForbiddenDirective(cc, "public") || !hasBareDirective(cc, "private") {
		t.Fatalf("Cache-Control = %q on a session response from borgo's own server", cc)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("ServeContext did not return")
	}
}

// The orders a call-site guard cannot close: anything that sets
// Cache-Control after the cookie, and borgo ships two such setters itself,
// SSE and NoCache. borgo.Middleware is what closes them for an embedder.
// Each case runs the same handler bare, where it is documented to be the
// app's problem, and wrapped, where the property must hold.
func TestMiddlewareClosesTheOrdersACallSiteGuardCannot(t *testing.T) {
	t.Setenv("SESSION_SECRET", strings.Repeat("k", 32))

	cases := []struct {
		name string
		run  func(w http.ResponseWriter, r *http.Request)
	}{
		// sse.go sets Cache-Control: no-cache, after the cookie
		{"session then SSE", func(w http.ResponseWriter, r *http.Request) {
			if err := SetSession(w, map[string]string{"user": "luigi"}, time.Hour); err != nil {
				t.Errorf("setup: %v", err)
				return
			}
			if _, err := SSE(w, r); err != nil {
				t.Errorf("setup: %v", err)
			}
		}},
		{"session then NoCache", func(w http.ResponseWriter, r *http.Request) {
			if err := SetSession(w, map[string]string{"user": "luigi"}, time.Hour); err != nil {
				t.Errorf("setup: %v", err)
				return
			}
			NoCache(w)
		}},
		{"session then a hand-written public", func(w http.ResponseWriter, r *http.Request) {
			if err := SetSession(w, map[string]string{"user": "luigi"}, time.Hour); err != nil {
				t.Errorf("setup: %v", err)
				return
			}
			w.Header().Set("Cache-Control", "public, max-age=60")
		}},
		// no borgo call in the response's path at all
		{"a hand-written cookie beside a hand-written public", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "public, max-age=60")
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "x"})
		}},
	}

	get := func(t *testing.T, h http.Handler) []string {
		srv := httptest.NewServer(h)
		defer srv.Close()
		res, err := http.Get(srv.URL)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if len(res.Header.Values("Set-Cookie")) == 0 {
			t.Fatal("no Set-Cookie on the wire; the case proves nothing")
		}
		return res.Header.Values("Cache-Control")
	}

	for _, c := range cases {
		t.Run(c.name+"/wrapped in borgo.Middleware", func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/", c.run)
			cc := get(t, Middleware(mux))
			for _, bad := range []string{"public", "s-maxage"} {
				if hasForbiddenDirective(cc, bad) {
					t.Fatalf("Cache-Control = %q ships %s through borgo.Middleware", cc, bad)
				}
			}
			if !hasBareDirective(cc, "private") {
				t.Fatalf("Cache-Control = %q, want a bare private: borgo.Middleware is the guarantee an embedder is told to rely on", cc)
			}
		})

		// the other side of the boundary, pinned: the responses cache.go documents
		// as the app's own. The test to change if that boundary moves
		t.Run(c.name+"/bare mux, documented as the app's", func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/", c.run)
			t.Logf("unwrapped, Cache-Control = %q", get(t, mux))
		})
	}
}

// The guard adds `private`, removes `public` and `s-maxage`, and changes
// nothing else: it must not invent a header, touch a cookieless response, or
// drop a directive it was not there to change. The `no-store is untouched`
// and `publicish` rows demand a `private` appended: stricter, not relaxed.
func TestPrivateIfCookiesOnlyNarrows(t *testing.T) {
	cases := []struct {
		name    string
		cookie  bool
		initial []string
		want    []string
	}{
		{"no cookie leaves public alone", false, []string{"public, max-age=60"}, []string{"public, max-age=60"}},
		{"no cookie and no header stays empty", false, nil, nil},
		{"a cookie with no Cache-Control invents none", true, nil, nil},
		{"already private is untouched", true, []string{"private, max-age=60"}, []string{"private, max-age=60"}},
		{"no-store gains a private and keeps its no-store", true, []string{"no-store"}, []string{"private, no-store"}},
		{"public is downgraded, the rest of the value kept", true, []string{"public, max-age=60, stale-while-revalidate=600"}, []string{"private, max-age=60, stale-while-revalidate=600"}},
		// "public-something" is not the public directive
		{"a directive merely starting with public is not public", true, []string{"publicish, max-age=60"}, []string{"private, publicish, max-age=60"}},
		// case-insensitive, and need not come first
		{"uppercase PUBLIC is still the public directive", true, []string{"PUBLIC, max-age=60"}, []string{"private, max-age=60"}},
		{"public last in the list is found too", true, []string{"max-age=60, public"}, []string{"max-age=60, private"}},
		// repeated lines are one directive list, and come back as the single value
		// they were read as: the same value, since RFC 9110 5.3 makes the join the
		// meaning
		{"a second line is not deleted by the downgrade", true, []string{"public, max-age=60", "no-store"}, []string{"private, max-age=60, no-store"}},
		{"public on the second line is found", true, []string{"no-store", "public"}, []string{"no-store, private"}},
		{"public on every line is downgraded on every line", true, []string{"public", "max-age=60, PUBLIC"}, []string{"private, max-age=60, private"}},
		{"no cookie leaves a multi-line value alone", false, []string{"public, max-age=60", "no-store"}, []string{"public, max-age=60", "no-store"}},
		{"a multi-line value with nothing to change is not collapsed", true, []string{"private", "max-age=60"}, []string{"private", "max-age=60"}},
		{"nor is one whose quoted argument stays on its own line", true, []string{`private, no-cache="a, public"`, "max-age=60"}, []string{`private, no-cache="a, public"`, "max-age=60"}},
		// the one exception to "unchanged means untouched": only the join shows
		// that the bare `public` on its own line is inside an argument
		{"a quoted span crossing a line is emitted joined even when nothing changed", true,
			[]string{`private, no-cache="a`, "public", "s-maxage=600", `b"`},
			[]string{`private, no-cache="a,public,s-maxage=600,b"`}},
		{"a crossing span with no bare private still gets one, joined", true,
			[]string{`no-cache="a`, "public", `b"`},
			[]string{`private, no-cache="a,public,b"`}},
		// an unterminated quote opens nothing, so it crosses nothing: the crossing
		// scan must agree with splitDirectives, or the exception fires on a value
		// the guard itself reads as unquoted
		{"an unterminated quote is not a crossing span", true, []string{"private", `x="`}, []string{"private", `x="`}},
		{"nor does an unterminated quote cross a later boundary", true, []string{"private", `x="`, "max-age=60"}, []string{"private", `x="`, "max-age=60"}},
		// an earlier line's unterminated quote hides a later line's private from
		// every strict reader
		{"a private on a later line does not count behind an earlier open quote", true,
			[]string{"max-age=31536000, immutable", `no-cache="a`, "private"},
			[]string{`private, max-age=31536000, immutable, no-cache="a, private`}},
		{"an open quote on line one does not hide a public on line two", true,
			[]string{`x="`, "public"},
			[]string{`private, x=", private`}},
		{"an open quote on line one does not hide an s-maxage on line two", true,
			[]string{`x="`, "s-maxage=600"},
			[]string{`private, x="`}},
		// s-maxage is the other directive addressed to shared caches
		{"s-maxage goes and a private replaces it", true, []string{"s-maxage=600, max-age=60"}, []string{"private, max-age=60"}},
		{"s-maxage last goes too", true, []string{"max-age=60, s-maxage=600"}, []string{"private, max-age=60"}},
		{"s-maxage alone becomes private", true, []string{"s-maxage=600"}, []string{"private"}},
		{"uppercase S-MAXAGE goes too", true, []string{"S-MaxAge=600, max-age=60"}, []string{"private, max-age=60"}},
		// the contradiction `private, s-maxage` would be
		{"public beside s-maxage leaves one private and no s-maxage", true, []string{"public, s-maxage=600"}, []string{"private"}},
		{"a line emptied by the drop is not emitted blank", true, []string{"public", "s-maxage=600"}, []string{"private"}},
		{"an existing private is not duplicated when s-maxage goes", true, []string{"private, s-maxage=600"}, []string{"private"}},
		{"s-maxage on a second line is found", true, []string{"no-store", "s-maxage=600"}, []string{"private, no-store"}},
		// max-age is deliberately kept: it is legitimate for a private cache
		{"max-age alone is kept, with a private added", true, []string{"max-age=60"}, []string{"private, max-age=60"}},
		// quoted arguments are field-name lists, not directive lists
		{"a public inside a quoted argument is not a directive", true, []string{`no-cache="a, public, b", max-age=60`}, []string{`private, no-cache="a, public, b", max-age=60`}},
		{"a quoted argument ending in public is not a directive either", true, []string{`no-cache="a, public"`}, []string{`private, no-cache="a, public"`}},
		{"a real public beside a quoted one is still downgraded", true, []string{`no-cache="a, public", public`}, []string{`no-cache="a, public", private`}},
		// the tokens after an unterminated quote are directives to any cache that
		// splits on commas, so they are directives here too
		{"an unterminated quote does not hide s-maxage", true, []string{`x=", s-maxage=600`}, []string{`private, x="`}},
		{"an unterminated quote does not hide public", true, []string{`s-maxage=600, x=", public`}, []string{`private, x=", private`}},
		{"the added private is not swallowed by an open string", true, []string{`max-age=600, x="`}, []string{`private, max-age=600, x="`}},
		{"an escaped quote inside a balanced argument is not an opener", true, []string{`no-cache="a\", public", max-age=60`}, []string{`private, no-cache="a\", public", max-age=60`}},
		// RFC 9111 5.2.2.7: private="X" leaves the response storable by a shared cache
		{"a qualified private does not satisfy the guard", true, []string{`private="X", max-age=600`}, []string{`private, private="X", max-age=600`}},
		{"a qualified private beside public still gets a bare one", true, []string{`private="X", public`}, []string{`private="X", private`}},
		// an empty list element carries no directive (RFC 9110 5.6.1.2)
		{"an empty element is dropped when the guard rewrites", true, []string{"public,,max-age=1"}, []string{"private, max-age=1"}},
		{"a lone empty value does not grow an empty field", true, []string{""}, []string{"private"}},
		{"an empty element is left alone when nothing else changes", true, []string{"private,,max-age=1"}, []string{"private,,max-age=1"}},
		// a guard that deletes what it cannot parse is not one that only narrows
		{"a malformed element is kept, not deleted", true, []string{"max-age=60, =weird"}, []string{"private, max-age=60, =weird"}},
		{"a second run changes nothing", true, []string{"private, max-age=60"}, []string{"private, max-age=60"}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := http.Header{}
			for _, v := range c.initial {
				h.Add("Cache-Control", v)
			}
			if c.cookie {
				h.Add("Set-Cookie", "a=1")
			}
			privateIfCookies(h)
			got := h.Values("Cache-Control")
			if !slices.Equal(got, c.want) {
				t.Fatalf("Cache-Control = %q, want %q", got, c.want)
			}
		})
	}
}

// read off a raw connection, not through http.Client: its parser
// canonicalises every key, so a `cache-control` and a `Cache-Control` entry
// are one key in res.Header and a client-side assertion cannot tell a guarded
// response from a leaking one
func wireHeaderLines(t *testing.T, h http.Handler) []string {
	t.Helper()
	srv := httptest.NewServer(h)
	defer srv.Close()
	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: %s\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n", srv.Listener.Addr())
	b, err := io.ReadAll(conn)
	if err != nil {
		t.Fatal(err)
	}
	head, _, ok := strings.Cut(string(b), "\r\n\r\n")
	if !ok {
		t.Fatalf("no header block on the wire: %q", b)
	}
	return strings.Split(head, "\r\n")[1:]
}

// The key a header was spelled with does not decide whether the guard sees
// it: net/http's writer emits the map as it finds it, h.Values canonicalises
// the key it looks up. Every row here except both-canonical once shipped
// `public, s-maxage=600` beside a Set-Cookie, and with a Cache-Control under
// both spellings the guard rewrote the half it could read and emitted
// `private, max-age=60` next to a surviving `cache-control: public,
// s-maxage=600`, one field to the cache that joins them. The assertion is on
// the bytes.
func TestTheGuardReadsAHeaderUnderEverySpellingOfItsKey(t *testing.T) {
	type staging struct {
		name string
		set  func(h http.Header)
	}
	cookies := []staging{
		{"canonical", func(h http.Header) { h["Set-Cookie"] = []string{"sid=abc; Path=/"} }},
		{"lowercase", func(h http.Header) { h["set-cookie"] = []string{"sid=abc; Path=/"} }},
		{"uppercase", func(h http.Header) { h["SET-COOKIE"] = []string{"sid=abc; Path=/"} }},
		{"two canonical", func(h http.Header) { h["Set-Cookie"] = []string{"a=1", "sid=abc"} }},
		{"two lowercase", func(h http.Header) { h["set-cookie"] = []string{"a=1", "sid=abc"} }},
		{"both spellings", func(h http.Header) {
			h["Set-Cookie"] = []string{"a=1"}
			h["set-cookie"] = []string{"sid=abc"}
		}},
	}
	controls := []staging{
		{"canonical", func(h http.Header) { h["Cache-Control"] = []string{"public, s-maxage=600"} }},
		{"lowercase", func(h http.Header) { h["cache-control"] = []string{"public, s-maxage=600"} }},
		{"uppercase", func(h http.Header) { h["CACHE-CONTROL"] = []string{"public, s-maxage=600"} }},
		{"two canonical", func(h http.Header) { h["Cache-Control"] = []string{"public", "s-maxage=600"} }},
		{"two lowercase", func(h http.Header) { h["cache-control"] = []string{"public", "s-maxage=600"} }},
		// the row the guard once got wrong rather than missed
		{"both spellings", func(h http.Header) {
			h["Cache-Control"] = []string{"max-age=60"}
			h["cache-control"] = []string{"public, s-maxage=600"}
		}},
	}

	for _, ck := range cookies {
		for _, cc := range controls {
			t.Run(ck.name+" cookie/"+cc.name+" control", func(t *testing.T) {
				lines := wireHeaderLines(t, recoverMiddleware(gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					ck.set(w.Header())
					cc.set(w.Header())
					w.Write([]byte("body"))
				}))))

				var cookie, control []string
				for _, l := range lines {
					k, v, _ := strings.Cut(l, ":")
					switch {
					case strings.EqualFold(k, "set-cookie"):
						cookie = append(cookie, v)
					case strings.EqualFold(k, "cache-control"):
						control = append(control, v)
					}
				}
				if len(cookie) == 0 {
					t.Fatal("no Set-Cookie reached the wire under any spelling; the case proves nothing")
				}
				if len(control) == 0 {
					t.Fatal("no Cache-Control reached the wire under any spelling; the case proves nothing")
				}
				// every line, whatever key it arrived under: a cache reads them
				// case-insensitively and joins them into one value
				for _, bad := range []string{"public", "s-maxage"} {
					if hasForbiddenDirective(control, bad) {
						t.Fatalf("Cache-Control = %q ships %s on a response carrying Set-Cookie: a shared cache may store it and hand this session to the next requester", control, bad)
					}
				}
				if !hasBareDirective(control, "private") {
					t.Fatalf("Cache-Control = %q carries no bare private on a response carrying Set-Cookie", control)
				}
			})
		}
	}
}

// measured rather than asserted small: proportional to the number of header
// keys and independent of the matcher (one that returns false without looking
// benchmarks the same). For scale, the gzip path clones the same map at
// WriteHeader and re-copies it at commit.
func benchmarkGuard(b *testing.B, keys int) {
	h := http.Header{}
	filler := []string{"Content-Type", "Content-Length", "Date", "Vary", "Etag", "Last-Modified", "Server", "X-Request-Id", "X-Frame-Options", "Content-Security-Policy", "Referrer-Policy", "X-Content-Type-Options", "Strict-Transport-Security", "Accept-Ranges", "Age", "Link", "X-A", "X-B", "X-C", "X-D", "X-E", "X-F", "X-G", "X-H", "X-I", "X-J", "X-K", "X-L", "X-M", "X-N"}
	for i := 0; i < keys && i < len(filler); i++ {
		h.Set(filler[i], "v")
	}
	h.Set("Cache-Control", "public, max-age=60")
	// no cookie: the common path, and the one that leaves the map untouched
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		privateIfCookies(h)
	}
}

func BenchmarkPrivateIfCookiesSmallResponse(b *testing.B) { benchmarkGuard(b, 3) }
func BenchmarkPrivateIfCookiesLargeResponse(b *testing.B) { benchmarkGuard(b, 30) }
