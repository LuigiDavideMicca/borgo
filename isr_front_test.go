package borgo

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// a render service as the cache sees it: a policy table under a boot stamp,
// shared renders on request, ordinary renders otherwise
type fakeRenderService struct {
	boot    int64
	shared  int32
	regular int32
	tables  int32
	logins  int32
	// another host a redirect may name
	elsewhere string
	// what the shared render answers; personal makes it unshareable
	personal bool
	// how many requests arrived under a non-canonical spelling
	canonicalised int32
}

func (f *fakeRenderService) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// one spelling per path, as the real render service does
		// (canonicalPath in server.ts): a fake more permissive than the
		// thing it stands for hides a whole class of defect, and hid one
		if cleaned := path.Clean(r.URL.Path); cleaned != r.URL.Path {
			atomic.AddInt32(&f.canonicalised, 1)
			http.Redirect(w, r, cleaned, http.StatusPermanentRedirect)
			return
		}
		if r.URL.Path == "/guarded" && r.Header.Get(sharedRenderHeader) == "1" {
			// a loader guard: nobody is signed in on a shared render
			atomic.AddInt32(&f.shared, 1)
			http.Redirect(w, r, "/login?next=/guarded", http.StatusFound)
			return
		}
		if r.URL.Path == "/login" {
			atomic.AddInt32(&f.logins, 1)
		}
		if r.URL.Path == "/away" && r.Header.Get(sharedRenderHeader) == "1" {
			atomic.AddInt32(&f.shared, 1)
			http.Redirect(w, r, f.elsewhere+"/idp", http.StatusFound)
			return
		}
		w.Header().Set(bootHeader, strconv.FormatInt(atomic.LoadInt64(&f.boot), 10))
		if r.URL.Path == routesPath {
			atomic.AddInt32(&f.tables, 1)
			json.NewEncoder(w).Encode(map[string]any{"boot": atomic.LoadInt64(&f.boot), "routes": []map[string]any{
				{"pattern": "/", "seconds": nil, "tags": []string{}},
				{"pattern": "/news", "seconds": 60, "tags": []string{"posts"}},
				{"pattern": "/me", "seconds": 60, "tags": []string{}},
				{"pattern": "/guarded", "seconds": 60, "tags": []string{}},
				{"pattern": "/away", "seconds": 60, "tags": []string{}},
				{"pattern": "/posts/:slug", "seconds": nil, "tags": []string{}},
			}})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "private, no-store")
		if r.Header.Get(sharedRenderHeader) == "1" {
			atomic.AddInt32(&f.shared, 1)
			if r.Header.Get("Cookie") != "" {
				w.WriteHeader(500)
				io.WriteString(w, "a shared render received a cookie")
				return
			}
			if f.personal || r.URL.Path == "/me" {
				w.Header().Add("Set-Cookie", "seen=1")
			}
			io.WriteString(w, "<html>shared "+r.URL.Path+" host="+r.Host+" proto="+r.Header.Get("X-Forwarded-Proto")+"</html>")
			return
		}
		atomic.AddInt32(&f.regular, 1)
		io.WriteString(w, "<html>own "+r.URL.Path+" cookie="+r.Header.Get("Cookie")+"</html>")
	})
}

