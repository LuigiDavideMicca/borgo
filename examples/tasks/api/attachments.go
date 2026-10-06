package api

import (
	"cmp"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"

	"github.com/LuigiDavideMicca/borgo"
)

// the form of an upload: a note and a file, read with borgo.BindMultipart,
// so the page's call to this route sends a FormData and its body is typed
type AttachmentForm struct {
	Note string     `json:"note"`
	File borgo.File `json:"file"`
}

type Attachment struct {
	Note string `json:"note"`
	// the name the client gave, shown back to it; never a path
	Name string `json:"name"`
	Size int64  `json:"size"`
	// what the bytes are, sniffed here: the client's Content-Type is a claim
	Type string `json:"type"`
}

// where uploads land: outside the project, so a dev watcher never sees them
// and a deploy never ships them. A real app puts this on a volume or a bucket,
// gives each file an owner and a lifetime; this one keeps the newest few, so
// a signed-in user can fill no more than keptAttachments times the cap
var attachmentsDir = filepath.Join(os.TempDir(), "borgo-tasks-attachments")

const keptAttachments = 20

func init() {
	// writing to the server's disk is for signed-in users only
	borgo.Handle("POST /api/attachments", borgo.Authed(UploadAttachment))
}

func UploadAttachment(w http.ResponseWriter, r *http.Request) {
	form, err := borgo.BindMultipart[AttachmentForm](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	src, err := form.File.Open()
	if err != nil {
		// plain text keeps the generated response type to the 201's
		http.Error(w, "a file is required", http.StatusBadRequest)
		return
	}
	defer src.Close()
	// the first 512 bytes decide what this is, not the header
	head := make([]byte, 512)
	n, _ := io.ReadFull(src, head)
	kind := http.DetectContentType(head[:n])

	// a name of our own: the client's is a path traversal waiting to happen
	key := make([]byte, 16)
	rand.Read(key)
	if err := os.MkdirAll(attachmentsDir, 0o700); err != nil {
		http.Error(w, "storage unavailable", http.StatusInternalServerError)
		return
	}
	path := filepath.Join(attachmentsDir, hex.EncodeToString(key))
	dst, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		http.Error(w, "storage unavailable", http.StatusInternalServerError)
		return
	}
	_, err = dst.Write(head[:n])
	if err == nil {
		_, err = io.Copy(dst, src)
	}
	// a close that fails is a write that failed: the bytes may not be there
	if closeErr := dst.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		// a half-written file is not an attachment: it goes
		os.Remove(path)
		http.Error(w, "storage failed", http.StatusInternalServerError)
		return
	}
	pruneAttachments()
	borgo.JSON(w, http.StatusCreated, Attachment{Note: form.Note, Name: form.File.Name, Size: form.File.Size, Type: kind})
}

// pruneAttachments removes all but the newest keptAttachments files. Two
// uploads pruning at once may both try a file: a failed remove is no error
func pruneAttachments() {
	entries, err := os.ReadDir(attachmentsDir)
	if err != nil || len(entries) <= keptAttachments {
		return
	}
	type stored struct {
		path string
		mod  int64
	}
	files := make([]stored, 0, len(entries))
	for _, e := range entries {
		if info, err := e.Info(); err == nil && info.Mode().IsRegular() {
			files = append(files, stored{filepath.Join(attachmentsDir, e.Name()), info.ModTime().UnixNano()})
		}
	}
	slices.SortFunc(files, func(a, b stored) int { return cmp.Compare(b.mod, a.mod) })
	for _, f := range files[min(keptAttachments, len(files)):] {
		os.Remove(f.path)
	}
}
