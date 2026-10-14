package borgo

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// a public/ tree with everything the policy has an opinion about, and the
// inventory a build would have written for its hashed outputs
func publicTree(t *testing.T) (root string, outputs buildOutputs) {
	t.Helper()
	dir := t.TempDir()
	root = filepath.Join(dir, "public")
	write := func(rel string, data []byte) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	app := []byte(strings.Repeat("console.log('app');\n", 40))
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(app)
	zw.Close()
	write("assets/app-abc12345.js", app)
	write("assets/app-abc12345.js.gz", gz.Bytes())
	write("assets/app-abc12345.js.br", []byte("brotli-bytes-stand-in"))
	write("assets/style.css", []byte("body{margin:0}"))
	write("logo.png", []byte{0x89, 'P', 'N', 'G'})
	write("sw.js", []byte("self.addEventListener('fetch',()=>{})"))
	write(".env", []byte("SECRET=1"))
	write(".well-known/acme-challenge/token", []byte("ok"))
	write("sub/.git/config", []byte("[core]"))
	write("docs/readme.txt", []byte("hello"))
	write("docs/Logo.PNG", []byte{1, 2, 3})

	outputs = buildOutputs{
		dir: filepath.ToSlash(filepath.Join(root, "assets")),
		sizes: map[string]int64{
			"app-abc12345.js":    int64(len(app)),
			"app-abc12345.js.gz": int64(gz.Len()),
			"app-abc12345.js.br": int64(len("brotli-bytes-stand-in")),
			// vouched but never pinned: it controls every url in its scope
			"sw.js": 1,
		},
	}
	return root, outputs
}

func get(t *testing.T, ix *assetIndex, path string, headers ...string) (*httptest.ResponseRecorder, bool) {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	w := httptest.NewRecorder()
	return w, ix.tryServe(w, req)
}

func TestStaticPinsOnlyWhatTheBuildVouchedFor(t *testing.T) {
	root, outputs := publicTree(t)
	ix := newAssetIndex(root, outputs, false)

	w, served := get(t, ix, "/assets/app-abc12345.js")
	if !served || w.Code != 200 {
		t.Fatalf("hashed output: served=%v %d", served, w.Code)
	}
	if got := w.Header().Get("Cache-Control"); got != immutable {
		t.Errorf("a vouched output is pinned for a year, got %q", got)
	}
	if !strings.HasPrefix(w.Header().Get("ETag"), `W/"`) {
		t.Errorf("etag is not weak: %q", w.Header().Get("ETag"))
	}
	if w.Header().Get("Vary") != "Accept-Encoding" || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/javascript") {
		t.Errorf("headers: %v", w.Header())
	}

	w, _ = get(t, ix, "/assets/style.css")
	if got := w.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("an unhashed file revalidates, got %q", got)
	}
	w, _ = get(t, ix, "/logo.png")
	if w.Header().Get("Cache-Control") != "no-cache" || w.Header().Get("Vary") != "" {
		t.Errorf("an image: %v", w.Header())
	}
}

func TestStaticNegotiatesOnlyTheSiblingsItHas(t *testing.T) {
	root, outputs := publicTree(t)
	ix := newAssetIndex(root, outputs, false)

	w, _ := get(t, ix, "/assets/app-abc12345.js", "Accept-Encoding", "br, gzip")
	if w.Header().Get("Content-Encoding") != "br" || w.Body.String() != "brotli-bytes-stand-in" {
		t.Errorf("br preferred: %q %q", w.Header().Get("Content-Encoding"), w.Body.String())
	}
	if !strings.HasPrefix(w.Header().Get("Content-Type"), "text/javascript") {
		t.Errorf("a sibling keeps the identity's type: %q", w.Header().Get("Content-Type"))
	}
	if !strings.HasSuffix(w.Header().Get("ETag"), `-br"`) {
		t.Errorf("one url's encodings must not revalidate each other: %q", w.Header().Get("ETag"))
	}
	w, _ = get(t, ix, "/assets/app-abc12345.js", "Accept-Encoding", "gzip;Q=0, br;q=0")
	if w.Header().Get("Content-Encoding") != "" {
		t.Errorf("q=0 is a refusal, got %q", w.Header().Get("Content-Encoding"))
	}
	w, _ = get(t, ix, "/assets/app-abc12345.js", "Accept-Encoding", "gzip")
	if w.Header().Get("Content-Encoding") != "gzip" {
		t.Errorf("gzip alone: %q", w.Header().Get("Content-Encoding"))
	}
	// the stylesheet has no siblings: "br" resolves to nothing, identity goes
	w, _ = get(t, ix, "/assets/style.css", "Accept-Encoding", "br, gzip")
	if w.Header().Get("Content-Encoding") != "" || w.Body.String() != "body{margin:0}" {
		t.Errorf("no sibling, identity: %v %q", w.Header(), w.Body.String())
	}
}

