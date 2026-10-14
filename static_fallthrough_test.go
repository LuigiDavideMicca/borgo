package borgo

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"net/http/httptest"
)

// a route beats an extension-less file of the same name (decided 9/9). The
// render service applied it by probing the disk after its router missed, and
// that probe served what this side had refused; the rule is this side's now
// (found by hunt 3)
func TestARouteBeatsAnExtensionlessFile(t *testing.T) {
	root := filepath.Join(t.TempDir(), "public")
	os.MkdirAll(root, 0o755)
	os.WriteFile(filepath.Join(root, "news"), []byte("SHADOW FILE"), 0o644)
	os.WriteFile(filepath.Join(root, "standalone"), []byte("a plain file"), 0o644)
	renderer := httptest.NewServer(routerLikeRenderer())
	t.Cleanup(renderer.Close)
	u, _ := url.Parse(renderer.URL)
	front := newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, assets: newAssetIndex(root, buildOutputs{}, false)}, u, testInternalKey, time.Second)
	if w := agreementGet(front, "/news"); w.Body.String() != "<html>the real news</html>" {
		t.Errorf("/news: %d %q, want the page", w.Code, w.Body.String())
	}
	if w := agreementGet(front, "/standalone"); w.Body.String() != "a plain file" {
		t.Errorf("/standalone: %d %q, want the file no route claims", w.Code, w.Body.String())
	}
	// written after boot: the render service's late probe used to serve it
	os.WriteFile(filepath.Join(root, "later"), []byte("written after boot"), 0o644)
	if w := agreementGet(front, "/later"); w.Body.String() != "written after boot" {
		t.Errorf("/later: %d %q, want the file written after boot", w.Code, w.Body.String())
	}
}

// a build that changed only a loader wrote the same hashed names, so the
// persisted copies of the old build loaded and served as hits (found by
// hunt 3): every build records its own id, and the id is part of the key
func TestEveryBuildKeysItsOwnPersistedCopies(t *testing.T) {
	dir := t.TempDir()
	write := func(build string) buildOutputs {
		file := filepath.Join(dir, "build-output.json")
		os.WriteFile(file, []byte(`{"dir":"public/assets","hashed":{"page-a1b2c3d4.js":512},"build":"`+build+`"}`), 0o644)
		return readBuildOutputs(file)
	}
	first, second := write("one"), write("two")
	if first.build != "one" || second.build != "two" {
		t.Fatalf("the build id was not read: %q %q", first.build, second.build)
	}
	if buildIDFromInventory(first) == buildIDFromInventory(second) {
		t.Error("two builds with the same hashed names share a cache key")
	}
	// an app with no hashed outputs still has a build of its own
	file := filepath.Join(dir, "plain.json")
	os.WriteFile(file, []byte(`{"dir":"","hashed":{},"build":"three"}`), 0o644)
	if o := readBuildOutputs(file); o.build != "three" || buildIDFromInventory(o) == buildIDFromInventory(buildOutputs{}) {
		t.Errorf("a build without hashed outputs: %q", o.build)
	}
}

// every header a client sent rode along to the shared render: one of 16 kB
// made the render service answer 431, recorded as the page's refusal - one
// request turned the cache off - and a loader reading any of them baked it
// into everybody's copy (found by hunt 3)
func TestASharedRenderGetsOnlyTheHeadersItIsGiven(t *testing.T) {
	req := httptest.NewRequest("GET", "http://app.example/news", nil)
	req.Header.Set("X-Anything", "personal")
	req.Header.Set("Referer", "https://elsewhere.example/me")
	req.Header.Set("User-Agent", strings.Repeat("a", 16*1024))
	req.Header.Set("Accept", "text/html")
	req.Header.Set("X-Forwarded-Proto", "https")
	anon := anonymised(req)
	for _, name := range []string{"X-Anything", "Referer", "User-Agent"} {
		if got := anon.Header.Get(name); got != "" {
			t.Errorf("%s reached the shared render (%d bytes)", name, len(got))
		}
	}
	if anon.Header.Get("Accept") != "text/html" || anon.Header.Get("X-Forwarded-Proto") != "https" {
		t.Errorf("a header the shared render is given went missing: %v", anon.Header)
	}
}

