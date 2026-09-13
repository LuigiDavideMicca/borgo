package borgo

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// a render service that answers the same page every time, counting renders
func countingRenderer(page func(*http.Request) (int, http.Header, string)) (sharedRenderer, *int32) {
	var n int32
	return func(r *http.Request) (int, http.Header, string, error) {
		atomic.AddInt32(&n, 1)
		s, h, b := page(r)
		return s, h, b, nil
	}, &n
}

func plainPage(body string) func(*http.Request) (int, http.Header, string) {
	return func(*http.Request) (int, http.Header, string) {
		h := http.Header{}
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Cache-Control", "private, no-store")
		h.Set("Vary", "Accept-Encoding")
		return 200, h, body
	}
}

// saveEntry is fire and forget - a disk that stopped taking writes must not
// slow a response down - so a test that looks at the directory has to wait
// for the writer, and a test that RETURNS without waiting races t.TempDir s
// cleanup: "RemoveAll cleanup: directory not empty", red about 40% of the
// time on windows for TestIsrSweepsATornPair (found by the verifier of this
// phase, whose mutation signal it polluted).
//
// Waiting meant counting entries, and that was not enough: a save writes two
// temp files and renames them one at a time, so every step of it already
// shows two entries. The wait returned before the renames and the cleanup
// still raced them, under the load of the full suite - so it waits for
// settled names and no temp file.
func waitForPairs(t *testing.T, dir string, want int) {
	t.Helper()
	count := func() (settled, saving int) {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if strings.Contains(e.Name(), ".tmp.") {
				saving++
			} else {
				settled++
			}
		}
		return settled, saving
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if settled, saving := count(); settled == want && saving == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	settled, saving := count()
	t.Fatalf("the persist directory holds %d settled files and %d mid-save after 2s, want %d settled", settled, saving, want)
}

// waitFor is for the concurrency tests: they build a burst against a render
// that is provably still running, and a sleep would either be flaky or slow.
func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func serve(t *testing.T, i *isr, policy *isrPolicy, path string, headers ...string) (*httptest.ResponseRecorder, isrOutcome) {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	for k := 0; k+1 < len(headers); k += 2 {
		req.Header.Set(headers[k], headers[k+1])
	}
	w := httptest.NewRecorder()
	return w, i.handle(w, req, policy)
}

func TestIsrServesOneRenderToEveryone(t *testing.T) {
	render, n := countingRenderer(plainPage("<html>news</html>"))
	i := newIsr(render, nil, func(string) {})
	policy := &isrPolicy{seconds: 300}

	w, out := serve(t, i, policy, "/news")
	if out != isrServed || w.Code != 200 || w.Header().Get(cacheStateHeader) != "miss" || w.Body.String() != "<html>news</html>" {
		t.Fatalf("first: %v %d %q %q", out, w.Code, w.Header().Get(cacheStateHeader), w.Body.String())
	}
	w, _ = serve(t, i, policy, "/news")
	if w.Header().Get(cacheStateHeader) != "hit" {
		t.Errorf("second: %q", w.Header().Get(cacheStateHeader))
	}
	if atomic.LoadInt32(n) != 1 {
		t.Errorf("rendered %d times for two requests", *n)
	}
	// the query string is part of the key
	w, _ = serve(t, i, policy, "/news?page=2")
	if w.Header().Get(cacheStateHeader) != "miss" {
		t.Errorf("a query variant: %q", w.Header().Get(cacheStateHeader))
	}
	// gzip is negotiated per replay from the one stored identity
	w, _ = serve(t, i, policy, "/news", "Accept-Encoding", "gzip")
	if w.Header().Get("Content-Encoding") != "gzip" || w.Body.Len() == 0 {
		t.Errorf("gzip replay: %q", w.Header().Get("Content-Encoding"))
	}
	w, _ = serve(t, i, policy, "/news")
	if w.Header().Get("Content-Encoding") != "" {
		t.Errorf("identity replay was coded: %q", w.Header().Get("Content-Encoding"))
	}
}

func TestIsrStaleWhileRevalidate(t *testing.T) {
	render, n := countingRenderer(plainPage("<html>v</html>"))
	i := newIsr(render, nil, func(string) {})
	now := time.Now()
	i.now = func() time.Time { return now }
	policy := &isrPolicy{seconds: 10}

	serve(t, i, policy, "/p")
	now = now.Add(11 * time.Second)
	w, _ := serve(t, i, policy, "/p")
	if w.Header().Get(cacheStateHeader) != "stale" {
		t.Fatalf("past the window: %q", w.Header().Get(cacheStateHeader))
	}
	// the regeneration ran in the background, once
	deadline := time.Now().Add(2 * time.Second)
	for atomic.LoadInt32(n) < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if atomic.LoadInt32(n) != 2 {
		t.Errorf("renders: %d", *n)
	}
	// "manual" is never stale by clock
	manual := &isrPolicy{manual: true}
	serve(t, i, manual, "/m")
	now = now.Add(24 * time.Hour)
	w, _ = serve(t, i, manual, "/m")
	if w.Header().Get(cacheStateHeader) != "hit" {
		t.Errorf("manual after a day: %q", w.Header().Get(cacheStateHeader))
	}
}

