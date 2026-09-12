package borgo

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The table is router.test.ts's, entry for entry: "canonicalPath" and
// "canonicalPath: slash aliases" in packages/borgo/test/router.test.ts. Two
// halves that disagree about the canonical spelling is the defect this
// mirror exists to prevent - the front would forward a path it considers
// canonical, the render service would answer 308, and a 308 is unstorable.
//
// A bun-side test asserts the same rows against canonicalPath, so the two
// tables are pinned to each other rather than each to itself.
func TestCanonicalPathMirrorsTheRenderService(t *testing.T) {
	cases := []struct{ in, want string }{
		// a percent-encoding of an unreserved character is an alias
		{"/ne%77s", "/news"},
		{"/%6eews", "/news"},
		{"/n%65%77s", "/news"},
		{"/%2D%2E%5F%7E", "/-._~"},
		// a canonical path is already itself
		{"/news", "/news"},
		{"/", "/"},
		{"/tasks/42", "/tasks/42"},
		// a reserved octet keeps its escape, in the rfc's upper case
		{"/a%2Fb", "/a%2Fb"},
		{"/a%2fb", "/a%2Fb"},
		{"/q%3Fx", "/q%3Fx"},
		{"/s%20p", "/s%20p"},
		// malformed escapes and non-ascii pass through untouched. Go's
		// server refuses the malformed ones before a handler sees them; the
		// rows stay so the two tables are comparable
		{"/x%GGy", "/x%GGy"},
		{"/x%2", "/x%2"},
		{"/100%", "/100%"},
		{"/caf\u00e9", "/caf\u00e9"},
		{"/%C3%A9", "/%C3%A9"},
		// slash aliases
		{"/news/", "/news"},
		{"/news//", "/news"},
		{"//news", "/news"},
		{"/a//b///c/", "/a/b/c"},
	}
	for _, c := range cases {
		if got := canonicalPath(c.in); got != c.want {
			t.Errorf("canonicalPath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// dot segments are this side's alone: the render service never sees them
// once the front resolves them, and a browser never sends them - but the
// front is not only spoken to by browsers, and an unresolved "/x/../news"
// was a second cache key for /news
func TestCanonicalPathResolvesDotSegments(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/x/../news", "/news"},
		{"/news/.", "/news"},
		{"/./news", "/news"},
		{"/a/b/../../news", "/news"},
		{"/..", "/"},
		{"/../../etc/passwd", "/etc/passwd"},
		// the encoded spellings decode first, so they resolve too
		{"/x/%2E%2E/news", "/news"},
		{"/%2E/news", "/news"},
		// and a dot inside a name is not a segment
		{"/a..b.js", "/a..b.js"},
		{"/.well-known/acme", "/.well-known/acme"},
	}
	for _, c := range cases {
		if got := canonicalPath(c.in); got != c.want {
			t.Errorf("canonicalPath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// the redirect is permanent and method-preserving: a form action posted to
// an alias must arrive at the page as a POST, not be turned into a GET
func TestRedirectToCanonicalPreservesTheMethodAndTheQuery(t *testing.T) {
	for _, method := range []string{"GET", "HEAD", "POST", "PUT", "DELETE"} {
		r := httptest.NewRequest(method, "http://app.example/news/?page=2", nil)
		w := httptest.NewRecorder()
		if !redirectToCanonical(w, r, canonicalPath(r.URL.EscapedPath())) {
			t.Fatalf("%s: an alias was not redirected", method)
		}
		if w.Code != http.StatusPermanentRedirect {
			t.Errorf("%s: %d, want 308 (a 301 or 302 turns a POST into a GET)", method, w.Code)
		}
		if loc := w.Header().Get("Location"); loc != "/news?page=2" {
			t.Errorf("%s: Location %q", method, loc)
		}
	}
	// a canonical request is not redirected, whatever else it carries
	r := httptest.NewRequest("GET", "http://app.example/news?page=2", nil)
	w := httptest.NewRecorder()
	if redirectToCanonical(w, r, canonicalPath(r.URL.EscapedPath())) {
		t.Errorf("a canonical path was redirected to %q", w.Header().Get("Location"))
	}
}
