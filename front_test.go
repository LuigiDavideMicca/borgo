package borgo

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const testInternalKey = "0123456789abcdef0123456789abcdef"

// a renderer that records what reached it and answers with a marker
func fakeRenderer(t *testing.T, seen *http.Header) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if seen != nil {
			*seen = r.Header.Clone()
			seen.Set("X-Test-Host", r.Host)
			seen.Set("X-Test-Path", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-Borgo-Cache", "miss")
		// never set by the real render service; the front must not relay
		// them if it ever were
		w.Header().Set(internalKeyHeader, "leak")
		w.Header().Set(sessionHeader, "leak")
		w.WriteHeader(200)
		io.WriteString(w, "<html>rendered "+r.URL.Path+"</html>")
	}))
}

func apiUnderTest() http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/hello", func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, 200, map[string]string{"message": "hello"})
	})
	api.HandleFunc("POST /api/tasks", func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, 201, map[string]string{"created": "yes"})
	})
	api.HandleFunc("GET /healthz", healthz)
	return Middleware(api)
}

func frontUnderTest(t *testing.T, renderer *httptest.Server, csrf bool) http.Handler {
	t.Helper()
	u, err := url.Parse(renderer.URL)
	if err != nil {
		t.Fatal(err)
	}
	return newFrontHandler(apiUnderTest(), csrf, u, testInternalKey, time.Second)
}

func TestFrontAnswersApiInProcess(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)

	for _, path := range []string{"/api/hello", "/healthz"} {
		w := httptest.NewRecorder()
		front.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 {
			t.Fatalf("%s: %d", path, w.Code)
		}
		if strings.Contains(w.Body.String(), "rendered") {
			t.Fatalf("%s reached the renderer: %s", path, w.Body.String())
		}
	}
	// a dot-segment spelling is decided on its cleaned form and lands on the
	// mux, which answers the canonical spelling with net/http's own redirect
	w := httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/x/../api/hello", nil))
	if w.Code != 307 || w.Header().Get("Location") != "/api/hello" {
		t.Fatalf("/x/../api/hello: %d %q", w.Code, w.Header().Get("Location"))
	}
	if seen != nil {
		t.Fatal("an in-process path was forwarded")
	}
}

func TestFrontForwardsPagesWithTheBootKey(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)

	req := httptest.NewRequest("GET", "http://app.example/about?x=1", nil)
	req.Host = "app.example"
	// a client presenting the internal names must not get them through
	req.Header.Set(internalKeyHeader, "forged")
	req.Header.Set(sessionHeader, "forged")
	w := httptest.NewRecorder()
	front.ServeHTTP(w, req)

	if w.Code != 200 || !strings.Contains(w.Body.String(), "rendered /about") {
		t.Fatalf("page not forwarded: %d %s", w.Code, w.Body.String())
	}
	if got := seen.Get(internalKeyHeader); got != testInternalKey {
		t.Errorf("renderer saw key %q, want this boot's", got)
	}
	if got := seen.Get(sessionHeader); got != "" {
		t.Errorf("a forged session header reached the renderer: %q", got)
	}
	if got := seen.Get("X-Test-Host"); got != "app.example" {
		t.Errorf("renderer saw Host %q, want the browser's", got)
	}
	if got := seen.Get("X-Forwarded-Host"); got != "app.example" {
		t.Errorf("X-Forwarded-Host %q", got)
	}
	if got := w.Header().Get("X-Borgo-Cache"); got != "miss" {
		t.Errorf("renderer's headers did not reach the client: %q", got)
	}
	// and the names stay between the processes in the other direction too
	for _, name := range []string{internalKeyHeader, sessionHeader} {
		if got := w.Header().Get(name); got != "" {
			t.Errorf("response header %s reached the client: %q", name, got)
		}
	}
}

// behind a tls-terminating proxy the render service must still see the
// scheme the browser used, or every websocket origin is refused; and the
// client chain a proxy built is kept, with this hop appended
func TestFrontKeepsTheForwardedChainItWasHanded(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)

	req := httptest.NewRequest("GET", "/live", nil)
	req.RemoteAddr = "10.0.0.5:4444"
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	front.ServeHTTP(httptest.NewRecorder(), req)

	if got := seen.Get("X-Forwarded-Proto"); got != "https" {
		t.Errorf("X-Forwarded-Proto %q, want the scheme the proxy in front saw", got)
	}
	if got := seen.Get("X-Forwarded-For"); got != "203.0.113.9, 10.0.0.5" {
		t.Errorf("X-Forwarded-For %q, want the chain with this hop appended", got)
	}

	// and with nothing in front, the facts are this connection's
	seen = nil
	bare := httptest.NewRequest("GET", "/live", nil)
	bare.RemoteAddr = "10.0.0.5:4444"
	front.ServeHTTP(httptest.NewRecorder(), bare)
	if got := seen.Get("X-Forwarded-Proto"); got != "http" {
		t.Errorf("X-Forwarded-Proto %q with no proxy in front", got)
	}
	if got := seen.Get("X-Forwarded-For"); got != "10.0.0.5" {
		t.Errorf("X-Forwarded-For %q with no proxy in front", got)
	}
}