func TestStaticRefusesWhatIsNotPublicContent(t *testing.T) {
	root, outputs := publicTree(t)
	ix := newAssetIndex(root, outputs, false)

	for _, p := range []string{"/.env", "/sub/.git/config", "/assets/../.env", "/", "/docs"} {
		if _, served := get(t, ix, p); served {
			t.Errorf("%s was served", p)
		}
	}
	if w, served := get(t, ix, "/.well-known/acme-challenge/token"); !served || w.Body.String() != "ok" {
		t.Errorf("rfc 8615: .well-known must stay served (%v %d)", served, w.Code)
	}
	// a public/ file must not shadow a post
	req := httptest.NewRequest("POST", "/assets/style.css", nil)
	if ix.tryServe(httptest.NewRecorder(), req) {
		t.Error("a POST was answered by a file")
	}
	if runtime.GOOS == "windows" {
		for _, p := range []string{"/assets/style.css::$DATA", "/logo.png:x"} {
			if _, served := get(t, ix, p); served {
				t.Errorf("windows alias %s was served", p)
			}
		}
	}
}

func TestStaticConditionalsAndRanges(t *testing.T) {
	root, outputs := publicTree(t)
	ix := newAssetIndex(root, outputs, false)

	first, _ := get(t, ix, "/assets/style.css")
	etag := first.Header().Get("ETag")
	w, _ := get(t, ix, "/assets/style.css", "If-None-Match", etag)
	if w.Code != 304 {
		t.Errorf("our own weak etag echoed back: %d", w.Code)
	}
	w, _ = get(t, ix, "/assets/style.css", "If-Modified-Since", time.Now().Add(time.Hour).UTC().Format(http.TimeFormat))
	if w.Code != 304 {
		t.Errorf("if-modified-since after the mtime: %d", w.Code)
	}
	w, _ = get(t, ix, "/assets/style.css", "Range", "bytes=0-3")
	if w.Code != 206 || w.Body.String() != "body" {
		t.Errorf("a bare range: %d %q", w.Code, w.Body.String())
	}
	// a weak validator never authorises a range: the whole representation
	// goes rather than new bytes spliced onto an old prefix
	w, _ = get(t, ix, "/assets/style.css", "Range", "bytes=0-3", "If-Range", etag)
	if w.Code != 200 || w.Body.String() != "body{margin:0}" {
		t.Errorf("if-range on a weak tag: %d %q", w.Code, w.Body.String())
	}
	// HEAD keeps the length and loses the body
	req := httptest.NewRequest("HEAD", "/assets/style.css", nil)
	rec := httptest.NewRecorder()
	ix.tryServe(rec, req)
	if rec.Header().Get("Content-Length") != "14" || rec.Body.Len() != 0 {
		t.Errorf("HEAD: length %q body %d", rec.Header().Get("Content-Length"), rec.Body.Len())
	}
}