func TestIsrRefusesWhatCannotBeShared(t *testing.T) {
	cases := map[string]func(*http.Request) (int, http.Header, string){
		"cookie": func(r *http.Request) (int, http.Header, string) {
			_, h, b := plainPage("<html/>")(r)
			h.Add("Set-Cookie", "borgo_session=x")
			return 200, h, b
		},
		"csrf field": plainPage(`<html><form><input type="hidden" name="__borgo_csrf" value=""></form></html>`),
		"foreign nonce": func(r *http.Request) (int, http.Header, string) {
			_, h, b := plainPage(`<html><script nonce="abc">1</script></html>`)(r)
			h.Set("Content-Security-Policy", "script-src 'self' 'nonce-xyz'")
			return 200, h, b
		},
		"errored render": func(r *http.Request) (int, http.Header, string) {
			_, h, b := plainPage("<html>fallback</html>")(r)
			h.Set(renderErroredHeader, "a suspense boundary threw")
			return 200, h, b
		},
		"redirect": func(r *http.Request) (int, http.Header, string) {
			return 302, http.Header{"Location": {"/login"}}, ""
		},
		"coded body": func(r *http.Request) (int, http.Header, string) {
			_, h, b := plainPage("<html/>")(r)
			h.Set("Content-Encoding", "gzip")
			return 200, h, b
		},
	}
	for name, page := range cases {
		render, n := countingRenderer(page)
		var lines []string
		i := newIsr(render, nil, func(l string) { lines = append(lines, l) })
		policy := &isrPolicy{seconds: 300}
		_, out := serve(t, i, policy, "/x")
		if out != isrBypass {
			t.Errorf("%s: outcome %v, want bypass", name, out)
		}
		// remembered: the wasted anonymised render happens once per window
		serve(t, i, policy, "/x")
		if atomic.LoadInt32(n) != 1 {
			t.Errorf("%s: rendered %d times", name, *n)
		}
		if len(lines) != 1 || !strings.Contains(lines[0], "never cached") {
			t.Errorf("%s: said %v", name, lines)
		}
	}
}

func TestIsrRemintsTheNoncePerReplay(t *testing.T) {
	render, _ := countingRenderer(func(r *http.Request) (int, http.Header, string) {
		_, h, _ := plainPage("")(r)
		h.Set("Content-Security-Policy", "script-src 'self' 'nonce-render1'")
		return 200, h, `<html><script nonce="render1">a</script><script nonce="render1">b</script></html>`
	})
	i := newIsr(render, nil, func(string) {})
	minted := []string{"fresh1", "fresh2"}
	i.mint = func() string { m := minted[0]; minted = minted[1:]; return m }
	policy := &isrPolicy{seconds: 300}

	w1, _ := serve(t, i, policy, "/n")
	w2, _ := serve(t, i, policy, "/n")
	for _, c := range []struct {
		w     *httptest.ResponseRecorder
		nonce string
	}{{w1, "fresh1"}, {w2, "fresh2"}} {
		if !strings.Contains(c.w.Header().Get("Content-Security-Policy"), "'nonce-"+c.nonce+"'") {
			t.Errorf("csp %q", c.w.Header().Get("Content-Security-Policy"))
		}
		if strings.Count(c.w.Body.String(), `nonce="`+c.nonce+`"`) != 2 || strings.Contains(c.w.Body.String(), "render1") {
			t.Errorf("body %q", c.w.Body.String())
		}
	}
}

func TestIsrInvalidation(t *testing.T) {
	render, n := countingRenderer(plainPage("<html/>"))
	var lines []string
	i := newIsr(render, nil, func(l string) { lines = append(lines, l) })
	tagged := &isrPolicy{manual: true, tags: []string{"posts"}}
	plain := &isrPolicy{manual: true}

	serve(t, i, tagged, "/blog")
	serve(t, i, tagged, "/blog/one")
	serve(t, i, plain, "/about")
	serve(t, i, plain, "/blog?page=2")
	if got := i.invalidateTag(" posts "); got != 2 {
		t.Errorf("tag dropped %d", got)
	}
	if got := i.invalidatePath("/blog/*"); got != 1 {
		t.Errorf("prefix dropped %d (the query variant)", got)
	}
	if got := i.invalidatePath("/about"); got != 1 {
		t.Errorf("exact dropped %d", got)
	}
	if got := i.invalidatePath("/nope"); got != 0 {
		t.Errorf("nothing to drop: %d", got)
	}
	if atomic.LoadInt32(n) != 4 || len(lines) != 4 || !strings.Contains(lines[3], "0 cached copies") {
		t.Errorf("renders %d, log %v", *n, lines)
	}
	w, _ := serve(t, i, plain, "/about")
	if w.Header().Get(cacheStateHeader) != "miss" {
		t.Errorf("after invalidation: %q", w.Header().Get(cacheStateHeader))
	}
}