func TestFrontServesSharedPagesFromItsCache(t *testing.T) {
	svc := &fakeRenderService{boot: 1}
	renderer := httptest.NewServer(svc.handler())
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	pages := newIsr(nil, nil, func(string) {})
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: pages}, u, testInternalKey, time.Second)

	get := func(path, cookie string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "http://app.example"+path, nil)
		req.Host = "app.example"
		req.Header.Set("X-Forwarded-Proto", "https")
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		w := httptest.NewRecorder()
		front.ServeHTTP(w, req)
		return w
	}

	// a visitor with a session gets the SHARED copy: rendered as nobody,
	// with the public host and scheme, never their cookie
	w := get("/news", "borgo_session=abc")
	if w.Code != 200 || w.Header().Get(cacheStateHeader) != "miss" || w.Body.String() != "<html>shared /news host=app.example proto=https</html>" {
		t.Fatalf("first: %d %q %q", w.Code, w.Header().Get(cacheStateHeader), w.Body.String())
	}
	w = get("/news", "")
	if w.Header().Get(cacheStateHeader) != "hit" {
		t.Errorf("second: %q", w.Header().Get(cacheStateHeader))
	}
	if atomic.LoadInt32(&svc.shared) != 1 || atomic.LoadInt32(&svc.regular) != 0 {
		t.Errorf("renders: shared=%d regular=%d", svc.shared, svc.regular)
	}
	// a page with no policy is forwarded as always
	w = get("/", "borgo_session=abc")
	if w.Header().Get(cacheStateHeader) != "" || !strings.Contains(w.Body.String(), "own / cookie=borgo_session=abc") {
		t.Errorf("uncached page: %q %q", w.Header().Get(cacheStateHeader), w.Body.String())
	}
	// a page whose shared render sets a cookie: the visitor's own render, marked bypass
	w = get("/me", "borgo_session=abc")
	if w.Header().Get(cacheStateHeader) != "bypass" || !strings.Contains(w.Body.String(), "own /me cookie=borgo_session=abc") {
		t.Errorf("bypass: %q %q", w.Header().Get(cacheStateHeader), w.Body.String())
	}
	// a client cannot ask for a shared render itself
	req := httptest.NewRequest("GET", "http://app.example/", nil)
	req.Header.Set(sharedRenderHeader, "1")
	w = httptest.NewRecorder()
	front.ServeHTTP(w, req)
	if !strings.Contains(w.Body.String(), "own /") {
		t.Errorf("a client got a shared render: %q", w.Body.String())
	}
	// the boot stamp never reaches the client
	if get("/", "").Header().Get(bootHeader) != "" {
		t.Error("the boot stamp reached the client")
	}

	// borgo.Revalidate is local now
	setFrontIsr(pages)
	defer setFrontIsr(nil)
	if err := RevalidateTag("posts"); err != nil {
		t.Fatal(err)
	}
	if got := get("/news", "").Header().Get(cacheStateHeader); got != "miss" {
		t.Errorf("after RevalidateTag: %q", got)
	}
	if err := Revalidate("/news"); err != nil {
		t.Fatal(err)
	}
	if got := get("/news", "").Header().Get(cacheStateHeader); got != "miss" {
		t.Errorf("after Revalidate: %q", got)
	}

	// a restarted render service declares its pages again: the stamp on the
	// next proxied response marks the table stale, the next lookup reads it
	if atomic.LoadInt32(&svc.tables) != 1 {
		t.Fatalf("the table was read %d times before any restart", svc.tables)
	}
	atomic.StoreInt64(&svc.boot, 2)
	get("/", "")
	get("/news", "")
	if atomic.LoadInt32(&svc.tables) != 2 {
		t.Errorf("after a restart the table was read %d times, want 2", svc.tables)
	}
}

// a guard's redirect is the render's answer, never a place the cache goes:
// the visitor gets their own render, and no other host ever sees the key
// a session whose csrf cookie ended with the browser session: a shared copy
// mints no token, and the /api guard arms for that browser's next form post.
// Its own render mints one; with the token held, the copy serves it again.
// With csrf off there is no guard to arm, and the copy serves everyone
func TestFrontRendersASessionWithoutATokenItsOwnPage(t *testing.T) {
	svc := &fakeRenderService{boot: 1}
	renderer := httptest.NewServer(svc.handler())
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	for _, csrf := range []bool{true, false} {
		front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: newIsr(nil, nil, func(string) {}), csrf: csrf}, u, testInternalKey, time.Second)
		get := func(cookie string) string {
			req := httptest.NewRequest("GET", "http://app.example/news", nil)
			req.Header.Set("Cookie", cookie)
			w := httptest.NewRecorder()
			front.ServeHTTP(w, req)
			return w.Header().Get(cacheStateHeader)
		}
		if got := get("borgo_session=abc"); csrf && got != "bypass" || !csrf && got != "miss" {
			t.Errorf("csrf=%v session, no token: %q", csrf, got)
		}
		if got := get("borgo_session=abc; borgo_csrf=t"); got == "bypass" {
			t.Errorf("csrf=%v session and token: %q", csrf, got)
		}
		if got := get(""); got != "hit" {
			t.Errorf("csrf=%v anonymous: %q", csrf, got)
		}
	}
}

