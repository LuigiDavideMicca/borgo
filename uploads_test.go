package borgo

import (
	"bytes"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var pngBytes = append([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}, bytes.Repeat([]byte{7}, 600)...)

// a File as BindMultipart hands it over, from a real multipart body
func uploadedFile(t *testing.T, filename, contentType string, content []byte) File {
	t.Helper()
	type form struct {
		Doc File `json:"doc"`
	}
	ct, body := multipartBody(t, part{name: "doc", filename: filename, contentType: contentType, value: string(content)})
	f, err := bindMultipartRequest[form](t, ct, body, 64<<20)
	if err != nil {
		t.Fatal(err)
	}
	return f.Doc
}

func dirEntries(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// what the bytes are decides the type, a random key the name on disk, and
// the client's name survives only as text to show
func TestUploadsSaveSniffsAndNamesTheFileItself(t *testing.T) {
	u := &Uploads{Dir: filepath.Join(t.TempDir(), "uploads")}
	s, err := u.Save(uploadedFile(t, `..\..\evil/notes.txt`, "text/plain", pngBytes))
	if err != nil {
		t.Fatal(err)
	}
	if !validUploadKey(s.Key) || s.Name != "notes.txt" || s.Type != "image/png" || s.Size != int64(len(pngBytes)) {
		t.Errorf("%+v", s)
	}
	got, err := os.ReadFile(filepath.Join(u.Dir, s.Key))
	if err != nil || !bytes.Equal(got, pngBytes) {
		t.Errorf("stored bytes: %v %d", err, len(got))
	}
	if names := dirEntries(t, u.Dir); len(names) != 1 || names[0] != s.Key {
		t.Errorf("dir holds %v", names)
	}
	other, err := u.Save(uploadedFile(t, "a.png", "image/png", pngBytes))
	if err != nil || other.Key == s.Key {
		t.Errorf("a second save: %+v %v", other, err)
	}
}

// shorter than the sniffing window, empty, and spilled to disk past the
// memory threshold: all stored whole
func TestUploadsSaveStoresEverySizeWhole(t *testing.T) {
	u := &Uploads{Dir: t.TempDir()}
	for _, content := range [][]byte{[]byte("hi"), {}, bytes.Repeat([]byte("x"), 9<<20)} {
		s, err := u.Save(uploadedFile(t, "f.bin", "application/octet-stream", content))
		if err != nil {
			t.Fatal(err)
		}
		got, _ := os.ReadFile(filepath.Join(u.Dir, s.Key))
		if s.Size != int64(len(content)) || !bytes.Equal(got, content) {
			t.Errorf("size %d: stored %d, said %d", len(content), len(got), s.Size)
		}
	}
	// a file shorter than the sniffing window sniffs as what it holds, not
	// as the zeros past its end
	if s, _ := u.Save(uploadedFile(t, "hi.txt", "text/plain", []byte("hi"))); s.Type != "text/plain; charset=utf-8" {
		t.Errorf("two bytes of text: %q", s.Type)
	}
}

func TestUploadsSaveRefusesWhatTypesDoNotList(t *testing.T) {
	u := &Uploads{Dir: t.TempDir(), Types: []string{"image/png", "image/jpeg"}}
	if _, err := u.Save(uploadedFile(t, "x.png", "image/png", []byte("<html><script>1</script>"))); !errors.Is(err, ErrUploadType) || !strings.Contains(err.Error(), "text/html") {
		t.Errorf("html under a png name: %v", err)
	}
	if names := dirEntries(t, u.Dir); len(names) != 0 {
		t.Errorf("a refused file was kept: %v", names)
	}
	if _, err := u.Save(uploadedFile(t, "x.png", "image/png", pngBytes)); err != nil {
		t.Errorf("a png: %v", err)
	}
	// Types names media types: the charset a text type sniffs with is no
	// reason to refuse it
	text := &Uploads{Dir: t.TempDir(), Types: []string{"text/plain"}}
	if s, err := text.Save(uploadedFile(t, "a.txt", "text/plain", []byte("plain words"))); err != nil || s.Type != "text/plain; charset=utf-8" {
		t.Errorf("text: %+v %v", s, err)
	}
}

// two saves under one key: the second is refused, the first kept whole
func TestUploadsSaveNeverOverwritesAStoredFile(t *testing.T) {
	old := newUploadKey
	defer func() { newUploadKey = old }()
	newUploadKey = func() string { return "0123456789abcdef0123456789abcdef" }
	u := &Uploads{Dir: t.TempDir()}
	if _, err := u.Save(uploadedFile(t, "a.png", "image/png", pngBytes)); err != nil {
		t.Fatal(err)
	}
	if _, err := u.Save(uploadedFile(t, "b.txt", "text/plain", []byte("other"))); err == nil {
		t.Error("a second file under the same key was stored")
	}
	if got, _ := os.ReadFile(filepath.Join(u.Dir, "0123456789abcdef0123456789abcdef")); !bytes.Equal(got, pngBytes) {
		t.Errorf("the first file was replaced: %d bytes", len(got))
	}
}

func TestUploadsSaveWithoutAFileIsErrNoUpload(t *testing.T) {
	u := &Uploads{Dir: t.TempDir()}
	if _, err := u.Save(File{}); !errors.Is(err, ErrNoUpload) {
		t.Errorf("%v", err)
	}
	var f File
	if _, err := f.Open(); !errors.Is(err, ErrNoUpload) {
		t.Errorf("open: %v", err)
	}
}

type failingReader struct{ left int }

func (r *failingReader) Read(p []byte) (int, error) {
	if r.left <= 0 {
		return 0, errors.New("connection reset")
	}
	n := min(len(p), r.left)
	for i := range p[:n] {
		p[i] = 'x'
	}
	r.left -= n
	return n, nil
}

// a body that breaks halfway is not an attachment: nothing is left behind
func TestUploadsSaveLeavesNothingWhenTheBytesStopComing(t *testing.T) {
	u := &Uploads{Dir: t.TempDir()}
	for _, left := range []int{100, 4096} {
		if _, err := u.save(&failingReader{left: left}, "f"); err == nil || !strings.Contains(err.Error(), "connection reset") {
			t.Errorf("left=%d: %v", left, err)
		}
	}
	if names := dirEntries(t, u.Dir); len(names) != 0 {
		t.Errorf("half-written files kept: %v", names)
	}
}

// a directory that cannot be made says which, and a refused permission says
// what usually causes it in a container
func TestUploadsSaveNamesTheDirectoryItCannotWrite(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "file")
	os.WriteFile(blocker, []byte("x"), 0o600)
	u := &Uploads{Dir: filepath.Join(blocker, "uploads")}
	_, err := u.Save(uploadedFile(t, "a.png", "image/png", pngBytes))
	if err == nil || !strings.Contains(err.Error(), u.Dir) {
		t.Errorf("%v", err)
	}
	if err := dirError("/data/uploads", &fs.PathError{Op: "mkdir", Path: "/data/uploads", Err: fs.ErrPermission}); !errors.Is(err, fs.ErrPermission) || !strings.Contains(err.Error(), "not below it") {
		t.Errorf("permission: %v", err)
	}
	if err := dirError("/x", &fs.PathError{Op: "mkdir", Path: "/x", Err: fs.ErrExist}); strings.Contains(err.Error(), "not below it") {
		t.Errorf("the container hint on an unrelated failure: %v", err)
	}
}

func serveUpload(u *Uploads, s Stored, method string, header http.Header) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/api/files/x", nil)
	for k, v := range header {
		r.Header[k] = v
	}
	w := httptest.NewRecorder()
	u.Serve(w, r, s)
	return w
}