func TestStaticIndexIsASnapshotTheDiskMayLeave(t *testing.T) {
	root, outputs := publicTree(t)
	ix := newAssetIndex(root, outputs, false)

	// the pin is judged on the file about to be sent, not on the record:
	// a rewrite under the hashed name loses its year
	js := filepath.Join(root, "assets", "app-abc12345.js")
	if err := os.WriteFile(js, []byte("replaced"), 0o644); err != nil {
		t.Fatal(err)
	}
	w, _ := get(t, ix, "/assets/app-abc12345.js")
	if w.Header().Get("Cache-Control") != "no-cache" || w.Body.String() != "replaced" {
		t.Errorf("a replaced output kept its pin or its old bytes: %q %q", w.Header().Get("Cache-Control"), w.Body.String())
	}
	// and the sibling beside it loses the year too: the identity behind the
	// representation sent is no longer the vouched one
	w, _ = get(t, ix, "/assets/app-abc12345.js", "Accept-Encoding", "gzip")
	if w.Header().Get("Cache-Control") != "no-cache" || w.Header().Get("Content-Encoding") != "gzip" {
		t.Errorf("a sibling of a replaced identity kept its pin: %q %q", w.Header().Get("Cache-Control"), w.Header().Get("Content-Encoding"))
	}
	// a gone sibling degrades to identity
	os.Remove(js + ".br")
	w, _ = get(t, ix, "/assets/app-abc12345.js", "Accept-Encoding", "br")
	if w.Code != 200 || w.Header().Get("Content-Encoding") != "" {
		t.Errorf("gone sibling: %d %q", w.Code, w.Header().Get("Content-Encoding"))
	}
	// a gone identity is a 404 even when a sibling remains
	os.Remove(js)
	w, served := get(t, ix, "/assets/app-abc12345.js", "Accept-Encoding", "gzip")
	if !served || w.Code != 404 {
		t.Errorf("gone identity: served=%v %d", served, w.Code)
	}
	// written after boot: a live look, revalidating
	os.WriteFile(filepath.Join(root, "late.txt"), []byte("late"), 0o644)
	w, served = get(t, ix, "/late.txt")
	if !served || w.Code != 200 || w.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("a late file: served=%v %d %q", served, w.Code, w.Header().Get("Cache-Control"))
	}
	// whether a route owns an extension-less path is the front's question
	// (routeOwns, TestARouteBeatsAnExtensionlessFile); asked, the index
	// serves the file written after boot
	os.WriteFile(filepath.Join(root, "about"), []byte("page?"), 0o644)
	if w, served := get(t, ix, "/about"); !served || w.Body.String() != "page?" {
		t.Errorf("a late extension-less file: served=%v %q", served, w.Body.String())
	}
}

func TestStaticServesVouchedOutputsFromMemory(t *testing.T) {
	root, outputs := publicTree(t)
	ix := newAssetIndex(root, outputs, false)
	info := ix.lookup("/assets/app-abc12345.js")
	if info == nil || info.identity.data == nil {
		t.Fatal("a vouched output was not taken into memory")
	}
	if style := ix.lookup("/assets/style.css"); style == nil || style.identity.data != nil {
		t.Error("an unvouched file was taken into memory")
	}
	if sw := ix.lookup("/sw.js"); sw == nil || sw.identity.data != nil || sw.identity.pinnedOK {
		t.Error("a service worker was vouched for")
	}
}

func TestStaticDevIsLiveOnly(t *testing.T) {
	root, outputs := publicTree(t)
	ix := newAssetIndex(root, outputs, true)
	if len(ix.byURL) != 0 {
		t.Fatal("dev indexed the tree")
	}
	w, served := get(t, ix, "/assets/app-abc12345.js", "Accept-Encoding", "br, gzip")
	if !served || w.Code != 200 || w.Header().Get("Content-Encoding") != "" {
		t.Errorf("dev serves identity live: served=%v %d %q", served, w.Code, w.Header().Get("Content-Encoding"))
	}
}

func TestStaticCaseFoldingIsMeasured(t *testing.T) {
	root, outputs := publicTree(t)
	ix := newAssetIndex(root, outputs, false)
	_, servedLower := get(t, ix, "/docs/logo.png")
	_, err := os.Stat(filepath.Join(root, "docs", "logo.png"))
	diskFolds := err == nil
	if servedLower != diskFolds {
		t.Errorf("index folds=%v but the disk folds=%v", servedLower, diskFolds)
	}
}

func TestBuildOutputsAreReadStrictly(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "build-output.json")
	write := func(v any) {
		raw, _ := json.Marshal(v)
		os.WriteFile(file, raw, 0o644)
	}
	write(map[string]any{"dir": "public/assets", "hashed": map[string]any{"a.js": 10, "b.js": 0, "c/d.js": 5, "e.js": "5"}})
	o := readBuildOutputs(file)
	if o.dir != "public/assets" || len(o.sizes) != 1 || o.sizes["a.js"] != 10 {
		t.Errorf("strict read: %+v", o)
	}
	if _, ok := o.recordedSize("public/assets/a.js"); !ok {
		t.Error("a recorded name directly in the directory is vouched")
	}
	for _, p := range []string{"public/copy/assets/a.js", "public/assets/deep/a.js", "other/a.js"} {
		if _, ok := o.recordedSize(p); ok {
			t.Errorf("%s was vouched by a name's shape", p)
		}
	}
	write(map[string]any{"hashed": map[string]any{"a.js": 10}})
	if o := readBuildOutputs(file); o.dir != "" {
		t.Error("no directory, nothing vouched")
	}
	if o := readBuildOutputs(filepath.Join(dir, "missing.json")); o.dir != "" {
		t.Error("a missing inventory vouches for nothing")
	}
}

