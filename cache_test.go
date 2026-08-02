package borgo

import (
	"context"
	"io"
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

// stripQuoted blanks out the quoted arguments of a Cache-Control line, so a
// header field name inside a no-cache list is not read as a directive. It is
// deliberately a different implementation from cache.go's splitter: a test that
// reuses the code under test cannot disagree with it.
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

// hasDirective reports whether a directive of that name is present anywhere
// across every Cache-Control line, under the strict reading: a quoted argument
// is an argument, and an unterminated quote runs to the end of the line. A
// response's Cache-Control is one directive list that may arrive split over
// repeated lines, so a check that reads only the first line reads only part of
// the answer - which is the shape of the bug this file exists to hold shut.
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

// stripBalancedQuoted blanks out only the quoted arguments that are actually
// closed. An unterminated quote is left as an ordinary character, so the tokens
// after it stay visible.
//
// This is the reading a forbidden directive is hunted under, and the asymmetry
// with stripQuoted is the point. A balanced argument belongs to the handler and
// is preserved verbatim, so a `public` inside one is not the guard's to remove
// and not the guard's to be failed for. An unterminated quote is where a strict
// parser and a comma-splitting CDN disagree, and a directive that only one of
// them can see is still a directive some cache will obey.
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

// hasForbiddenDirective looks for a directive that must never reach the wire
// beside a Set-Cookie, under the reading described on stripBalancedQuoted.
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

// hasBareDirective is hasDirective restricted to the bare token, with no
// ="argument" after it. RFC 9111 5.2.2.7 makes private="X" a statement about
// the named header fields that leaves the response as a whole storable by a
// shared cache, so only the bare form counts as this response saying it is
// private.
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

// rawContains looks at the bytes of the header lines themselves, for the
// assertions about what survived verbatim.
func rawContains(values []string, s string) bool {
	for _, v := range values {
		if strings.Contains(v, s) {
			return true
		}
	}
	return false
}

// A RESPONSE CARRYING A SET-COOKIE MUST NEVER SHIP `public`, HOWEVER THE
// HANDLER ENDS AND HOWEVER THE HEADER WAS SPELLED.
//
// RFC 9111 3.5 lists `public` as one of the directives that authorises a shared
// cache to store a Set-Cookie response, so this is the exact combination that
// hands one user's session to the next requester through a CDN.
//
// This test replaces TestCacheIsPrivateWhateverOrderTheCookieWasSetIn, which
// asserted the same property on one axis only - the order Cache and SetSession
// were called in - and could not see two live defects because of what it held
// fixed. Every one of its cases ended in w.Write, so the guard was always
// reached through a commit hook and a handler that writes nothing was never
// tried; and it read the header through a ResponseRecorder, which shows the
// staged map rather than what net/http emits for a handler that never writes.
// Both axes are now variables: how the handler ends, and whether the client
// takes gzip. The assertions are made on the bytes a real server put on the
// wire.
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
		// the order that used to ship `public` on a response carrying a session
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
		// the guard narrows, so it must not delete a stricter directive the
		// handler added on a line of its own: dropping no-store lets a private
		// cache store a response the handler forbade storing, which is the
		// guard widening what it was asked for
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
		// s-maxage is the directive addressed to shared caches by definition,
		// and RFC 9111 3.5 lists it beside public as authorising the storage of
		// a Set-Cookie response. The guard replaced the literal token `public`
		// and nothing else, so this shipped as written
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
		// the contradiction the guard used to manufacture out of this one:
		// `private, s-maxage=600` tells a shared cache both that it may not
		// store the response and how long to keep it
		{"public beside s-maxage leaves no contradiction", func(w http.ResponseWriter) error {
			w.Header().Set("Cache-Control", "public, s-maxage=600")
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if !hasDirective(v, "private") {
				t.Errorf("Cache-Control = %q, want private", v)
			}
		}},
		// the argument of no-cache is a comma-separated list of header field
		// names, not a list of directives: rewriting a `public` inside it named
		// a field that does not exist and stopped revalidating the one that did
		{"a public inside a quoted argument is left alone", func(w http.ResponseWriter) error {
			w.Header().Set("Cache-Control", `no-cache="a, public, b", max-age=60`)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if !rawContains(v, `no-cache="a, public, b"`) {
				t.Errorf("Cache-Control = %q, want the handler's no-cache field list untouched", v)
			}
		}},
		// an unterminated quote is where the strict and lenient readings of a
		// Cache-Control line disagree, and it is reachable the moment any part
		// of the value is interpolated. Treating it as opening a string hid
		// these directives from the guard while a lenient cache obeyed them
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
		// the value is the comma-join of every line: a private on a later line
		// is behind an earlier line's open quote and reaches no strict reader,
		// however plausible it looks in the header map
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
		// the shape the guard used to leave alone because nothing needed
		// changing: a bare `public` and a bare `s-maxage` each alone on a line,
		// inside a quoted argument opened on an earlier line and closed on a
		// later one. Safe under the join, and a bare token on its own line to
		// any reader that does not join first
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
		// the sibling that must stay as it arrived: same multi-line value, no
		// quoted span crossing a boundary, so every reader partitions it alike
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
		// private="X" makes only the named fields private and leaves the
		// response storable by a shared cache (RFC 9111 5.2.2.7), so it does
		// not satisfy the guard
		{"a qualified private does not count as private", func(w http.ResponseWriter) error {
			w.Header().Set("Cache-Control", `private="X-Thing", max-age=600`)
			return SetSession(w, map[string]string{"user": "luigi"}, time.Hour)
		}, func(t *testing.T, v []string) {
			if !rawContains(v, `private="X-Thing"`) {
				t.Errorf("Cache-Control = %q, want the handler's qualified private kept", v)
			}
		}},
	}

	// how the handler ends: the guard used to hang off the commit hooks, so
	// only the rows that write anything at all reached it
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
					// RFC 9111 3.5 authorises a shared cache to store a
					// Set-Cookie response on either of these, so neither may
					// reach the wire beside one - under either reading of the
					// line, because either is a cache someone runs
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

