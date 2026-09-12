package borgo

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWithAndValue(t *testing.T) {
	r := httptest.NewRequest("GET", "/x", nil)
	if _, ok := Value[string](r, "role"); ok {
		t.Error("a value nobody set was found")
	}
	withRole := With(r, "role", "admin")
	if role, ok := Value[string](withRole, "role"); !ok || role != "admin" {
		t.Errorf("Value = %q, %v", role, ok)
	}
	// a value of another type is not found as this one
	if _, ok := Value[int](withRole, "role"); ok {
		t.Error("a string was read as an int")
	}
	// copied on write: the derived request does not reach back into its parent
	derived := With(withRole, "tenant", 7)
	if _, ok := Value[int](withRole, "tenant"); ok {
		t.Error("a value set on a derived request leaked into the one it came from")
	}
	if tenant, _ := Value[int](derived, "tenant"); tenant != 7 {
		t.Errorf("tenant = %d", tenant)
	}
	if role, _ := Value[string](derived, "role"); role != "admin" {
		t.Error("a derived request lost what its parent carried")
	}
}

// the app middleware for these tests: forwards and sets what the case asks
func forwarding(apply func(*http.Request) *http.Request) *appMiddleware {
	return &appMiddleware{wrap: func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, apply(r))
		})
	}}
}

// the wire form, byte for byte: locals-context.test.ts decodes this same
// literal on the render side, so the two halves share one encoding
func TestForwardedValuesReachTheRenderService(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	front := frontWith(t, renderer, frontOptions{trusted: trustAll, app: forwarding(func(r *http.Request) *http.Request {
		r = Forward(r, "role", "admin")
		// With stays in go
		return With(r, "dbHandle", "not for the render service")
	})})

	front.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/dashboard", nil))
	if got := seen.Get(localsHeader); got != "eyJyb2xlIjoiYWRtaW4ifQ" {
		t.Errorf("locals on the wire %q", got)
	}
}

func TestAClientCannotForgeLocals(t *testing.T) {
	var seen http.Header
	renderer := fakeRenderer(t, &seen)
	defer renderer.Close()
	for name, app := range map[string]*appMiddleware{
		"no middleware":                   nil,
		"a middleware forwarding nothing": forwarding(func(r *http.Request) *http.Request { return r }),
	} {
		seen = nil
		front := frontWith(t, renderer, frontOptions{trusted: trustAll, app: app})
		req := httptest.NewRequest("GET", "/dashboard", nil)
		req.Header.Set(localsHeader, "eyJyb2xlIjoiYWRtaW4ifQ")
		front.ServeHTTP(httptest.NewRecorder(), req)
		if got := seen.Get(localsHeader); got != "" {
			t.Errorf("%s: a client's X-Borgo-Locals reached the render service: %q", name, got)
		}
	}
	// and a shared render is about nobody, forged or not
	req := httptest.NewRequest("GET", "/news", nil)
	req.Header.Set(localsHeader, "eyJyb2xlIjoiYWRtaW4ifQ")
	if anonymised(req).Header.Get(localsHeader) != "" {
		t.Error("a shared render carried locals")
	}
}

// the failure direction: a 500, never the page rendered with the middleware's
// decision silently missing
func TestLocalsThatCannotCrossAnswer500(t *testing.T) {
	for name, value := range map[string]any{
		"not json":        make(chan int),
		"over the header": strings.Repeat("x", maxLocalsBytes),
	} {
		var seen http.Header
		renderer := fakeRenderer(t, &seen)
		front := frontWith(t, renderer, frontOptions{trusted: trustAll, app: forwarding(func(r *http.Request) *http.Request {
			return Forward(r, "value", value)
		})})
		w := httptest.NewRecorder()
		front.ServeHTTP(w, httptest.NewRequest("GET", "/dashboard", nil))
		renderer.Close()
		if w.Code != http.StatusInternalServerError {
			t.Errorf("%s: answered %d", name, w.Code)
		}
		// the front asks the render service for its policy table before this
		// point, so something reaching the renderer proves nothing: the page
		// itself must not have been asked for
		if seen.Get("X-Test-Path") == "/dashboard" {
			t.Errorf("%s: the page was rendered without its locals", name)
		}
	}
}

func TestTheRenderServiceCannotSetLocalsOnAResponse(t *testing.T) {
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(localsHeader, "leak")
		w.Write([]byte("page"))
	}))
	defer renderer.Close()
	front := frontWith(t, renderer, frontOptions{trusted: trustAll})
	w := httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("GET", "/dashboard", nil))
	if w.Header().Get(localsHeader) != "" {
		t.Error("X-Borgo-Locals reached the browser")
	}
}