// a render that says what it was told: the scheme and the host its public
// url would be built from
func echoingFront(t *testing.T) http.Handler {
	t.Helper()
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == routesPath {
			json.NewEncoder(w).Encode(map[string]any{"boot": 1, "routes": []map[string]any{
				{"pattern": "/news", "seconds": 60, "tags": []string{}},
			}})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, "<html>"+r.Header.Get("X-Forwarded-Proto")+"://"+r.Header.Get("X-Forwarded-Host")+"</html>")
	}))
	t.Cleanup(renderer.Close)
	u, _ := url.Parse(renderer.URL)
	return newFrontHandler(apiUnderTest(), frontOptions{trusted: trustAll, isr: newIsr(nil, nil, func(string) {})}, u, testInternalKey, time.Second)
}

func echoGet(front http.Handler, host, proto string) string {
	req := httptest.NewRequest("GET", "http://app.example/news", nil)
	req.Host = host
	req.Header.Set("X-Forwarded-Proto", proto)
	w := httptest.NewRecorder()
	front.ServeHTTP(w, req)
	return w.Body.String()
}

// a trusted proxy carrying both schemes: the copy rendered for the first was
// served to the other (found by hunt 3)
func TestTheSchemeIsPartOfTheCacheKey(t *testing.T) {
	front := echoingFront(t)
	echoGet(front, "app.example", "http")
	if got := echoGet(front, "app.example", "https"); got != "<html>https://app.example</html>" {
		t.Fatalf("an https visitor got %q", got)
	}
}

// :80 and :443 were dropped whatever the scheme: Host app.example:80 behind
// https stored its render under the bare host every visitor uses
func TestOnlyTheSchemesOwnPortFoldsIntoTheHost(t *testing.T) {
	front := echoingFront(t)
	echoGet(front, "app.example:80", "https")
	if got := echoGet(front, "app.example", "https"); got != "<html>https://app.example</html>" {
		t.Fatalf("the visitor of https://app.example got %q", got)
	}
	// and the scheme's own port is still the bare host
	echoGet(front, "app.example:443", "https")
	if got := echoGet(front, "app.example", "https"); got != "<html>https://app.example</html>" {
		t.Fatalf("after :443: %q", got)
	}
	if cacheHost("App.Example:443", "https") != "app.example" || cacheHost("app.example:443", "http") != "app.example:443" {
		t.Error("cacheHost folds the wrong port")
	}
}

// the scheme is believed by forwardFacts' rule: a peer nobody trusts does
// not get its own copy by spelling X-Forwarded-Proto
func TestAnUntrustedSchemeIsNotAKeyOfItsOwn(t *testing.T) {
	renderer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == routesPath {
			json.NewEncoder(w).Encode(map[string]any{"boot": 1, "routes": []map[string]any{
				{"pattern": "/news", "seconds": 60, "tags": []string{}},
			}})
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, "<html>news</html>")
	}))
	t.Cleanup(renderer.Close)
	u, _ := url.Parse(renderer.URL)
	front := newFrontHandler(apiUnderTest(), frontOptions{isr: newIsr(nil, nil, func(string) {})}, u, testInternalKey, time.Second)
	first := httptest.NewRequest("GET", "http://app.example/news", nil)
	front.ServeHTTP(httptest.NewRecorder(), first)
	spelled := httptest.NewRequest("GET", "http://app.example/news", nil)
	spelled.Header.Set("X-Forwarded-Proto", "https")
	w := httptest.NewRecorder()
	front.ServeHTTP(w, spelled)
	if w.Header().Get(cacheStateHeader) != "hit" {
		t.Fatalf("an untrusted X-Forwarded-Proto got its own copy: %s", w.Header().Get(cacheStateHeader))
	}
}