func TestFrontNeverFollowsARedirectFromTheRenderService(t *testing.T) {
	var foreign http.Header
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		foreign = r.Header.Clone()
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, "<html>not yours</html>")
	}))
	defer elsewhere.Close()
	svc := &fakeRenderService{boot: 1, elsewhere: elsewhere.URL}
	renderer := httptest.NewServer(svc.handler())
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	pages := newIsr(nil, nil, func(string) {})
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: pages}, u, testInternalKey, time.Second)

	req := httptest.NewRequest("GET", "http://app.example/guarded", nil)
	req.Header.Set("Cookie", "borgo_session=abc")
	w := httptest.NewRecorder()
	front.ServeHTTP(w, req)
	if w.Header().Get(cacheStateHeader) != "bypass" || !strings.Contains(w.Body.String(), "own /guarded cookie=borgo_session=abc") {
		t.Errorf("a guarded page: %q %q", w.Header().Get(cacheStateHeader), w.Body.String())
	}
	if atomic.LoadInt32(&svc.logins) != 0 {
		t.Errorf("the cache followed the guard's redirect and fetched /login %d times", svc.logins)
	}

	w = httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "http://app.example/away", nil))
	if w.Header().Get(cacheStateHeader) != "bypass" {
		t.Errorf("a page redirecting elsewhere: %q", w.Header().Get(cacheStateHeader))
	}
	if foreign != nil {
		t.Errorf("another host received a request from the cache, with headers %v", foreign)
	}
}

// an alias never reaches the cache: it is answered with the 308 the render
// service would have answered, so the cache only ever holds the canonical
// spelling and an invalidation by the plain name reaches every copy there is
func TestFrontKeysTheCacheOnTheCanonicalPath(t *testing.T) {
	svc := &fakeRenderService{boot: 1}
	renderer := httptest.NewServer(svc.handler())
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	pages := newIsr(nil, nil, func(string) {})
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: pages}, u, testInternalKey, time.Second)
	ask := func(p string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		front.ServeHTTP(w, httptest.NewRequest("GET", "http://app.example"+p, nil))
		return w
	}
	get := func(p string) string { return ask(p).Header().Get(cacheStateHeader) }

	// the alias is redirected, not cached and not forwarded
	w := ask("/x/../news")
	if w.Code != 308 || w.Header().Get("Location") != "/news" {
		t.Fatalf("the alias answered %d -> %q", w.Code, w.Header().Get("Location"))
	}
	if w.Header().Get(cacheStateHeader) != "" {
		t.Errorf("the alias touched the cache: %q", w.Header().Get(cacheStateHeader))
	}
	// the query survives the redirect, or a paginated page loses its page
	if w := ask("/news//?page=2"); w.Header().Get("Location") != "/news?page=2" {
		t.Errorf("the query was dropped: %q", w.Header().Get("Location"))
	}
	if got := get("/news"); got != "miss" {
		t.Errorf("first: %q", got)
	}
	if got := get("/news"); got != "hit" {
		t.Errorf("second: %q", got)
	}
	if dropped := pages.invalidatePath("/news"); dropped != 1 {
		t.Errorf("dropped %d", dropped)
	}
	if got := get("/news"); got != "miss" {
		t.Errorf("after invalidation: %q", got)
	}
	// the boot stamp is the proxy's and stays out of a replay too
	w = httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "http://app.example/news", nil))
	if w.Header().Get(bootHeader) != "" || w.Header().Get(cacheStateHeader) != "hit" {
		t.Errorf("a replay carried the stamp: %q (%q)", w.Header().Get(bootHeader), w.Header().Get(cacheStateHeader))
	}
}