// an image the browser draws goes inline; anything else downloads; either
// way the type is the sniffed one, never re-sniffed, never shared, and a
// page opened from it is sandboxed
func TestUploadsServeAnswersWithTheHeadersADownloadNeeds(t *testing.T) {
	u := &Uploads{Dir: t.TempDir()}
	png, _ := u.Save(uploadedFile(t, "shot.png", "image/png", pngBytes))
	html, err := u.Save(uploadedFile(t, "città x.html", "image/png", []byte("<html><script>alert(1)</script></html>")))
	if err != nil {
		t.Fatal(err)
	}

	w := serveUpload(u, png, "GET", nil)
	h := w.Header()
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), pngBytes) {
		t.Fatalf("png: %d %d bytes", w.Code, w.Body.Len())
	}
	for k, want := range map[string]string{
		"Content-Type":            "image/png",
		"X-Content-Type-Options":  "nosniff",
		"Content-Security-Policy": "default-src 'none'; sandbox",
		"Cache-Control":           "private, no-cache",
		"Content-Disposition":     `inline; filename=shot.png`,
	} {
		if h.Get(k) != want {
			t.Errorf("png %s: %q, want %q", k, h.Get(k), want)
		}
	}
	w = serveUpload(u, html, "GET", nil)
	if got := w.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Errorf("html type: %q", got)
	}
	if got := w.Header().Get("Content-Disposition"); got != `attachment; filename*=utf-8''citt%C3%A0%20x.html` {
		t.Errorf("html disposition: %q", got)
	}
	// a type the app kept with a parameter is still the image it names
	if got := serveUpload(u, Stored{Key: png.Key, Name: "a.png", Type: "image/png; x=1"}, "GET", nil).Header().Get("Content-Disposition"); got != "inline; filename=a.png" {
		t.Errorf("parameterised type: %q", got)
	}
	// a name the app kept with a path in it goes out as the name alone
	if got := serveUpload(u, Stored{Key: png.Key, Name: "../../etc/shot.png", Type: png.Type}, "GET", nil).Header().Get("Content-Disposition"); got != "inline; filename=shot.png" {
		t.Errorf("pathed name: %q", got)
	}
	// a quote in a name the app kept is escaped, not a header break
	if got := serveUpload(u, Stored{Key: png.Key, Name: `a"b.png`, Type: png.Type}, "GET", nil).Header().Get("Content-Disposition"); got != `inline; filename="a\"b.png"` {
		t.Errorf("quoted name: %q", got)
	}
	// a Stored the app kept with no type still never lets the browser guess
	if w := serveUpload(u, Stored{Key: png.Key, Name: "n"}, "GET", nil); w.Header().Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment") {
		t.Errorf("no type: %q %q", w.Header().Get("Content-Type"), w.Header().Get("Content-Disposition"))
	}
}

