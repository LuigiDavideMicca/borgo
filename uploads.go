package borgo

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"
)

// Uploads stores the files a form sent and serves them back. Decoding is
// BindMultipart's; what to keep about a file - its owner, what it belongs to
// - is the app's, which needs it to authorize a download anyway. Uploads
// owns the part every app gets wrong the same way: what the bytes are, where
// they live, under which name, and the headers a download goes out with.
type Uploads struct {
	// Dir holds the files, created 0700 on the first Save. In development a
	// directory inside the app must be in .gitignore, or every upload
	// rebuilds it; in a container, a volume mounted at the directory the
	// image owns - not below it.
	Dir string
	// Types lists the media types a file may sniff as, without parameters
	// ("image/png"); empty accepts any.
	Types []string
}

// Stored is what Save learned and Serve needs: keep it beside whatever the
// app knows about the file.
type Stored struct {
	// Key names the file in Dir: 32 hex characters, never the client's name.
	Key string `json:"key"`
	// Name is the client's file name with any path and control characters
	// removed: shown back to people, never used as a path.
	Name string `json:"name"`
	// Type is what the bytes sniff as (http.DetectContentType), not what
	// the client claimed.
	Type string `json:"type"`
	Size int64  `json:"size"`
}

var (
	// ErrNoUpload: the form's file field was left empty.
	ErrNoUpload = errors.New("borgo.File: no file was uploaded for this field")
	// ErrUploadType: the bytes sniff as a type Uploads.Types does not list.
	ErrUploadType = errors.New("borgo.Uploads: this type of file is not accepted")
)

// the media types a browser may show in the page rather than download: images
// it decodes and never runs. Everything else is an attachment
var inlineTypes = []string{"image/png", "image/jpeg", "image/gif", "image/webp"}

// Save writes the file under a random key. A write that fails leaves nothing
// behind.
func (u *Uploads) Save(f File) (Stored, error) {
	src, err := f.Open()
	if err != nil {
		return Stored{}, err
	}
	defer src.Close()
	return u.save(src, f.Name)
}

func (u *Uploads) save(src io.Reader, name string) (Stored, error) {
	head := make([]byte, 512)
	n, err := io.ReadFull(src, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return Stored{}, err
	}
	kind := http.DetectContentType(head[:n])
	if len(u.Types) > 0 {
		media, _, _ := mime.ParseMediaType(kind)
		if !slices.Contains(u.Types, media) {
			return Stored{}, fmt.Errorf("%w: %s", ErrUploadType, media)
		}
	}
	if err := os.MkdirAll(u.Dir, 0o700); err != nil {
		return Stored{}, dirError(u.Dir, err)
	}
	stored := Stored{Key: newUploadKey(), Name: cleanUploadName(name), Type: kind}
	path := filepath.Join(u.Dir, stored.Key)
	dst, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return Stored{}, dirError(u.Dir, err)
	}
	written, err := dst.Write(head[:n])
	if err == nil {
		var rest int64
		rest, err = io.Copy(dst, src)
		stored.Size = int64(written) + rest
	}
	// a close that fails is a write that failed: the bytes may not be there
	if closeErr := dst.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(path)
		return Stored{}, err
	}
	return stored, nil
}

// Serve answers with the file, once the caller has decided this request may
// have it. The file goes out as what it sniffed as, never sniffed again by
// the browser, sandboxed if it is opened as a page, kept out of shared
// caches, and inline only for the images a browser draws without running.
func (u *Uploads) Serve(w http.ResponseWriter, r *http.Request, s Stored) {
	if !validUploadKey(s.Key) {
		http.NotFound(w, r)
		return
	}
	file, err := os.Open(filepath.Join(u.Dir, s.Key))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	media, _, _ := mime.ParseMediaType(s.Type)
	disposition := "attachment"
	if slices.Contains(inlineTypes, media) {
		disposition = "inline"
	}
	h := w.Header()
	contentType := s.Type
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	h.Set("Content-Type", contentType)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", "private, no-cache")
	h.Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": cleanUploadName(s.Name)}))
	http.ServeContent(w, r, "", info.ModTime(), file)
}

// Remove deletes the file; one already gone is not an error.
func (u *Uploads) Remove(key string) error {
	if !validUploadKey(key) {
		return fmt.Errorf("borgo.Uploads: %q is not a key Save made", key)
	}
	if err := os.Remove(filepath.Join(u.Dir, key)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// newUploadKey is 128 random bits; a variable so a test can make two
// saves collide and see the second refused rather than overwrite the first
var newUploadKey = func() string {
	key := make([]byte, 16)
	rand.Read(key)
	return hex.EncodeToString(key)
}

func validUploadKey(key string) bool {
	if len(key) != 32 {
		return false
	}
	for i := 0; i < len(key); i++ {
		c := key[i]
		if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f') {
			return false
		}
	}
	return true
}

// cleanUploadName keeps the last path element of either separator, drops
// control characters and invalid utf-8, and caps it at 255 bytes.
func cleanUploadName(name string) string {
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	var b strings.Builder
	for _, r := range strings.ToValidUTF8(name, "") {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			continue
		}
		if b.Len()+utf8.RuneLen(r) > 255 {
			break
		}
		b.WriteRune(r)
	}
	name = strings.TrimSpace(b.String())
	if name == "" || name == "." || name == ".." {
		return "file"
	}
	return name
}

// dirError names the directory, and on a refused permission the trap a
// container sets: a volume mounted below a directory the image owns is
// created by root, and the app does not run as root
func dirError(dir string, err error) error {
	if errors.Is(err, fs.ErrPermission) {
		return fmt.Errorf("borgo.Uploads: cannot write to %s: %w (in a container, mount the volume at a directory the image creates for the app's user, not below it)", dir, err)
	}
	return fmt.Errorf("borgo.Uploads: cannot write to %s: %w", dir, err)
}
