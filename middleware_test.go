package borgo

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// the app's middleware for these tests: records every request it sees and
// refuses the ones that ask to be refused
type probeMiddleware struct {
	seen int32
}

func (p *probeMiddleware) app(matcher ...string) *appMiddleware {
	return &appMiddleware{matcher: matcher, wrap: func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&p.seen, 1)
			if r.Header.Get("X-Block") == "1" {
				w.WriteHeader(http.StatusForbidden)
				w.Write([]byte("refused by the app's middleware"))
				return
			}
			next.ServeHTTP(w, r)
		})
	}}
}

// the registry is package state: each test that touches it leaves it as it was
func isolateRegistry(t *testing.T) {
	t.Helper()
	routesMu.Lock()
	saved, savedServed := registered, served
	registered, served = nil, false
	routesMu.Unlock()
	t.Cleanup(func() {
		routesMu.Lock()
		registered, served = saved, savedServed
		routesMu.Unlock()
	})
}

func panicsWith(t *testing.T, want string, fn func()) {
	t.Helper()
	defer func() {
		t.Helper()
		msg, _ := recover().(string)
		if !strings.Contains(msg, want) {
			t.Errorf("want a panic containing %q, got %q", want, msg)
		}
	}()
	fn()
}

func TestUseMiddlewareRefusesWhatWouldGuardNothing(t *testing.T) {
	isolateRegistry(t)
	pass := func(next http.Handler) http.Handler { return next }

	panicsWith(t, "nil middleware", func() { UseMiddleware(nil, nil) })
	for entry, reason := range map[string]string{
		"":             "is empty",
		"api/admin":    "absolute path",
		"/api/*/users": "wildcard anywhere else",
		"/api?x=1":     "without a query",
		"/api/../x":    "not a clean path",
		"/api//admin":  "not a clean path",
		"/%61dmin":     "decoded path",
		"/citt%C3%A0":  "decoded path",
	} {
		panicsWith(t, reason, func() { UseMiddleware(pass, []string{entry}) })
	}

	UseMiddleware(pass, []string{"/api/admin/*"})
	panicsWith(t, "already registered", func() { UseMiddleware(pass, nil) })

	routesMu.Lock()
	registered, served = nil, true
	routesMu.Unlock()
	panicsWith(t, "after borgo.Serve", func() { UseMiddleware(pass, nil) })
}

func TestMatcherGrammarIsRevalidates(t *testing.T) {
	app := (&probeMiddleware{}).app("/api/admin/*", "/app*", "/exact")
	for path, want := range map[string]bool{
		"/api/admin":         true,
		"/api/admin/users":   true,
		"/api/administrator": false, // a "/*" entry is a subtree, not a prefix
		"/app":               true,
		"/apple":             true, // a bare "*" is a prefix, as in Revalidate
		"/exact":             true,
		"/exact/child":       false,
		"/":                  false,
	} {
		if got := app.covers(path); got != want {
			t.Errorf("covers(%q) = %v, want %v", path, got, want)
		}
	}
	if !(&probeMiddleware{}).app().covers("/anything") {
		t.Error("no matcher must cover everything")
	}
}

func block(req *http.Request) *http.Request {
	req.Header.Set("X-Block", "1")
	return req
}

// The positions, one test each. Every one of these is a failure direction of
// the design: the handler reached by falling through, a probe refused, a
// cached copy served past the guard, an alias slipping past the matcher.
func TestTheAppMiddlewareStandsInFrontOfTheApi(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	probe := &probeMiddleware{}
	// a matcher naming the exact path, so the doubled-slash request below
	// proves the match is taken on the cleaned path and not merely that a
	// middleware covering everything covers this too
	front := frontWith(t, renderer, frontOptions{trusted: trustAll, app: probe.app("/api/hello")})

	w := httptest.NewRecorder()
	front.ServeHTTP(w, block(httptest.NewRequest("GET", "/api/hello", nil)))
	if w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), "hello") {
		t.Errorf("a refused api request reached the handler: %d %q", w.Code, w.Body.String())
	}
	// matched on the cleaned path: a doubled slash is the same api path
	w = httptest.NewRecorder()
	front.ServeHTTP(w, block(httptest.NewRequest("GET", "/api//hello", nil)))
	if w.Code != http.StatusForbidden {
		t.Errorf("/api//hello slipped past the middleware: %d", w.Code)
	}
}

func TestTheAppMiddlewareStandsInFrontOfPagesAndFiles(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	root, outputs := publicTree(t)
	probe := &probeMiddleware{}
	front := frontWith(t, renderer, frontOptions{trusted: trustAll, app: probe.app(), assets: newAssetIndex(root, outputs, false)})

	w := httptest.NewRecorder()
	front.ServeHTTP(w, block(httptest.NewRequest("GET", "/dashboard", nil)))
	if w.Code != http.StatusForbidden || seen != nil {
		t.Errorf("a refused page reached the render service: %d, render saw %v", w.Code, seen)
	}
	w = httptest.NewRecorder()
	front.ServeHTTP(w, block(httptest.NewRequest("GET", "/assets/app-abc12345.js", nil)))
	if w.Code != http.StatusForbidden {
		t.Errorf("a refused file was served: %d", w.Code)
	}
	// and a request it does not refuse goes on to where it was going
	w = httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/dashboard", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "rendered /dashboard") {
		t.Errorf("an allowed page: %d %q", w.Code, w.Body.String())
	}
}