func TestUploadsServeHonoursRangesAndHead(t *testing.T) {
	u := &Uploads{Dir: t.TempDir()}
	s, _ := u.Save(uploadedFile(t, "a.png", "image/png", pngBytes))
	w := serveUpload(u, s, "GET", http.Header{"Range": {"bytes=1-3"}})
	if w.Code != http.StatusPartialContent || w.Body.String() != "PNG" {
		t.Errorf("range: %d %q", w.Code, w.Body.String())
	}
	w = serveUpload(u, s, "HEAD", nil)
	if w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Content-Length") != "608" {
		t.Errorf("head: %d %d %q", w.Code, w.Body.Len(), w.Header().Get("Content-Length"))
	}
}

// the key is the only thing that reaches the filesystem, and only in the
// shape Save makes
func TestUploadsServeAndRemoveTakeOnlyKeysSaveMakes(t *testing.T) {
	dir := t.TempDir()
	u := &Uploads{Dir: filepath.Join(dir, "uploads")}
	s, _ := u.Save(uploadedFile(t, "a.png", "image/png", pngBytes))
	secret := filepath.Join(dir, "0123456789abcdef0123456789abcdef")
	os.WriteFile(secret, []byte("secret"), 0o600)
	for _, key := range []string{"", "../0123456789abcdef0123456789abcdef", "0123456789ABCDEF0123456789ABCDEF", s.Key + "x", s.Key + "0", s.Key[:31], "..", strings.Repeat("g", 32)} {
		if w := serveUpload(u, Stored{Key: key, Type: "text/plain"}, "GET", nil); w.Code != 404 {
			t.Errorf("serve %q: %d", key, w.Code)
		}
		if err := u.Remove(key); err == nil {
			t.Errorf("remove %q: no error", key)
		}
	}
	if w := serveUpload(u, Stored{Key: "0123456789abcdef0123456789abcdef"}, "GET", nil); w.Code != 404 {
		t.Errorf("a key with no file: %d", w.Code)
	}
	os.Mkdir(filepath.Join(u.Dir, "fedcba9876543210fedcba9876543210"), 0o700)
	if w := serveUpload(u, Stored{Key: "fedcba9876543210fedcba9876543210"}, "GET", nil); w.Code != 404 {
		t.Errorf("a directory under a key: %d", w.Code)
	}
	if err := u.Remove(s.Key); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(u.Dir, s.Key)); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("still there: %v", err)
	}
	if err := u.Remove(s.Key); err != nil {
		t.Errorf("removing it twice: %v", err)
	}
	if b, _ := os.ReadFile(secret); string(b) != "secret" {
		t.Error("a file outside the directory was touched")
	}
}

