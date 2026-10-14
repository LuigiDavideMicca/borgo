package borgo

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// The front decides on the decoded path; the render service routes the path
// as written, splitting on "/" and decoding each segment on its own, so %2F
// stays inside a param. This renderer routes that way, as router.ts does -
// the one the other front tests use redirects any unclean path, which no
// real router does, and that is how an encoded slash never reached a test
// (found by hunt 3).
func routerLikeRenderer() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == routesPath {
			json.NewEncoder(w).Encode(map[string]any{"boot": 1, "routes": []map[string]any{
				{"pattern": "/news", "seconds": "manual", "tags": []string{"news"}},
				{"pattern": "/posts/:slug", "seconds": nil, "tags": []string{}},
				{"pattern": "/tags/:tag", "seconds": 60, "tags": []string{}},
			}})
			return
		}
		raw := r.URL.EscapedPath()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		switch {
		case raw == "/news":
			io.WriteString(w, "<html>the real news</html>")
		case strings.HasPrefix(raw, "/tags/") && !strings.Contains(raw[len("/tags/"):], "/"):
			tag, _ := url.PathUnescape(raw[len("/tags/"):])
			io.WriteString(w, "<html>tag "+tag+" query "+r.URL.RawQuery+"</html>")
		case strings.HasPrefix(raw, "/posts/") && !strings.Contains(raw[len("/posts/"):], "/"):
			slug, _ := url.PathUnescape(raw[len("/posts/"):])
			io.WriteString(w, "<html>post "+slug+"</html>")
		default:
			w.WriteHeader(http.StatusNotFound)
			io.WriteString(w, "<html>not found</html>")
		}
	})
}

func agreementFront(t *testing.T, app *appMiddleware) http.Handler {
	t.Helper()
	renderer := httptest.NewServer(routerLikeRenderer())
	t.Cleanup(renderer.Close)
	u, _ := url.Parse(renderer.URL)
	return newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: newIsr(nil, nil, func(string) {}), app: app}, u, testInternalKey, time.Second)
}

func agreementGet(h http.Handler, target string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://app.example"+target, nil))
	return w
}

// one unauthenticated request stored another route's render under /news,
// for every visitor, persisted across restarts
func TestAnEncodedSlashCannotStoreAnotherPage(t *testing.T) {
	front := agreementFront(t, nil)
	for _, attack := range []string{"/posts/x%2F..%2F..%2Fnews", "/posts/x%2f..%2f..%2fnews"} {
		if w := agreementGet(front, attack); w.Code == http.StatusOK {
			t.Errorf("%s answered 200: %q", attack, w.Body.String())
		}
	}
	if w := agreementGet(front, "/news"); w.Body.String() != "<html>the real news</html>" {
		t.Fatalf("GET /news: %d %q", w.Code, w.Body.String())
	}
}

func TestAnEncodedSlashCannotGoAroundTheAppsMiddleware(t *testing.T) {
	deny := &appMiddleware{matcher: []string{"/posts/*"}, wrap: func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "members only", http.StatusUnauthorized)
		})
	}}
	front := agreementFront(t, deny)
	if w := agreementGet(front, "/posts/secret"); w.Code != http.StatusUnauthorized {
		t.Fatalf("control: %d", w.Code)
	}
	for _, attack := range []string{"/posts/secret%2F..%2F..%2Fnews", "/posts/..%2Fnews", "/posts/a%2Fb"} {
		w := agreementGet(front, attack)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d %q, want the 400 that refuses an encoded slash", attack, w.Code, w.Body.String())
		}
	}
}

// a 404 for /news%2F was recorded as a refusal under /news: one request and
// the page rendered per visitor, forever under "manual"
func TestAnEncodedSlashCannotTurnTheCacheOff(t *testing.T) {
	front := agreementFront(t, nil)
	agreementGet(front, "/news%2F")
	agreementGet(front, "/news")
	if w := agreementGet(front, "/news"); w.Header().Get(cacheStateHeader) != "hit" {
		t.Fatalf("GET /news after the alias: %s", w.Header().Get(cacheStateHeader))
	}
}

// the api keeps its own rules: ServeMux and the app's middleware both read
// the cleaned path there, so they agree
func TestTheApiIsNotRefusedForAnEncodedSlash(t *testing.T) {
	front := agreementFront(t, nil)
	if w := agreementGet(front, "/api/hello%2Fx"); w.Code == http.StatusBadRequest && strings.Contains(w.Body.String(), "encoded slash") {
		t.Fatalf("the api answered the page refusal: %q", w.Body.String())
	}
}

// decoded, an escaped "?" read as the start of the query: the tag "x?a=1"
// and the tag "x" asked with ?a=1 shared a key, and either was served as the
// other
func TestAnEscapedQuestionMarkIsNotTheQuery(t *testing.T) {
	front := agreementFront(t, nil)
	if w := agreementGet(front, "/tags/x%3Fa=1"); w.Body.String() != "<html>tag x?a=1 query </html>" {
		t.Fatalf("/tags/x%%3Fa=1: %d %q", w.Code, w.Body.String())
	}
	if w := agreementGet(front, "/tags/x?a=1"); w.Body.String() != "<html>tag x query a=1</html>" {
		t.Fatalf("/tags/x?a=1 got %s %q", w.Header().Get(cacheStateHeader), w.Body.String())
	}
}

func TestRevalidateNamesAPageInAnySpelling(t *testing.T) {
	for in, want := range map[string]string{
		"/news":        "/news",
		"/news/":       "/news",
		"/x/../news":   "/news",
		"//news":       "/news",
		"/ne%77s":      "/news",
		"/blog/*":      "/blog/*",
		"/blog//*":     "/blog/*",
		"/x/../blog*":  "/blog*",
		"/blog/x/../*": "/blog/*",
		"/*":           "/*",
		"/":            "/",
		"/a%2fb":       "/a%2Fb",
	} {
		if got := revalidatePath(in); got != want {
			t.Errorf("revalidatePath(%q) = %q, want %q", in, got, want)
		}
	}
	pages := newIsr(nil, nil, func(string) {})
	for _, spelling := range []string{"/news/", "/x/../news"} {
		pages.cache.store("app.example"+keyHostSep+"/news", &cachedPage{body: []byte("x"), status: 200, storedAt: time.Now()})
		if n := pages.invalidatePath(spelling); n != 1 {
			t.Errorf("invalidatePath(%q) dropped %d copies of /news", spelling, n)
		}
	}
}