func TestFrontForwardsAVerifiedSessionAsAFact(t *testing.T) {
	t.Setenv("SESSION_SECRET", "a-test-secret-of-at-least-32-bytes-long")
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)

	issued := httptest.NewRecorder()
	if err := SetSession(issued, map[string]any{"userId": 7, "role": "admin"}, time.Hour); err != nil {
		t.Fatal(err)
	}
	cookie := issued.Result().Cookies()[0]

	req := httptest.NewRequest("GET", "/app", nil)
	req.AddCookie(cookie)
	front.ServeHTTP(httptest.NewRecorder(), req)
	raw, err := base64.RawURLEncoding.DecodeString(seen.Get(sessionHeader))
	if err != nil {
		t.Fatalf("session header is not base64url: %v", err)
	}
	if string(raw) != `{"role":"admin","userId":7}` {
		t.Errorf("session payload %s", raw)
	}

	// tampered: no fact travels, and the cookie is not the render service's
	// to judge
	bad := httptest.NewRequest("GET", "/app", nil)
	bad.AddCookie(&http.Cookie{Name: cookie.Name, Value: cookie.Value[:len(cookie.Value)-2] + "xx"})
	seen = nil
	front.ServeHTTP(httptest.NewRecorder(), bad)
	if got := seen.Get(sessionHeader); got != "" {
		t.Errorf("a tampered cookie produced a session header: %q", got)
	}

	// expired: signed by this server, and still no fact
	stale := httptest.NewRecorder()
	if err := SetSession(stale, map[string]any{"userId": 7}, -time.Hour); err != nil {
		t.Fatal(err)
	}
	expired := httptest.NewRequest("GET", "/app", nil)
	expired.AddCookie(stale.Result().Cookies()[0])
	seen = nil
	front.ServeHTTP(httptest.NewRecorder(), expired)
	if got := seen.Get(sessionHeader); got != "" {
		t.Errorf("an expired cookie produced a session header: %q", got)
	}
}

func TestFrontInternalNamesAreNotPublic(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)

	// the dot-segment spellings are the ones that passed a prefix test and
	// were normalised into the internal name at the far end
	for _, path := range []string{"/__borgo/publish", "/__borgo", "/x/../__borgo/publish", "/./__borgo/dev", "//__borgo/publish", "/__borgo/dev/../publish"} {
		w := httptest.NewRecorder()
		front.ServeHTTP(w, httptest.NewRequest("POST", path, strings.NewReader(`{}`)))
		if w.Code != 404 {
			t.Errorf("%s on the public port answered %d", path, w.Code)
		}
	}
	if seen != nil {
		t.Fatalf("an internal name was forwarded as %q", seen.Get("X-Test-Path"))
	}
}