// pages are counted under their pattern, cache or no cache; the front's own
// endpoints are answered here and never reach the render service
func TestFrontLabelsPagesByPatternAndKeepsItsOwnEndpoints(t *testing.T) {
	svc := &fakeRenderService{boot: 1}
	renderer := httptest.NewServer(svc.handler())
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	counters := newMetrics(time.Now())
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, metrics: counters}, u, testInternalKey, time.Second)
	get := func(p string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		front.ServeHTTP(w, httptest.NewRequest("GET", "http://app.example"+p, nil))
		return w
	}
	get("/posts/one")
	get("/posts/two")
	get("/news")
	before := atomic.LoadInt32(&svc.regular)
	w := get("/metrics")
	if !strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") || strings.Contains(w.Body.String(), "own /metrics") {
		t.Errorf("/metrics was not the front's: %q %q", w.Header().Get("Content-Type"), w.Body.String()[:40])
	}
	if atomic.LoadInt32(&svc.regular) != before {
		t.Error("/metrics was rendered as a page")
	}
	// /healthz is the front's too; what reaches the render service is the
	// probe of ITS /healthz, never a page render of the name
	w = get("/healthz")
	if !strings.Contains(w.Body.String(), `"render":"reachable"`) || strings.Contains(w.Body.String(), "own /healthz") {
		t.Errorf("/healthz was not the front's: %q", w.Body.String())
	}
	out := counters.render(time.Now())
	if !strings.Contains(out, `route="/posts/:slug",status="200"} 2`) || strings.Contains(out, "/posts/one") {
		t.Errorf("pages are counted by pattern:\n%s", out)
	}
	if strings.Contains(out, "/metrics") || strings.Contains(out, "/healthz") {
		t.Errorf("the front's own endpoints were counted:\n%s", out)
	}
	// metrics off: /metrics is nothing, not a page
	off := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll}, u, testInternalKey, time.Second)
	w = httptest.NewRecorder()
	off.ServeHTTP(w, httptest.NewRequest("GET", "http://app.example/metrics", nil))
	if w.Code != 404 || strings.Contains(w.Body.String(), "own /metrics") {
		t.Errorf("/metrics with the counters off: %d %q", w.Code, w.Body.String())
	}
}

// The failure direction: one request with a chosen Host stores a render that
// every later visitor of the real host is served. The render service is
// handed the host the browser stated - it builds absolute urls from it - so a
// copy stored without the host in its key is a copy of somebody else's site.
// Found by the verifier of this phase against a cache that keyed on the path
// alone; the bun cache it replaced keyed on the host, and the port dropped it.
func TestFrontKeysTheCacheOnTheHost(t *testing.T) {
	svc := &fakeRenderService{boot: 1}
	renderer := httptest.NewServer(svc.handler())
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	pages := newIsr(nil, nil, func(string) {})
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: pages}, u, testInternalKey, time.Second)

	get := func(host string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "http://"+host+"/news", nil)
		req.Host = host
		w := httptest.NewRecorder()
		front.ServeHTTP(w, req)
		return w
	}

	// the attacker primes /news under a host of their choosing
	w := get("evil.example")
	if w.Code != 200 || w.Header().Get(cacheStateHeader) != "miss" {
		t.Fatalf("priming: %d %q", w.Code, w.Header().Get(cacheStateHeader))
	}
	// the real host must not be served that copy
	w = get("app.example")
	if state := w.Header().Get(cacheStateHeader); state != "miss" {
		t.Fatalf("app.example got the other host's copy: %q", state)
	}
	if body := w.Body.String(); !strings.Contains(body, "host=app.example") {
		t.Fatalf("app.example was served %q", body)
	}
	// and each host replays its own
	if state := get("app.example").Header().Get(cacheStateHeader); state != "hit" {
		t.Errorf("second request to app.example: %q", state)
	}
	if body := get("evil.example").Body.String(); !strings.Contains(body, "host=evil.example") {
		t.Errorf("evil.example lost its own copy: %q", body)
	}
	if shared := atomic.LoadInt32(&svc.shared); shared != 2 {
		t.Errorf("shared renders: %d, want one per host", shared)
	}

	// one spelling per host, or an attacker holds 512 copies of one page and
	// a browser's omitted port misses the copy a proxy's explicit one stored
	for _, spelling := range []string{"APP.example", "app.example:80"} {
		req := httptest.NewRequest("GET", "http://app.example/news", nil)
		req.Host = spelling
		w := httptest.NewRecorder()
		front.ServeHTTP(w, req)
		if state := w.Header().Get(cacheStateHeader); state != "hit" {
			t.Errorf("%s is a different key: %q", spelling, state)
		}
	}

	// Revalidate names data, not a vhost: the page changed for everyone
	if dropped := pages.invalidatePath("/news"); dropped != 2 {
		t.Errorf("revalidate dropped %d copies, want both hosts", dropped)
	}
}