func TestIsrInvalidationLiftsARefusal(t *testing.T) {
	personal := true
	render, _ := countingRenderer(func(r *http.Request) (int, http.Header, string) {
		_, h, b := plainPage("<html/>")(r)
		if personal {
			h.Add("Set-Cookie", "x=1")
		}
		return 200, h, b
	})
	i := newIsr(render, nil, func(string) {})
	policy := &isrPolicy{manual: true, tags: []string{"me"}}
	if _, out := serve(t, i, policy, "/me"); out != isrBypass {
		t.Fatal("a cookie must refuse")
	}
	personal = false
	if _, out := serve(t, i, policy, "/me"); out != isrBypass {
		t.Fatal("the refusal is remembered under manual")
	}
	i.invalidateTag("me")
	if w, out := serve(t, i, policy, "/me"); out != isrServed || w.Header().Get(cacheStateHeader) != "miss" {
		t.Errorf("the operator's invalidation lifts the mark: %v %q", out, w.Header().Get(cacheStateHeader))
	}
}

func TestIsrPersistsAcrossARestartOfTheSameBuild(t *testing.T) {
	dir := t.TempDir()
	persist := &isrPersist{dir: dir, buildID: "build-a"}
	render, n := countingRenderer(plainPage("<html>kept</html>"))
	i := newIsr(render, persist, func(string) {})
	policy := &isrPolicy{manual: true}
	serve(t, i, policy, "/kept")
	waitForPairs(t, dir, 2)

	again := newIsr(render, persist, func(string) {})
	w, _ := serve(t, again, policy, "/kept")
	if w.Header().Get(cacheStateHeader) != "hit" || w.Body.String() != "<html>kept</html>" || atomic.LoadInt32(n) != 1 {
		t.Errorf("restart: %q %q renders=%d", w.Header().Get(cacheStateHeader), w.Body.String(), *n)
	}

	// another build sweeps; a torn html sweeps; an orphan html sweeps
	other := newIsr(render, &isrPersist{dir: dir, buildID: "build-b"}, func(string) {})
	if other.cache.size() != 0 {
		t.Error("another build's copies were served")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("stale pair not swept: %d files", len(entries))
	}
	os.WriteFile(filepath.Join(dir, "orphan.html"), []byte("x"), 0o644)
	newIsr(render, persist, func(string) {})
	if _, err := os.Stat(filepath.Join(dir, "orphan.html")); err == nil {
		t.Error("an orphan html survived the boot sweep")
	}
}

func TestIsrPolicyTableAndMatching(t *testing.T) {
	boot, entries, err := parsePolicyTable([]byte(`{"boot":1757600000000,"routes":[
		{"pattern":"/","seconds":null,"tags":[]},
		{"pattern":"/news","seconds":300,"tags":[" posts "]},
		{"pattern":"/docs/:slug","seconds":"manual","tags":[]},
		{"pattern":"/bad","seconds":-5,"tags":[]}]}`))
	if err != nil || boot != "1757600000000" || len(entries) != 4 {
		t.Fatalf("parse: %v %q %d", err, boot, len(entries))
	}
	if p, ok := matchPolicy(entries, "/news/"); !ok || p == nil || p.seconds != 300 || p.tags[0] != "posts" {
		t.Errorf("/news/: %v %v", p, ok)
	}
	if p, ok := matchPolicy(entries, "/docs/citt%C3%A0"); !ok || p == nil || !p.manual {
		t.Errorf("a param takes an encoded segment: %v %v", p, ok)
	}
	if p, ok := matchPolicy(entries, "/docs"); ok || p != nil {
		t.Errorf("/docs matched a two-segment pattern: %v %v", p, ok)
	}
	if p, ok := matchPolicy(entries, "/bad"); !ok || p != nil {
		t.Errorf("an invalid opt-in is a route with no policy: %v %v", p, ok)
	}
	if p, ok := matchPolicy(entries, "/"); !ok || p != nil {
		t.Errorf("/ : %v %v", p, ok)
	}
	if _, ok := matchPolicy(entries, "/nowhere"); ok {
		t.Error("an unknown path matched")
	}
}

func TestIsrHandlesOnlySafeMethods(t *testing.T) {
	render, _ := countingRenderer(plainPage("<html/>"))
	i := newIsr(render, nil, func(string) {})
	req := httptest.NewRequest("POST", "/news", nil)
	if out := i.handle(httptest.NewRecorder(), req, &isrPolicy{seconds: 1}); out != isrNotMine {
		t.Errorf("a POST was the cache's: %v", out)
	}
	head := httptest.NewRequest("HEAD", "/news", nil)
	w := httptest.NewRecorder()
	if out := i.handle(w, head, &isrPolicy{seconds: 1}); out != isrServed || w.Body.Len() != 0 || w.Header().Get("Content-Length") == "" {
		t.Errorf("HEAD: %v body=%d len=%q", out, w.Body.Len(), w.Header().Get("Content-Length"))
	}
}