func TestFrontRunsTheCsrfCheckBunUsedToRun(t *testing.T) {
	renderer := fakeRenderer(t, nil)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, true)

	post := func(cookie, header string) int {
		req := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		if header != "" {
			req.Header.Set(csrfHeader, header)
		}
		w := httptest.NewRecorder()
		front.ServeHTTP(w, req)
		return w.Code
	}
	if got := post("", ""); got != 201 {
		t.Errorf("a cookie-less client (curl, a mobile app) answered %d", got)
	}
	if got := post("borgo_csrf=tok", ""); got != 403 {
		t.Errorf("a browser with the cookie and no header answered %d", got)
	}
	if got := post("borgo_csrf=tok", "wrong"); got != 403 {
		t.Errorf("a wrong header answered %d", got)
	}
	if got := post("borgo_csrf=tok; borgo_csrf=other", "tok"); got != 403 {
		t.Errorf("disagreeing duplicate cookies answered %d", got)
	}
	if got := post("borgo_csrf=tok", "tok"); got != 201 {
		t.Errorf("the echoed token answered %d", got)
	}
	// safe methods are never asked
	req := httptest.NewRequest("GET", "/api/hello", nil)
	req.Header.Set("Cookie", "borgo_csrf=tok")
	w := httptest.NewRecorder()
	front.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Errorf("a GET with the cookie and no header answered %d", w.Code)
	}
	// and the internal listener, which only the render service reaches with
	// the browser's cookies re-sent by a loader, is not guarded
	internal := requireInternalKey(testInternalKey, apiUnderTest())
	req = httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{}`))
	req.Header.Set("Cookie", "borgo_csrf=tok")
	req.Header.Set(internalKeyHeader, testInternalKey)
	w = httptest.NewRecorder()
	internal.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Errorf("the internal listener ran the csrf check: %d", w.Code)
	}
}

func TestFrontSaysWhenTheRendererIsDown(t *testing.T) {
	renderer := fakeRenderer(t, nil)
	renderer.Close() // the address is known and nothing listens
	front := frontUnderTest(t, renderer, false)

	w := httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/about", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("renderer down answered %d", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Error("a 503 must say when to come back")
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("the refusal page is served without nosniff")
	}
	if !strings.Contains(w.Body.String(), "the api is up") {
		t.Errorf("the page does not say what still works: %q", w.Body.String())
	}

	// and the api is, in fact, up
	w = httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/api/hello", nil))
	if w.Code != 200 {
		t.Fatalf("api answered %d with the renderer down", w.Code)
	}
}

func TestFrontRendererTimeoutIs504(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(2 * time.Second):
		case <-r.Context().Done():
		}
	}))
	defer slow.Close()
	u, _ := url.Parse(slow.URL)
	front := newFrontHandler(Middleware(http.NewServeMux()), false, u, testInternalKey, 50*time.Millisecond)

	w := httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/slow", nil))
	if w.Code != http.StatusGatewayTimeout {
		t.Fatalf("a renderer past its header deadline answered %d", w.Code)
	}
}

func TestInternalListenerRequiresTheBootKey(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })
	guarded := requireInternalKey(testInternalKey, inner)

	for _, tc := range []struct {
		key  string
		want int
	}{
		{"", 403},
		{"wrong", 403},
		{testInternalKey + "x", 403},
		{testInternalKey, 204},
	} {
		req := httptest.NewRequest("GET", "/api/hello", nil)
		if tc.key != "" {
			req.Header.Set(internalKeyHeader, tc.key)
		}
		w := httptest.NewRecorder()
		guarded.ServeHTTP(w, req)
		if w.Code != tc.want {
			t.Errorf("key %q: %d, want %d", tc.key, w.Code, tc.want)
		}
	}
}

func TestFrontModeRefusesAnUnusableEnvironment(t *testing.T) {
	t.Setenv("BORGO_FRONT", "1")
	t.Setenv("BORGO_INTERNAL_KEY", "short")
	t.Setenv("BORGO_RENDER_URL", "http://127.0.0.1:3600")
	if _, err := internalKey(); err == nil || !strings.Contains(err.Error(), "BORGO_INTERNAL_KEY") {
		t.Errorf("a short key was accepted: %v", err)
	}
	t.Setenv("BORGO_INTERNAL_KEY", testInternalKey)
	for _, bad := range []string{"", "127.0.0.1:3600", "http://127.0.0.1:3600/render", "http://user:pw@127.0.0.1:3600", "ftp://x"} {
		t.Setenv("BORGO_RENDER_URL", bad)
		if _, err := renderURL(); err == nil {
			t.Errorf("BORGO_RENDER_URL=%q was accepted", bad)
		}
	}
	t.Setenv("BORGO_RENDER_URL", "http://127.0.0.1:3600/")
	u, err := renderURL()
	if err != nil || u.String() != "http://127.0.0.1:3600" {
		t.Errorf("a trailing slash is a host: %v %v", u, err)
	}
	t.Setenv("BORGO_FRONT", "maybe")
	if _, err := frontEnabled(); err == nil {
		t.Error("BORGO_FRONT=maybe was read as something")
	}
	t.Setenv("PORT", "80;ls")
	if _, err := envPublicPort(); err == nil {
		t.Error("PORT=80;ls was read as a port")
	}
}

// in front mode PORT is the public port, whose internal names answer 404:
// a push must go to the render service without the operator having to say so
func TestPushDefaultsToTheRenderServiceInFrontMode(t *testing.T) {
	t.Setenv("FRONT_URL", "")
	t.Setenv("PORT", "3000")
	t.Setenv("BORGO_RENDER_URL", "http://127.0.0.1:3600")
	base, from, err := pushBase()
	if err != nil || base != "http://127.0.0.1:3600" || from != "BORGO_RENDER_URL" {
		t.Errorf("pushBase = %q from %q (%v)", base, from, err)
	}
	// an explicit FRONT_URL still wins: the split deployment names it
	t.Setenv("FRONT_URL", "https://front.example")
	base, from, _ = pushBase()
	if base != "https://front.example" || from != "FRONT_URL" {
		t.Errorf("FRONT_URL did not win: %q from %q", base, from)
	}
}