// The failure direction: a request for an alias of a cacheable page - a
// trailing slash, a doubled slash, a dot segment - reaches the render
// service as written, which answers 308 to the canonical spelling. A 308 is
// unstorable, and the refusal is recorded under the key, which is the
// CANONICAL path. So one free request for /news/ turned off the cache for
// /news: for the rest of the revalidate window, and forever for a page
// whose revalidate is "manual", every visitor paid for their own render.
// Found by the verifier of this phase; the test that should have seen it
// could not, because the fake render service did not canonicalise.
func TestAnAliasDoesNotTurnOffTheCacheForTheCanonicalPage(t *testing.T) {
	svc := &fakeRenderService{boot: 1}
	renderer := httptest.NewServer(svc.handler())
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	pages := newIsr(nil, nil, func(string) {})
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: pages}, u, testInternalKey, time.Second)

	get := func(target string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "http://app.example"+target, nil)
		req.Host = "app.example"
		w := httptest.NewRecorder()
		front.ServeHTTP(w, req)
		return w
	}

	for _, alias := range []string{"/news/", "/news//", "/news/.", "/x/../news"} {
		svc.canonicalised = 0
		pages = newIsr(nil, nil, func(string) {})
		front = newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: pages}, u, testInternalKey, time.Second)

		// the alias itself: the visitor asked for a spelling that is not the
		// page's, and the render service's redirect is the honest answer
		if w := get(alias); w.Code != 308 || w.Header().Get("Location") != "/news" {
			t.Errorf("%s: the visitor got %d -> %q", alias, w.Code, w.Header().Get("Location"))
		}
		// and the canonical page is still cacheable
		if w := get("/news"); w.Header().Get(cacheStateHeader) != "miss" {
			t.Fatalf("%s: /news answered %q after the alias", alias, w.Header().Get(cacheStateHeader))
		}
		if w := get("/news"); w.Header().Get(cacheStateHeader) != "hit" {
			t.Errorf("%s: /news is not cached after the alias: %q", alias, w.Header().Get(cacheStateHeader))
		}
		// the shared render was asked for the canonical spelling, so the
		// render service never had to redirect it
		// the front answered the visitor's redirect itself: an alias never
		// crosses the hop at all
		if n := atomic.LoadInt32(&svc.canonicalised); n != 0 {
			t.Errorf("%s: %d non-canonical requests reached the render service", alias, n)
		}
	}
}