// an invalidation arriving while a render is in flight dooms it: served to
// its waiters, never stored - or the copy read from the old data would rise
// again after the drop, under "manual" forever
func TestIsrDoomsARenderInFlight(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	render := func(r *http.Request) (int, http.Header, string, error) {
		close(started)
		<-release
		s, h, b := plainPage("<html>old data</html>")(r)
		return s, h, b, nil
	}
	i := newIsr(render, nil, func(string) {})
	policy := &isrPolicy{manual: true, tags: []string{"data"}}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w, _ := serve(t, i, policy, "/p")
		done <- w
	}()
	<-started
	if got := i.invalidateTag("data"); got != 0 {
		t.Errorf("nothing was cached yet: %d", got)
	}
	close(release)
	w := <-done
	if w.Code != 200 || w.Body.String() != "<html>old data</html>" {
		t.Errorf("the waiter was not served: %d %q", w.Code, w.Body.String())
	}
	if i.cache.size() != 0 {
		t.Error("a doomed render was stored")
	}
}

// a refusal during a doomed flight marks nothing: the data changed under it
func TestIsrADoomedRefusalMarksNothing(t *testing.T) {
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	var n int32
	render := func(r *http.Request) (int, http.Header, string, error) {
		if atomic.AddInt32(&n, 1) == 1 {
			started <- struct{}{}
			<-release
			s, h, b := plainPage("<html/>")(r)
			h.Add("Set-Cookie", "personal=1")
			return s, h, b, nil
		}
		s, h, b := plainPage("<html>shared now</html>")(r)
		return s, h, b, nil
	}
	i := newIsr(render, nil, func(string) {})
	policy := &isrPolicy{manual: true}
	go serve(t, i, policy, "/q")
	<-started
	i.invalidatePath("/q")
	close(release)
	time.Sleep(20 * time.Millisecond)
	w, out := serve(t, i, policy, "/q")
	if out != isrServed || w.Header().Get(cacheStateHeader) != "miss" {
		t.Errorf("a doomed refusal left a mark: %v %q", out, w.Header().Get(cacheStateHeader))
	}
}

// a page that turns personal drops the copy stored before it did
func TestIsrARefusalDropsTheOldCopy(t *testing.T) {
	personal := false
	render, _ := countingRenderer(func(r *http.Request) (int, http.Header, string) {
		_, h, b := plainPage("<html/>")(r)
		if personal {
			h.Add("Set-Cookie", "x=1")
		}
		return 200, h, b
	})
	i := newIsr(render, nil, func(string) {})
	now := time.Now()
	i.now = func() time.Time { return now }
	policy := &isrPolicy{seconds: 10}
	serve(t, i, policy, "/r")
	personal = true
	now = now.Add(11 * time.Second)
	w, _ := serve(t, i, policy, "/r") // stale: served, regenerated in the background
	if w.Header().Get(cacheStateHeader) != "stale" {
		t.Fatalf("expected stale, got %q", w.Header().Get(cacheStateHeader))
	}
	deadline := time.Now().Add(2 * time.Second)
	for i.cache.size() > 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if i.cache.size() != 0 {
		t.Error("the copy stored before the page turned personal is still served")
	}
	if _, out := serve(t, i, policy, "/r"); out != isrBypass {
		t.Errorf("after the refusal: %v, want bypass", out)
	}
}

// the key is the decoded path (URL.Path already is), so the spelling that
// needs the decoded comparison is the operator's ENCODED one:
// Revalidate("/caf%C3%A9") must reach the page stored as /café
func TestIsrInvalidatesAcrossEncodings(t *testing.T) {
	render, _ := countingRenderer(plainPage("<html/>"))
	i := newIsr(render, nil, func(string) {})
	policy := &isrPolicy{manual: true}
	serve(t, i, policy, "/caf%C3%A9")
	if got := i.invalidatePath("/caf%C3%A9"); got != 1 {
		t.Errorf("the encoded spelling dropped %d", got)
	}
	serve(t, i, policy, "/caf%C3%A9")
	if got := i.invalidatePath("/café"); got != 1 {
		t.Errorf("the author's spelling dropped %d", got)
	}
}

// a torn html - a valid json beside fewer bytes than it vouches for - is swept
func TestIsrSweepsATornPair(t *testing.T) {
	dir := t.TempDir()
	persist := &isrPersist{dir: dir, buildID: "b"}
	render, n := countingRenderer(plainPage("<html>whole page</html>"))
	i := newIsr(render, persist, func(string) {})
	serve(t, i, &isrPolicy{manual: true}, "/t")
	waitForPairs(t, dir, 2)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".html") {
			os.WriteFile(filepath.Join(dir, e.Name()), []byte("<html>wh"), 0o644)
		}
	}
	again := newIsr(render, persist, func(string) {})
	if again.cache.size() != 0 {
		t.Error("a torn html was loaded")
	}
	if left, _ := os.ReadDir(dir); len(left) != 0 {
		t.Errorf("the torn pair was not swept: %d files", len(left))
	}
	w, _ := serve(t, again, &isrPolicy{manual: true}, "/t")
	if w.Body.String() != "<html>whole page</html>" || atomic.LoadInt32(n) != 2 {
		t.Errorf("re-rendered whole: %q renders=%d", w.Body.String(), *n)
	}
	// the re-render persists a whole pair, and waiting for it is also what
	// keeps this test from returning while the writer still holds the dir
	waitForPairs(t, dir, 2)
}