// The guard runs up to four times on one response - Cache, SetSession or
// ClearSession, the gzip commit, and recoverMiddleware's exit - so a pass that
// cannot see what the pass before it did does not merely waste work, it keeps
// changing a response that was already settled. `private` accumulated without
// bound on any value with an unterminated quote, because judging the added
// token per line meant no pass recognised its own predecessor.
//
// A fixed point after the first pass is the property, not a smaller number of
// duplicates, so this asserts stability from pass two rather than counting.
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

// BORGO'S OWN SESSION COOKIE IS GUARDED WITHOUT BORGO'S PIPELINE.
//
// recoverMiddleware's exit only exists inside the chain borgo.Serve builds, and
// session.go treats mounting these handlers on your own server as supported. On
// such a mux the guard fell all the way back to the one-shot inside Cache, so
// the order dependence was live again: session-then-cache came out private and
// cache-then-session shipped `public` on a response carrying a session, which
// is the quiet half of the pair. SetSession and ClearSession now enforce it
// themselves, at the one moment borgo knows a Set-Cookie is going out whatever
// server it is running under.
//
// No middleware here on purpose. Wrapping it would test the thing that already
// worked.
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

// borgo.Middleware's doc tells an embedder that Serve is defined in terms of it
// and that the two cannot drift apart. That is a claim about a single line in
// serveContext, and nothing held it: routing Serve around the chain left every
// other test in this file green, because they all build the chain themselves.
// This one goes through borgo's own listener instead.
//
// The handler sets its Cache-Control after the cookie and then writes nothing,
// which is deliberate on both counts: the order is one no call-site guard can
// close, and the ending is the response net/http finishes on the handler's
// behalf. Only the commit-time guard answers it, so this fails if borgo's own
// server ever stops installing the chain. A handler using borgo.Cache would
// have passed either way - SetSession's best-effort call covers that order -
// and would have made the test green for the wrong reason.
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

// THE ORDERS A CALL-SITE GUARD CANNOT CLOSE, AND THE ONE-LINER THAT DOES.
//
// Guarding at SetSession closed cache-then-session on an embedder mux and
// mirrored the order dependence rather than removing it: anything that sets
// Cache-Control after the cookie escapes. borgo ships two such setters itself,
// SSE and NoCache, so this needs no unusual handler at all - an authenticated
// event stream is enough.
//
// The answer is not a third call-site guard. It is borgo.Middleware, which
// gives an embedder the commit-time guard borgo's own server has. Each case
// runs the same handler twice: bare, where it is documented to be the app's
// problem, and wrapped, where the property must hold.
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

		// the other side of the boundary, pinned so the next reader finds a
		// decision and not a gap. These are the responses cache.go documents as
		// the app's own; the test to change if that boundary moves
		t.Run(c.name+"/bare mux, documented as the app's", func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/", c.run)
			t.Logf("unwrapped, Cache-Control = %q", get(t, mux))
		})
	}
}

