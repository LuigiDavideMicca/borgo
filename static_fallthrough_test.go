package borgo

import (
	"net/url"
	"os"
	"path/filepath"
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