// a shared render is about nobody: the address of whoever triggered it is
// not handed on, whatever a client spelled, or the loaders' api calls would
// carry an address the client chose (found by the verifier of phase 7)
func TestASharedRenderCarriesNoPeer(t *testing.T) {
	var sharedPeer, sharedChain atomic.Value
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == routesPath {
			json.NewEncoder(w).Encode(map[string]any{"boot": 1, "routes": []map[string]any{
				{"pattern": "/news", "seconds": 60, "tags": []string{}},
			}})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if r.Header.Get(sharedRenderHeader) == "1" {
			sharedPeer.Store(r.Header.Get(peerHeader))
			sharedChain.Store(r.Header.Get("X-Forwarded-For"))
		}
		io.WriteString(w, "<html>news</html>")
	}))
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: newIsr(nil, nil, func(string) {})}, u, testInternalKey, time.Second)
	req := httptest.NewRequest("GET", "http://app.example/news", nil)
	req.RemoteAddr = "203.0.113.7:5151"
	req.Header.Set(peerHeader, "6.6.6.6:4")
	req.Header.Set("X-Forwarded-For", "198.51.100.9")
	w := httptest.NewRecorder()
	front.ServeHTTP(w, req)
	if got, _ := sharedPeer.Load().(string); w.Header().Get(cacheStateHeader) != "miss" || got != "" {
		t.Errorf("shared render: state %q, peer %q", w.Header().Get(cacheStateHeader), got)
	}
	if chain, ok := sharedChain.Load().(string); !ok || chain != "" {
		t.Errorf("shared render: forwarded for %q (rendered: %v)", chain, ok)
	}
}

// what a client sends under the name is gone before anything reads it: the
// app's middleware and handlers on the public port never see it
func TestThePublicPortDropsAClientsPeerHeader(t *testing.T) {
	var seen string
	api := http.NewServeMux()
	api.HandleFunc("GET /api/peer", func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get(peerHeader)
		w.WriteHeader(204)
	})
	var rendered http.Header
	renderer := fakeRenderer(t, &rendered)
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	front := newFrontHandler(Middleware(api), frontOptions{trusted: trustAll}, u, testInternalKey, time.Second)
	req := httptest.NewRequest("GET", "/api/peer", nil)
	req.Header.Set(peerHeader, "6.6.6.6:4")
	front.ServeHTTP(httptest.NewRecorder(), req)
	if seen != "" {
		t.Errorf("the api handler saw %q", seen)
	}
}

// on its own, not only behind the front's own strip: a second caller of
// anonymised inherits the property
func TestAnonymisedDropsThePeer(t *testing.T) {
	r := httptest.NewRequest("GET", "/news", nil)
	r.Header.Set(peerHeader, "203.0.113.7:5151")
	r.Header.Set("X-Real-IP", "203.0.113.7")
	r.Header.Set("Forwarded", "for=203.0.113.7")
	anon := anonymised(r)
	for _, name := range []string{peerHeader, "X-Real-IP", "Forwarded"} {
		if got := anon.Header.Get(name); got != "" {
			t.Errorf("anonymised kept %s: %q", name, got)
		}
	}
}

// an api alone honours no peer, having no internal key, and drops it all the
// same: the app reads the header alike in both shapes
func TestAnApiAloneDropsAClientsPeerHeader(t *testing.T) {
	seen := "unread"
	api := http.NewServeMux()
	api.HandleFunc("GET /api/peer", func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get(peerHeader)
		w.WriteHeader(204)
	})
	// the app's own middleware is a reader too: api/middleware.go runs first
	middlewareSaw := "unread"
	app := &appMiddleware{wrap: func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			middlewareSaw = r.Header.Get(peerHeader)
			next.ServeHTTP(w, r)
		})
	}}
	req := httptest.NewRequest("GET", "/api/peer", nil)
	req.Header.Set(peerHeader, "6.6.6.6:4")
	apiOnlyHandler(nil, 1<<20, app, api, nil).ServeHTTP(httptest.NewRecorder(), req)
	if seen != "" || middlewareSaw != "" {
		t.Errorf("the api handler saw %q, the app's middleware %q", seen, middlewareSaw)
	}
}