// The guard adds `private`, removes the two directives that authorise a shared
// cache to store a Set-Cookie response, and changes nothing else: it must not
// invent a header, touch a response with no cookie, or drop a directive it was
// not there to change.
//
// The `no-store is untouched` and `publicish` rows changed with the rule: they
// now come back with a `private` appended. That is not a test relaxed to stay
// green - the assertion is stricter than it was, and the output it now demands
// is narrower. The reason for adding `private` even where nothing authorised
// sharing is in cache.go: it makes the rule one sentence, and it covers
// must-revalidate - the third directive RFC 9111 3.5 lists - without a case of
// its own.
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
		// the directive name is case-insensitive, and need not come first
		{"uppercase PUBLIC is still the public directive", true, []string{"PUBLIC, max-age=60"}, []string{"private, max-age=60"}},
		{"public last in the list is found too", true, []string{"max-age=60, public"}, []string{"max-age=60, private"}},
		// repeated header lines are one directive list. Every line is read, and
		// a response the guard rewrites comes back as the single value it was
		// read as - which is the same value, since RFC 9110 5.3 makes the join
		// the meaning. Nothing is dropped and the order is the order
		{"a second line is not deleted by the downgrade", true, []string{"public, max-age=60", "no-store"}, []string{"private, max-age=60, no-store"}},
		{"public on the second line is found", true, []string{"no-store", "public"}, []string{"no-store, private"}},
		{"public on every line is downgraded on every line", true, []string{"public", "max-age=60, PUBLIC"}, []string{"private, max-age=60, private"}},
		{"no cookie leaves a multi-line value alone", false, []string{"public, max-age=60", "no-store"}, []string{"public, max-age=60", "no-store"}},
		{"a multi-line value with nothing to change is not collapsed", true, []string{"private", "max-age=60"}, []string{"private", "max-age=60"}},
		{"nor is one whose quoted argument stays on its own line", true, []string{`private, no-cache="a, public"`, "max-age=60"}, []string{`private, no-cache="a, public"`, "max-age=60"}},
		// the one exception to "unchanged means untouched": a quoted span
		// crossing a line boundary is read one way by a reader that joins the
		// lines and another by a reader that does not, and only the join shows
		// that the bare `public` on its own line is inside an argument
		{"a quoted span crossing a line is emitted joined even when nothing changed", true,
			[]string{`private, no-cache="a`, "public", "s-maxage=600", `b"`},
			[]string{`private, no-cache="a,public,s-maxage=600,b"`}},
		{"a crossing span with no bare private still gets one, joined", true,
			[]string{`no-cache="a`, "public", `b"`},
			[]string{`private, no-cache="a,public,b"`}},
		// an unterminated quote opens nothing, so it crosses nothing: the
		// crossing scan has to agree with splitDirectives about which quotes
		// open anything at all, or the exception fires on a value the guard
		// itself reads as unquoted
		{"an unterminated quote is not a crossing span", true, []string{"private", `x="`}, []string{"private", `x="`}},
		{"nor does an unterminated quote cross a later boundary", true, []string{"private", `x="`, "max-age=60"}, []string{"private", `x="`, "max-age=60"}},
		// the reachability of a private is a property of the joined value, not
		// of the line it sits on: an earlier line's unterminated quote hides a
		// later line's private from every strict reader
		{"a private on a later line does not count behind an earlier open quote", true,
			[]string{"max-age=31536000, immutable", `no-cache="a`, "private"},
			[]string{`private, max-age=31536000, immutable, no-cache="a, private`}},
		{"an open quote on line one does not hide a public on line two", true,
			[]string{`x="`, "public"},
			[]string{`private, x=", private`}},
		{"an open quote on line one does not hide an s-maxage on line two", true,
			[]string{`x="`, "s-maxage=600"},
			[]string{`private, x="`}},
		// s-maxage is the other directive RFC 9111 3.5 authorises sharing on
		{"s-maxage goes and a private replaces it", true, []string{"s-maxage=600, max-age=60"}, []string{"private, max-age=60"}},
		{"s-maxage last goes too", true, []string{"max-age=60, s-maxage=600"}, []string{"private, max-age=60"}},
		{"s-maxage alone becomes private", true, []string{"s-maxage=600"}, []string{"private"}},
		{"uppercase S-MAXAGE goes too", true, []string{"S-MaxAge=600, max-age=60"}, []string{"private, max-age=60"}},
		// the contradiction the guard used to manufacture
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
		// an unterminated quote does not open a string: the tokens after it are
		// directives to any cache that splits on commas, so they are directives
		// here too
		{"an unterminated quote does not hide s-maxage", true, []string{`x=", s-maxage=600`}, []string{`private, x="`}},
		{"an unterminated quote does not hide public", true, []string{`s-maxage=600, x=", public`}, []string{`private, x=", private`}},
		{"the added private is not swallowed by an open string", true, []string{`max-age=600, x="`}, []string{`private, max-age=600, x="`}},
		{"an escaped quote inside a balanced argument is not an opener", true, []string{`no-cache="a\", public", max-age=60`}, []string{`private, no-cache="a\", public", max-age=60`}},
		// RFC 9111 5.2.2.7: private="X" is about the named fields only and
		// leaves the response storable by a shared cache
		{"a qualified private does not satisfy the guard", true, []string{`private="X", max-age=600`}, []string{`private, private="X", max-age=600`}},
		{"a qualified private beside public still gets a bare one", true, []string{`private="X", public`}, []string{`private="X", private`}},
		// an empty list element carries no directive (RFC 9110 5.6.1)
		{"an empty element is dropped when the guard rewrites", true, []string{"public,,max-age=1"}, []string{"private, max-age=1"}},
		{"a lone empty value does not grow an empty field", true, []string{""}, []string{"private"}},
		{"an empty element is left alone when nothing else changes", true, []string{"private,,max-age=1"}, []string{"private,,max-age=1"}},
		// a malformed element still carries characters, and a guard that
		// deletes what it cannot parse is not one that only narrows
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