func TestPickEncoding(t *testing.T) {
	for _, c := range []struct{ accept, want string }{
		{"", ""},
		{"gzip", "gzip"},
		{"br, gzip", "br"},
		{"gzip, br", "br"},
		{"br;q=0, gzip", "gzip"},
		{"br;Q=0, gzip;q=0", ""},
		{"*", "br"},
		{"identity", ""},
		{"gzip;q=abc", ""},
	} {
		if got := pickEncoding(c.accept, []string{"br", "gzip"}); got != c.want {
			t.Errorf("%q: %q, want %q", c.accept, got, c.want)
		}
	}
}

// the disk may answer a url with another file than the spelling names: an
// 8.3 short name on windows, a trailing dot or space, a symlink. The guards
// are judged on the name the disk resolved, not the one asked
func TestStaticJudgesTheNameTheDiskResolved(t *testing.T) {
	root, outputs := publicTree(t)
	if err := os.WriteFile(filepath.Join(root, ".env.local"), []byte("DOTENV-LOCAL-SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}
	ix := newAssetIndex(root, outputs, false)

	for _, p := range []string{"/assets/style.css.", "/assets/style.css%20"} {
		if _, served := get(t, ix, p); served {
			t.Errorf("%q was served as an alias", p)
		}
	}
	if runtime.GOOS == "windows" {
		short := shortName(t, filepath.Join(root, ".env.local"))
		if short != "" && !strings.EqualFold(short, ".env.local") {
			w, served := get(t, ix, "/"+short)
			if served {
				t.Errorf("the 8.3 alias %q of a dotfile was served: %d %q", short, w.Code, w.Body.String())
			}
		}
		dir := shortName(t, filepath.Join(root, "sub", ".git"))
		file := shortName(t, filepath.Join(root, "sub", ".git", "config"))
		if dir != "" && file != "" && !strings.EqualFold(dir, ".git") {
			if _, served := get(t, ix, "/sub/"+dir+"/"+file); served {
				t.Error("the 8.3 alias of a file in a hidden directory was served")
			}
		}
	}
	// the real spelling, still served; and case, where the disk folds
	if w, served := get(t, ix, "/assets/style.css"); !served || w.Code != 200 {
		t.Errorf("the real name: served=%v %d", served, w.Code)
	}
	if ix.folds {
		if w, served := get(t, ix, "/assets/STYLE.CSS"); !served || w.Code != 200 {
			t.Errorf("a folded spelling on a folding disk: served=%v %d", served, w.Code)
		}
	}
	// a symlink pointing outside public/ is not public content, whether it
	// arrived after boot (the live branch) or was there at boot (the walk);
	// one that stays inside is served under its own name
	outside := filepath.Join(t.TempDir(), "outside.txt")
	os.WriteFile(outside, []byte("outside"), 0o644)
	if err := os.Symlink(outside, filepath.Join(root, "link.txt")); err == nil {
		if _, served := get(t, ix, "/link.txt"); served {
			t.Error("a symlink to outside public/ was served (live)")
		}
		os.Symlink(outside, filepath.Join(root, "boot-link.txt"))
		os.Symlink(filepath.Join(root, "docs", "readme.txt"), filepath.Join(root, "alias.txt"))
		os.Symlink(filepath.Join(root, ".env"), filepath.Join(root, "env-alias.txt"))
		booted := newAssetIndex(root, outputs, false)
		if _, served := get(t, booted, "/boot-link.txt"); served {
			t.Error("a symlink to outside public/ was served (indexed at boot)")
		}
		if _, served := get(t, booted, "/env-alias.txt"); served {
			t.Error("a symlink to a dotfile was served (indexed at boot)")
		}
		if w, served := get(t, booted, "/alias.txt"); !served || w.Body.String() != "hello" {
			t.Errorf("a symlink inside public/ is public content: served=%v %q", served, w.Body.String())
		}
	}
}