// the cache lives in go and answers without asking anybody: a copy served
// before the middleware is the one authorization bypass this design exists
// to rule out
func TestTheAppMiddlewareStandsInFrontOfTheCache(t *testing.T) {
	svc := &fakeRenderService{boot: 1}
	renderer := httptest.NewServer(svc.handler())
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	pages := newIsr(nil, nil, func(string) {})
	probe := &probeMiddleware{}
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: pages, app: probe.app()}, u, testInternalKey, time.Second)
	get := func(blocked bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "http://app.example/news", nil)
		req.Host = "app.example"
		if blocked {
			block(req)
		}
		w := httptest.NewRecorder()
		front.ServeHTTP(w, req)
		return w
	}
	get(false)
	if state := get(false).Header().Get(cacheStateHeader); state != "hit" {
		t.Fatalf("the page was not cached, so this test proves nothing: %q", state)
	}
	if w := get(true); w.Code != http.StatusForbidden || w.Header().Get(cacheStateHeader) != "" {
		t.Errorf("a cached copy was served past the middleware: %d %q", w.Code, w.Header().Get(cacheStateHeader))
	}
}

func TestTheAppMiddlewareLeavesTheFrontsOwnAnswersAlone(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	probe := &probeMiddleware{}
	front := frontWith(t, renderer, frontOptions{trusted: trustAll, app: probe.app()})

	// a probe refused by a bot blocker restarts the container in a loop
	w := httptest.NewRecorder()
	front.ServeHTTP(w, block(httptest.NewRequest("GET", "/healthz", nil)))
	if w.Code == http.StatusForbidden {
		t.Error("/healthz went through the app's middleware")
	}
	w = httptest.NewRecorder()
	front.ServeHTTP(w, block(httptest.NewRequest("GET", "/__borgo/routes", nil)))
	if w.Code != http.StatusNotFound {
		t.Errorf("an internal name answered %d, not the 404 it always gets", w.Code)
	}
	// an alias is redirected before the matcher sees it, so the matcher only
	// ever sees one spelling
	w = httptest.NewRecorder()
	front.ServeHTTP(w, block(httptest.NewRequest("GET", "/dashboard/", nil)))
	if w.Code != http.StatusPermanentRedirect {
		t.Errorf("an alias answered %d before its redirect", w.Code)
	}
	if n := atomic.LoadInt32(&probe.seen); n != 0 {
		t.Errorf("the app's middleware saw %d requests the front answers itself", n)
	}
}

func TestTheAppMiddlewareCoversOnlyItsMatcher(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	probe := &probeMiddleware{}
	front := frontWith(t, renderer, frontOptions{trusted: trustAll, app: probe.app("/admin/*")})

	w := httptest.NewRecorder()
	front.ServeHTTP(w, block(httptest.NewRequest("GET", "/public", nil)))
	if w.Code != 200 {
		t.Errorf("a path outside the matcher was refused: %d", w.Code)
	}
	w = httptest.NewRecorder()
	front.ServeHTTP(w, block(httptest.NewRequest("GET", "/admin/users", nil)))
	if w.Code != http.StatusForbidden {
		t.Errorf("a path inside the matcher was not: %d", w.Code)
	}
}

func TestAPanickingAppMiddlewareAnswers500AndReachesNothing(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	boom := &appMiddleware{wrap: func(http.Handler) http.Handler {
		return http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("the app's middleware broke") })
	}}
	front := frontWith(t, renderer, frontOptions{trusted: trustAll, app: boom})
	for _, target := range []string{"/dashboard", "/api/hello"} {
		w := httptest.NewRecorder()
		front.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != http.StatusInternalServerError {
			t.Errorf("%s: a panicking middleware answered %d", target, w.Code)
		}
		if strings.Contains(w.Body.String(), "rendered") || strings.Contains(w.Body.String(), "hello") {
			t.Errorf("%s: the handler behind a panicking middleware was reached", target)
		}
	}
	if seen != nil {
		t.Error("the render service was reached behind a panicking middleware")
	}
}

// the loaders' way in and the api-only server are built by internalHandler
// and apiOnlyHandler; serveFront and serveContext are pinned to calling them
func TestTheInternalListenerAndAnApiAloneAreGuardedToo(t *testing.T) {
	probe := &probeMiddleware{}
	internal := internalHandler(testInternalKey, probe.app(), apiUnderTest())
	req := block(httptest.NewRequest("GET", "/api/hello", nil))
	req.Header.Set(internalKeyHeader, testInternalKey)
	w := httptest.NewRecorder()
	internal.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("a loader's api call went around the app's middleware: %d", w.Code)
	}
	alone := apiOnlyHandler(nil, 1<<20, probe.app(), apiUnderTest())
	w = httptest.NewRecorder()
	alone.ServeHTTP(w, block(httptest.NewRequest("GET", "/api/hello", nil)))
	if w.Code != http.StatusForbidden {
		t.Errorf("an api alone went around the app's middleware: %d", w.Code)
	}

	src, err := os.ReadFile("borgo.go")
	if err != nil {
		t.Fatal(err)
	}
	code := strings.ReplaceAll(string(src), "\r\n", "\n")
	for _, want := range []string{
		"internal.Handler = internalHandler(key, app, api)",
		"srv.Handler = apiOnlyHandler(security, maxBody, registeredMiddleware(), mux)",
		"app:      app,",
	} {
		if !strings.Contains(code, want) {
			t.Errorf("borgo.go no longer contains %q", want)
		}
	}
}