// an invalidation wins over a save still in flight: the pair never lands
func TestIsrAnInvalidatedCopyDoesNotComeBackFromDisk(t *testing.T) {
	dir := t.TempDir()
	persist := &isrPersist{dir: dir, buildID: "b"}
	render, _ := countingRenderer(plainPage("<html>gone</html>"))
	i := newIsr(render, persist, func(string) {})
	serve(t, i, &isrPolicy{manual: true}, "/g")
	i.invalidatePath("/g")
	time.Sleep(100 * time.Millisecond)
	if left, _ := os.ReadDir(dir); len(left) != 0 {
		names := []string{}
		for _, e := range left {
			names = append(names, e.Name())
		}
		t.Errorf("files after an invalidation: %v", names)
	}
	again := newIsr(render, persist, func(string) {})
	if again.cache.size() != 0 {
		t.Error("an invalidated copy came back on restart")
	}
}

// A response that declares it varies on something is a render saying "this
// copy is not universal". The one axis this cache negotiates itself is the
// coding, per replay; anything else names a header the next visitor may not
// send, and storing the copy would answer their request with somebody
// else's negotiation. The direction is always "no caching", never "shared
// what was negotiated for one client".
func TestUnstorableRefusesAVaryItCannotHonour(t *testing.T) {
	page := "<html>hello</html>"
	cases := []struct {
		name   string
		vary   []string
		stored bool
	}{
		{"no vary at all", nil, true},
		{"the coding this cache negotiates per replay", []string{"Accept-Encoding"}, true},
		{"folded case, which a client is allowed", []string{"accept-encoding"}, true},
		{"a language", []string{"Accept-Language"}, false},
		{"beside the coding, on one line", []string{"Accept-Encoding, Accept-Language"}, false},
		{"beside the coding, on two field lines", []string{"Accept-Encoding", "Cookie"}, false},
		{"a client hint", []string{"Sec-CH-Prefers-Color-Scheme"}, false},
		{"never shared", []string{"*"}, false},
		{"an empty field is not an axis", []string{"Accept-Encoding, "}, true},
	}
	for _, c := range cases {
		h := http.Header{}
		for _, v := range c.vary {
			h.Add("Vary", v)
		}
		reason := unstorable(200, h, page)
		if c.stored && reason != "" {
			t.Errorf("%s: refused with %q", c.name, reason)
		}
		if !c.stored && reason == "" {
			t.Errorf("%s: stored, and a shared copy cannot honour it", c.name)
		}
	}
}

// anonymised is where the shared property is built rather than trusted, so
// every header a render could answer differently for the next visitor has to
// die here. The session fact was deleted at the one call site instead, which
// the verifier of this phase mutated away with no test noticing: a second
// caller would have inherited the hole rather than the guard.
func TestAnonymisedDropsEveryPersonalHeader(t *testing.T) {
	req := httptest.NewRequest("POST", "http://app.example/news", strings.NewReader("body"))
	for name, value := range map[string]string{
		"Cookie":          "borgo_session=abc",
		"Authorization":   "Bearer t",
		sessionHeader:     "eyJ1c2VyIjoiYSJ9",
		"Accept-Language": "it-IT",
		"Accept-Charset":  "iso-8859-1",
		"Accept-Encoding": "br",
		"Content-Type":    "application/x-www-form-urlencoded",
		"User-Agent":      "borgo-test",
		"Accept":          "text/html",
	} {
		req.Header.Set(name, value)
	}

	anon := anonymised(req)

	for _, name := range []string{
		"Cookie", "Authorization", sessionHeader, "Accept-Language", "Accept-Charset",
		"Accept-Encoding", "Content-Type", "Content-Length",
	} {
		if got := anon.Header.Get(name); got != "" {
			t.Errorf("%s survived as %q: the copy is not rendered as nobody", name, got)
		}
	}
	// what is not personal stays: a render that cannot see the agent at all
	// is a different render, and this function's job is narrow
	if anon.Header.Get("User-Agent") != "borgo-test" || anon.Header.Get("Accept") != "text/html" {
		t.Error("anonymised took a header that was not personal")
	}
	if anon.Method != "GET" || anon.ContentLength != 0 {
		t.Errorf("method %q length %d: a shared render is a plain GET", anon.Method, anon.ContentLength)
	}
	// the request it was cloned from must be untouched: the visitor's own
	// render happens after this one refuses
	if req.Header.Get("Cookie") != "borgo_session=abc" {
		t.Error("anonymised mutated the visitor's own request")
	}
}

// a render the test holds open, so a burst can be built up against a flight
// that is provably still running
func heldRenderer(body string) (sharedRenderer, *int32, chan struct{}) {
	var n int32
	release := make(chan struct{})
	return func(r *http.Request) (int, http.Header, string, error) {
		atomic.AddInt32(&n, 1)
		<-release
		h := http.Header{}
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Vary", "Accept-Encoding")
		return 200, h, body, nil
	}, &n, release
}

// serveAsync runs a burst against one key and returns when every request has
// answered. Concurrency is the point: the sequential version of this test
// passes with the single-flight guard deleted.
func serveBurst(t *testing.T, i *isr, policy *isrPolicy, path string, n int) []*httptest.ResponseRecorder {
	t.Helper()
	out := make([]*httptest.ResponseRecorder, n)
	var wg sync.WaitGroup
	for k := 0; k < n; k++ {
		wg.Add(1)
		go func(k int) {
			defer wg.Done()
			w, _ := serve(t, i, policy, path)
			out[k] = w
		}(k)
	}
	wg.Wait()
	return out
}

