package borgo

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
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
}

func (f *fakeRenderService) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

// an alias with dot segments is the same page under the cleaned key, so an
// invalidation by the plain name reaches it
func TestFrontKeysTheCacheOnTheCleanedPath(t *testing.T) {
	svc := &fakeRenderService{boot: 1}
	renderer := httptest.NewServer(svc.handler())
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	pages := newIsr(nil, nil, func(string) {})
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: pages}, u, testInternalKey, time.Second)
	get := func(p string) string {
		w := httptest.NewRecorder()
		front.ServeHTTP(w, httptest.NewRequest("GET", "http://app.example"+p, nil))
		return w.Header().Get(cacheStateHeader)
	}
	get("/x/../news")
	if got := get("/news"); got != "hit" {
		t.Errorf("the alias and the plain name share a key: %q", got)
	}
	if dropped := pages.invalidatePath("/news"); dropped != 1 {
		t.Errorf("dropped %d", dropped)
	}
	if got := get("/x/../news"); got != "miss" {
		t.Errorf("after invalidation the alias: %q", got)
	}
	// the boot stamp is the proxy's and stays out of a replay too
	w := httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "http://app.example/news", nil))
	if w.Header().Get(bootHeader) != "" || w.Header().Get(cacheStateHeader) != "hit" {
		t.Errorf("a replay carried the stamp: %q (%q)", w.Header().Get(bootHeader), w.Header().Get(cacheStateHeader))
	}
}