func TestCleanUploadNameKeepsOnlyAName(t *testing.T) {
	long := strings.Repeat("é", 200) // 400 bytes
	for in, want := range map[string]string{
		"photo.png":             "photo.png",
		"a/b/c.txt":             "c.txt",
		`C:\Users\x\c.txt`:      "c.txt",
		"dir/":                  "file",
		"":                      "file",
		"..":                    "file",
		"../..":                 "file",
		"  spaced.txt  ":        "spaced.txt",
		"a\x00b\nc\x7fd\u0085e": "abcde",
		"bad\xffutf8":           "badutf8",
		long:                    strings.Repeat("é", 127),
	} {
		if got := cleanUploadName(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

// invisible format characters go too: a right-to-left override makes a name
// read as another (found by the verifier of phase 6)
func TestCleanUploadNameDropsFormatCharacters(t *testing.T) {
	rlo, bom, zwsp := string(rune(0x202e)), string(rune(0xfeff)), string(rune(0x200b))
	for in, want := range map[string]string{
		"invoice" + rlo + "gnp.exe": "invoicegnp.exe",
		bom + "a" + zwsp + "b.txt":  "ab.txt",
		rlo:                         "file",
	} {
		if got := cleanUploadName(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

// Types is written by hand: case and a parameter do not refuse what it names
func TestUploadsTypesIgnoreCaseAndParameters(t *testing.T) {
	for _, types := range [][]string{{"IMAGE/PNG"}, {"image/png; q=1"}, {" image/png "}} {
		u := &Uploads{Dir: t.TempDir(), Types: types}
		if _, err := u.Save(uploadedFile(t, "a.png", "image/png", pngBytes)); err != nil {
			t.Errorf("%q: %v", types, err)
		}
	}
	u := &Uploads{Dir: t.TempDir(), Types: []string{"image/png;;", "image"}}
	if _, err := u.Save(uploadedFile(t, "a.png", "image/png", pngBytes)); !errors.Is(err, ErrUploadType) {
		t.Errorf("entries that name no media type accepted a png: %v", err)
	}
}

// a link in Dir pointing out of it is not a file Save made
func TestUploadsServeRefusesALinkOutOfDir(t *testing.T) {
	dir := t.TempDir()
	u := &Uploads{Dir: filepath.Join(dir, "uploads")}
	os.MkdirAll(u.Dir, 0o700)
	secret := filepath.Join(dir, "secret")
	os.WriteFile(secret, []byte("SECRET"), 0o600)
	key := "0123456789abcdef0123456789abcdef"
	if err := os.Symlink(secret, filepath.Join(u.Dir, key)); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	if w := serveUpload(u, Stored{Key: key, Type: "text/plain"}, "GET", nil); w.Code != 404 || strings.Contains(w.Body.String(), "SECRET") {
		t.Errorf("served through a link: %d %q", w.Code, w.Body.String())
	}
}

// through the middleware every route gets: a range goes out as the bytes it
// counts, never gzipped under a Content-Range of the uncompressed ones
func TestUploadsServeARangeUncompressedBehindTheMiddleware(t *testing.T) {
	u := &Uploads{Dir: t.TempDir()}
	content := []byte(strings.Repeat("compressible text ", 2000))
	s, err := u.Save(uploadedFile(t, "a.txt", "text/plain", content))
	if err != nil {
		t.Fatal(err)
	}
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { u.Serve(w, r, s) }))
	r := httptest.NewRequest("GET", "/f", nil)
	r.Header.Set("Range", "bytes=0-4999")
	r.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusPartialContent || w.Header().Get("Content-Encoding") != "" || !bytes.Equal(w.Body.Bytes(), content[:5000]) {
		t.Errorf("%d %q %d bytes", w.Code, w.Header().Get("Content-Encoding"), w.Body.Len())
	}
	// and the whole file too: it accepts ranges, so a resume must find the
	// identity bytes it counts
	r = httptest.NewRequest("GET", "/f", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || w.Header().Get("Content-Encoding") != "" || !bytes.Equal(w.Body.Bytes(), content) {
		t.Errorf("whole: %d %q %d bytes", w.Code, w.Header().Get("Content-Encoding"), w.Body.Len())
	}
}