// The claim: however many requests arrive for a cold key at once, exactly one
// render happens and everybody gets it. The verifier of this phase deleted
// the guard that holds it and nothing in the suite failed - the test that
// looked like its cover was two SEQUENTIAL requests, which proves the cache
// hit and not the flight.
func TestIsrRendersOnceForABurstOnAColdKey(t *testing.T) {
	render, n, release := heldRenderer("<html>one render</html>")
	i := newIsr(render, nil, func(string) {})
	policy := &isrPolicy{seconds: 60}

	// every request is in before the render may finish, so they cannot be
	// answered one after another from a warm cache
	done := make(chan []*httptest.ResponseRecorder, 1)
	go func() { done <- serveBurst(t, i, policy, "/news", 50) }()
	waitFor(t, func() bool { return atomic.LoadInt32(n) == 1 }, "the first render to start")
	time.Sleep(50 * time.Millisecond)
	close(release)
	answers := <-done

	if got := atomic.LoadInt32(n); got != 1 {
		t.Errorf("%d renders for one cold key under a burst of 50", got)
	}
	misses := 0
	for _, w := range answers {
		if w.Body.String() != "<html>one render</html>" {
			t.Fatalf("a request in the burst got %q", w.Body.String())
		}
		if w.Header().Get(cacheStateHeader) == "miss" {
			misses++
		}
	}
	// every waiter is answered from the flight it joined, so they all read
	// "miss": the copy was not in the cache when they asked
	if misses != 50 {
		t.Errorf("%d of 50 answered miss", misses)
	}
}

// two keys are two pages: the flight is per key, not a global lock
func TestIsrFlightsAreOnePerKey(t *testing.T) {
	render, n, release := heldRenderer("<html>page</html>")
	i := newIsr(render, nil, func(string) {})
	policy := &isrPolicy{seconds: 60}
	var wg sync.WaitGroup
	for _, p := range []string{"/a", "/b", "/a", "/b"} {
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			serve(t, i, policy, p)
		}(p)
	}
	waitFor(t, func() bool { return atomic.LoadInt32(n) == 2 }, "both keys to start rendering")
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if got := atomic.LoadInt32(n); got != 2 {
		t.Errorf("%d renders for two keys under four requests", got)
	}
}

// The claim: past the window the stale copy is served immediately while ONE
// background render replaces it, however wide the burst. Also unguarded
// before this test.
func TestIsrStartsOneBackgroundRenderForAStaleBurst(t *testing.T) {
	var n int32
	release := make(chan struct{})
	var hold atomic.Bool
	render := sharedRenderer(func(r *http.Request) (int, http.Header, string, error) {
		count := atomic.AddInt32(&n, 1)
		if hold.Load() {
			<-release
		}
		h := http.Header{}
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Vary", "Accept-Encoding")
		return 200, h, fmt.Sprintf("<html>render %d</html>", count), nil
	})
	now := time.Now()
	i := newIsr(render, nil, func(string) {})
	i.now = func() time.Time { return now }
	policy := &isrPolicy{seconds: 1}

	// one copy, then past its window
	serve(t, i, policy, "/news")
	if got := atomic.LoadInt32(&n); got != 1 {
		t.Fatalf("the first request rendered %d times", got)
	}
	now = now.Add(2 * time.Second)
	hold.Store(true)

	answers := serveBurst(t, i, policy, "/news", 50)
	for _, w := range answers {
		if state := w.Header().Get(cacheStateHeader); state != "stale" {
			t.Fatalf("a request in the stale burst read %q", state)
		}
		if w.Body.String() != "<html>render 1</html>" {
			t.Fatalf("a stale request was served %q, not the copy it had", w.Body.String())
		}
	}
	// the burst is answered from the copy; exactly one regeneration is
	// running behind it, still held
	if got := atomic.LoadInt32(&n); got != 2 {
		t.Errorf("%d renders behind a stale burst of 50, want exactly one", got-1)
	}
	close(release)
	hold.Store(false)
	// and when it lands it replaces the copy, so the next request reads the
	// render the burst paid for rather than the one it was served
	waitFor(t, func() bool {
		w, _ := serve(t, i, policy, "/news")
		return w.Body.String() == "<html>render 2</html>"
	}, "the background render to replace the copy")
}

