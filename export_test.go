package borgo

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func isolateExports(t *testing.T) {
	t.Helper()
	routesMu.Lock()
	saved, savedServed := exports, served
	exports, served = map[string]ExportHandler{}, false
	routesMu.Unlock()
	t.Cleanup(func() {
		routesMu.Lock()
		exports, served = saved, savedServed
		routesMu.Unlock()
	})
}

// the adapter borgogen would generate for
//
//	func Membership(ctx context.Context, userID int64, slug string) (*member, error)
type member struct {
	UserID int64  `json:"userId"`
	Role   string `json:"role"`
}

func membershipAdapter(ctx context.Context, args []json.RawMessage) (any, error) {
	if len(args) != 2 {
		return nil, ExportArity("Membership", 2, len(args))
	}
	var userID int64
	if err := json.Unmarshal(args[0], &userID); err != nil {
		return nil, ExportArgument("Membership", 0, err)
	}
	var slug string
	if err := json.Unmarshal(args[1], &slug); err != nil {
		return nil, ExportArgument("Membership", 1, err)
	}
	switch slug {
	case "missing":
		return nil, errors.New("no such workspace")
	case "boom":
		panic("the export broke")
	case "unencodable":
		return make(chan int), nil
	}
	return &member{UserID: userID, Role: "admin"}, nil
}

func TestExportRefusesWhatItCannotMount(t *testing.T) {
	isolateExports(t)
	panicsWith(t, "not the name of an exported Go function", func() { Export("membership", membershipAdapter) })
	panicsWith(t, "not the name of an exported Go function", func() { Export("", membershipAdapter) })
	panicsWith(t, "not the name of an exported Go function", func() { Export("A/B", membershipAdapter) })
	panicsWith(t, "nil handler", func() { Export("Membership", nil) })
	Export("Membership", membershipAdapter)
	panicsWith(t, "registered twice", func() { Export("Membership", membershipAdapter) })
	routesMu.Lock()
	served = true
	routesMu.Unlock()
	panicsWith(t, "after borgo.Serve", func() { Export("Other", membershipAdapter) })
}

func callThrough(t *testing.T, h http.Handler, method, name, body string) (int, exportAnswer) {
	t.Helper()
	req := httptest.NewRequest(method, exportPrefix+name, strings.NewReader(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var answer exportAnswer
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
		t.Fatalf("%s %s: the answer is not json: %q", method, name, w.Body.String())
	}
	return w.Code, answer
}

func TestAnExportIsCalledAndAnswers(t *testing.T) {
	isolateExports(t)
	Export("Membership", membershipAdapter)
	h := withExports(http.NotFoundHandler())

	code, answer := callThrough(t, h, "POST", "Membership", `[7, "acme"]`)
	if code != 200 || string(answer.Result) != `{"userId":7,"role":"admin"}` || answer.Error != "" {
		t.Errorf("a call: %d %s %q", code, answer.Result, answer.Error)
	}
	// the function's own error is an answer, not a server fault
	code, answer = callThrough(t, h, "POST", "Membership", `[7, "missing"]`)
	if code != 200 || answer.Error != "no such workspace" {
		t.Errorf("a returned error: %d %q", code, answer.Error)
	}
	// a call that does not fit the function is a stale build: 400, named
	for body, want := range map[string]string{
		`[7]`:            "takes 2 arguments",
		`["seven", "x"]`: "argument 1 does not fit",
		`{"userId": 7}`:  "not a json array",
	} {
		code, answer = callThrough(t, h, "POST", "Membership", body)
		if code != 400 || !strings.Contains(answer.Error, want) {
			t.Errorf("%s: %d %q", body, code, answer.Error)
		}
	}
	// contained: the process survives a panic and the caller hears about it
	code, answer = callThrough(t, h, "POST", "Membership", `[7, "boom"]`)
	if code != 500 || !strings.Contains(answer.Error, "panicked") {
		t.Errorf("a panic: %d %q", code, answer.Error)
	}
	code, answer = callThrough(t, h, "POST", "Membership", `[7, "unencodable"]`)
	if code != 500 || !strings.Contains(answer.Error, "does not encode as json") {
		t.Errorf("an unencodable result: %d %q", code, answer.Error)
	}
	code, answer = callThrough(t, h, "POST", "Nope", `[]`)
	if code != 404 || !strings.Contains(answer.Error, "no export named") {
		t.Errorf("an unknown export: %d %q", code, answer.Error)
	}
	code, _ = callThrough(t, h, "GET", "Membership", ``)
	if code != 405 {
		t.Errorf("a GET: %d", code)
	}
}

func TestExportsAreOnlyOnTheInternalListenerAndAheadOfTheAppMiddleware(t *testing.T) {
	isolateExports(t)
	Export("Membership", membershipAdapter)

	// ahead of the app's middleware: it judges browsers by cookies, and the
	// caller here is the render service with the key
	refuseAll := &appMiddleware{wrap: func(http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) })
	}}
	internal := requireInternalKey(testInternalKey, withExports(withAppMiddleware(refuseAll, apiUnderTest())))
	req := httptest.NewRequest("POST", exportPrefix+"Membership", strings.NewReader(`[7, "acme"]`))
	req.Header.Set(internalKeyHeader, testInternalKey)
	w := httptest.NewRecorder()
	internal.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Errorf("an export behind the key answered %d", w.Code)
	}
	// and the api beside it still meets the middleware
	req = httptest.NewRequest("GET", "/api/hello", nil)
	req.Header.Set(internalKeyHeader, testInternalKey)
	w = httptest.NewRecorder()
	internal.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("the api on the internal listener skipped the middleware: %d", w.Code)
	}
	// without the key: nothing
	w = httptest.NewRecorder()
	internal.ServeHTTP(w, httptest.NewRequest("POST", exportPrefix+"Membership", strings.NewReader(`[7, "acme"]`)))
	if w.Code != http.StatusForbidden {
		t.Errorf("an export without the key answered %d", w.Code)
	}

	// the public port never answers one
	renderer := fakeRenderer(t, nil)
	defer renderer.Close()
	front := frontUnderTest(t, renderer, false)
	w = httptest.NewRecorder()
	front.ServeHTTP(w, httptest.NewRequest("POST", exportPrefix+"Membership", strings.NewReader(`[7, "acme"]`)))
	if w.Code != http.StatusNotFound {
		t.Errorf("the public port answered an export with %d", w.Code)
	}
}
