package borgo

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// bun 1.4.4 frames a head whose length was never measured as
// Content-Length: 0, and the front passed it on: a crawler read every page
// as empty. The render service marks such an answer and the front drops the
// length; a zero it measured stays (found releasing 0.30)
func TestAHeadTheRenderCouldNotMeasureClaimsNoLength(t *testing.T) {
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Length", "0")
		if r.URL.Path == "/page" {
			w.Header().Set(unmeasuredHeader, "1")
		}
	}))
	defer renderer.Close()
	u, _ := url.Parse(renderer.URL)
	front := httptest.NewServer(newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll}, u, testInternalKey, 0))
	defer front.Close()

	for path, want := range map[string][]string{"/page": nil, "/empty": {"0"}} {
		res, err := http.Head(front.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if got := res.Header.Values("Content-Length"); len(got) != len(want) || (len(want) > 0 && got[0] != want[0]) {
			t.Errorf("%s: Content-Length %q, want %q", path, got, want)
		}
		if res.Header.Get(unmeasuredHeader) != "" {
			t.Errorf("%s: the mark reached the client", path)
		}
	}
}