// The claim the doom flag exists for: an invalidation that lands while a
// render is in flight wins. It did for the flight's own waiters, and did NOT
// for a request that arrived AFTER the invalidation returned - that request
// was handed the doomed flight and answered from data the operator had
// already dropped, while Revalidate reported success. Found by the verifier
// of this phase.
func TestIsrARequestAfterAnInvalidationIsNotAnsweredByTheDoomedFlight(t *testing.T) {
	var n int32
	release := make(chan struct{})
	render := sharedRenderer(func(r *http.Request) (int, http.Header, string, error) {
		count := atomic.AddInt32(&n, 1)
		if count == 1 {
			<-release
		}
		h := http.Header{}
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Vary", "Accept-Encoding")
		return 200, h, fmt.Sprintf("<html>read %d</html>", count), nil
	})
	i := newIsr(render, nil, func(string) {})
	policy := &isrPolicy{manual: true, tags: []string{"news"}}

	// A starts the only flight and blocks inside the render
	first := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w, _ := serve(t, i, policy, "/news")
		first <- w
	}()
	waitFor(t, func() bool { return atomic.LoadInt32(&n) == 1 }, "the first render to start")

	// the data changes and the operator says so; the call returns
	i.invalidateTag("news")

	// B asks now, after the invalidation: it must not be handed the copy the
	// doomed flight read from the old data
	second := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w, _ := serve(t, i, policy, "/news")
		second <- w
	}()
	waitFor(t, func() bool { return atomic.LoadInt32(&n) == 2 }, "a fresh render for the request after the invalidation")
	close(release)

	if body := (<-second).Body.String(); body != "<html>read 2</html>" {
		t.Errorf("the request after the invalidation was served %q", body)
	}
	// A's own request was already in flight when the drop landed, so it
	// keeps its answer - that is the race boundary, not a bug
	if body := (<-first).Body.String(); body != "<html>read 1</html>" {
		t.Errorf("the flight's own waiter got %q", body)
	}
	// and nothing read before the invalidation is in the cache
	waitFor(t, func() bool { return i.cache.size() == 1 }, "the fresh copy to be stored")
	w, _ := serve(t, i, policy, "/news")
	if body := w.Body.String(); body != "<html>read 2</html>" {
		t.Errorf("the stored copy is %q", body)
	}
}

// The 512-entry bound and the tag index under eviction: also free to delete
// before this test, and a leak here is unbounded memory under traffic that
// varies the query string.
func TestIsrEvictionKeepsTheTagIndexHonest(t *testing.T) {
	render, _ := countingRenderer(plainPage("<html>page</html>"))
	i := newIsr(render, nil, func(string) {})
	policy := &isrPolicy{seconds: 3600, tags: []string{"all"}}
	for k := 0; k < maxCachedPages+88; k++ {
		serve(t, i, policy, fmt.Sprintf("/p?k=%d", k))
	}
	if size := i.cache.size(); size != maxCachedPages {
		t.Errorf("the cache holds %d copies, want the %d bound", size, maxCachedPages)
	}
	// every tag entry must name a page that is still there, or an
	// invalidation walks keys that are gone and reports a wrong count
	for tag, keys := range i.cache.byTag {
		for key := range keys {
			if i.cache.get(key) == nil {
				t.Fatalf("tag %q still points at the evicted %q", tag, keyLabel(key))
			}
		}
	}
	if dropped := i.invalidateTag("all"); dropped != maxCachedPages {
		t.Errorf("the tag dropped %d copies, want %d", dropped, maxCachedPages)
	}
	if len(i.cache.byTag) != 0 {
		t.Errorf("the tag index kept %d tags after dropping everything", len(i.cache.byTag))
	}
	if size := i.cache.size(); size != 0 {
		t.Errorf("%d copies survived the tag invalidation", size)
	}
}

// A panic in a render used to take the process: this goroutine works on
// behalf of a request but is not the request's own, so net/http's recover
// never covered it. The front would die with its api, and the api is the
// half the 503 page promises is still up. Found by the verifier of this
// phase, whose probe for it had to be skipped because it killed the test
// binary.
func TestIsrContainsAPanicInTheRender(t *testing.T) {
	var lines []string
	render := sharedRenderer(func(r *http.Request) (int, http.Header, string, error) {
		panic("a loader did something unforgivable")
	})
	i := newIsr(render, nil, func(line string) { lines = append(lines, line) })

	// the process is still here, which is the whole assertion; the visitor
	// gets their own render through the bypass
	w, out := serve(t, i, &isrPolicy{seconds: 60}, "/news")
	if out != isrBypass {
		t.Errorf("a panicking render answered %v, want the visitor their own render", out)
	}
	if w.Body.Len() != 0 {
		t.Errorf("the bypass wrote a body: %q", w.Body.String())
	}
	if i.cache.size() != 0 {
		t.Error("a panicking render stored something")
	}
	// and it is said, once, with the page named
	if len(lines) != 1 || !strings.Contains(lines[0], "/news") || !strings.Contains(lines[0], "panicked") {
		t.Errorf("the log says %q", lines)
	}
	// the flight is unregistered, so the next request tries again rather
	// than joining a goroutine that is gone
	if len(i.inflight) != 0 {
		t.Errorf("%d flights left registered after the panic", len(i.inflight))
	}
	if _, out := serve(t, i, &isrPolicy{seconds: 60}, "/news"); out != isrBypass {
		t.Errorf("the second request answered %v", out)
	}
}

