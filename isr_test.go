package borgo

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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
func waitForPairs(t *testing.T, dir string, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if entries, _ := os.ReadDir(dir); len(entries) == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	entries, _ := os.ReadDir(dir)
	t.Fatalf("the persist directory holds %d files after 2s, want %d", len(entries), want)
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