// A shared render that does not arrive says nothing about whether the page is
// shareable - the render service may be restarting - but without a memory of
// it every request paid twice: once for a shared render that failed the same
// way, once for its own render through the bypass. Found by the verifier of
// this phase. The memory is short and, unlike a storability refusal, it
// expires under "manual" too, so a page is not condemned by a bad minute.
func TestIsrDoesNotReAskARenderServiceThatJustFailed(t *testing.T) {
	var attempts int32
	var fail atomic.Bool
	fail.Store(true)
	render := sharedRenderer(func(r *http.Request) (int, http.Header, string, error) {
		atomic.AddInt32(&attempts, 1)
		if fail.Load() {
			return 0, nil, "", errors.New("the render service is not answering")
		}
		h := http.Header{}
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Vary", "Accept-Encoding")
		return 200, h, "<html>back</html>", nil
	})
	now := time.Now()
	i := newIsr(render, nil, func(string) {})
	i.now = func() time.Time { return now }
	// "manual" is the case that used to be condemned forever by a refusal
	policy := &isrPolicy{manual: true}

	if _, out := serve(t, i, policy, "/news"); out != isrBypass {
		t.Fatal("a failed shared render did not bypass")
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("%d attempts for the first request", got)
	}
	// the next requests are bypassed without asking again
	for k := 0; k < 5; k++ {
		if _, out := serve(t, i, policy, "/news"); out != isrBypass {
			t.Fatalf("request %d: %v", k+2, out)
		}
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Errorf("%d shared renders for six requests against a failing render service", got)
	}

	// and the page is cacheable again once the cool-off passes: this is a
	// refusal about the render service, not about the page
	fail.Store(false)
	now = now.Add(renderFailureCool + time.Second)
	w, out := serve(t, i, policy, "/news")
	if out != isrServed || w.Header().Get(cacheStateHeader) != "miss" || w.Body.String() != "<html>back</html>" {
		t.Errorf("after the cool-off: %v %q %q", out, w.Header().Get(cacheStateHeader), w.Body.String())
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Errorf("%d attempts in total", got)
	}
}

// The mutex this cache takes is taken by every page request and by both
// invalidation APIs, so nothing slow may happen while it is held. It used to
// hold it for the log line and for two file removals per dropped key: a
// stderr that stopped draining (a blocking container log driver, a
// supervisor that piped and stopped reading) stopped the whole page surface,
// and RevalidateTag on a tag held by hundreds of pages performed hundreds of
// synchronous deletions with every request waiting. Found by the verifier of
// this phase.
//
// What is guaranteed is that a stalled writer blocks nothing but itself. The
// caller that produced a line still waits for its own line, as every logging
// call in go does; no other page request and no other invalidation is held
// behind it.
func TestIsrDoesNoSlowWorkUnderItsLock(t *testing.T) {
	blocked := make(chan struct{})
	logged := make(chan string, 8)
	render, _ := countingRenderer(func(r *http.Request) (int, http.Header, string) {
		_, h, b := plainPage("<html/>")(r)
		h.Add("Set-Cookie", "seen=1") // unstorable, so a line is said
		return 200, h, b
	})
	i := newIsr(render, nil, func(line string) {
		logged <- line
		<-blocked
	})
	policy := &isrPolicy{seconds: 60}

	// the first request refuses the page and says so: a writer is now stuck
	// inside the log function, holding whatever it holds
	go serve(t, i, policy, "/x")
	select {
	case <-logged:
	case <-time.After(5 * time.Second):
		t.Fatal("the refusal was never said")
	}

	// and with it stuck, pages are still served: this is the property. Each
	// of these says its own line and ends up stuck in the writer too, but
	// only after it has answered, which is the part that matters
	for _, path := range []string{"/other", "/another"} {
		done := make(chan isrOutcome, 1)
		go func(p string) {
			_, out := serve(t, i, policy, p)
			done <- out
		}(path)
		select {
		case out := <-done:
			if out != isrBypass {
				t.Errorf("%s answered %v", path, out)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s was never answered: a stalled log line held the mutex every page request takes", path)
		}
	}

	// an invalidation waits for its own line and for nothing else
	dropped := make(chan int, 1)
	go func() { dropped <- i.invalidatePath("/x") }()
	select {
	case <-dropped:
		t.Error("the invalidation returned without writing its line")
	case <-time.After(200 * time.Millisecond):
	}
	close(blocked)
	select {
	case <-dropped:
	case <-time.After(5 * time.Second):
		t.Error("the invalidation never returned once the writer was released")
	}
}

// The replay negotiates the coding, so the replay has to say it varies on
// it. It carried only the Vary the render had stored, which is fine only as
// long as every render stores one. Found by the verifier of phase 1.
func TestIsrReplayDeclaresTheCodingItNegotiates(t *testing.T) {
	render, _ := countingRenderer(func(r *http.Request) (int, http.Header, string) {
		h := http.Header{}
		h.Set("Content-Type", "text/html; charset=utf-8")
		return 200, h, "<html>" + strings.Repeat("a render with no vary of its own ", 20) + "</html>"
	})
	i := newIsr(render, nil, func(string) {})
	policy := &isrPolicy{seconds: 60}
	serve(t, i, policy, "/p")
	for _, accept := range []string{"gzip", ""} {
		w, _ := serve(t, i, policy, "/p", "Accept-Encoding", accept)
		if got := w.Header().Values("Vary"); len(got) != 1 || !strings.EqualFold(got[0], "Accept-Encoding") {
			t.Errorf("Accept-Encoding %q: the replay says Vary %q", accept, got)
		}
	}
}
