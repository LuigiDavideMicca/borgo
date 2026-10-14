package borgo

import (
	"bytes"
	"log"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

type cleanupUpload struct {
	Title string `json:"title"`
	Photo File   `json:"photo"`
}

func cleanupMux(t *testing.T) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/upload", func(w http.ResponseWriter, r *http.Request) {
		v, err := BindMultipart[cleanupUpload](r)
		if err != nil || v.Photo.Size == 0 {
			t.Errorf("bind: %v %d", err, v.Photo.Size)
		}
		w.WriteHeader(http.StatusOK)
	})
	return mux
}

func postBigUpload(t *testing.T, h http.Handler, header ...string) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	mw.WriteField("title", "x")
	fw, _ := mw.CreateFormFile("photo", "big.bin")
	// past the 8 MiB the parser keeps in memory: spilled to a temporary file
	fw.Write(bytes.Repeat([]byte{0x89}, 12<<20))
	mw.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()
	req, _ := http.NewRequest("POST", srv.URL+"/api/upload", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func tempFilesLeft(t *testing.T, dir string) int {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return len(entries)
}

// net/http removes the spilled files of the request it made; every borgo
// port hands the handler a copy, the form was parsed onto the copy, and the
// files stayed forever (found by hunt 3)
func TestAnUploadLeavesNoTemporaryFileOnAnyPort(t *testing.T) {
	ports := map[string]func(t *testing.T) (http.Handler, []string){
		"front": func(t *testing.T) (http.Handler, []string) {
			u, _ := url.Parse("http://127.0.0.1:1")
			return newFrontHandler(Middleware(cleanupMux(t)), frontOptions{maxBody: 64 << 20}, u, testInternalKey, time.Second), nil
		},
		// with a session check registered, its layer hands on a copy too
		"api alone": func(t *testing.T) (http.Handler, []string) {
			withCheck(t, func(*http.Request, SessionInfo) bool { return true })
			return apiOnlyHandler(nil, 64<<20, nil, cleanupMux(t), nil), nil
		},
		"internal": func(t *testing.T) (http.Handler, []string) {
			withCheck(t, func(*http.Request, SessionInfo) bool { return true })
			return internalHandler(testInternalKey, nil, cleanupMux(t), nil), []string{internalKeyHeader, testInternalKey}
		},
	}
	for name, port := range ports {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("TMP", dir)
			t.Setenv("TEMP", dir)
			t.Setenv("TMPDIR", dir)
			h, header := port(t)
			postBigUpload(t, h, header...)
			if n := tempFilesLeft(t, dir); n != 0 {
				t.Errorf("%d temporary files left after the request", n)
			}
		})
	}
}

func multipartRequest(fields [][2]string, files [][2]string) *http.Request {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for _, f := range fields {
		mw.WriteField(f[0], f[1])
	}
	for _, f := range files {
		fw, _ := mw.CreateFormFile(f[0], f[1])
		fw.Write([]byte("hello"))
	}
	mw.Close()
	r := httptest.NewRequest("POST", "/api/x", &body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	return r
}

type priced struct {
	Price float64 `json:"price"`
	File  *File   `json:"file"`
}

// NaN and the infinities parsed, and no JSON can carry them: the handler's
// own echo of the value failed as a 500 (found by hunt 3)
func TestAMultipartFloatIsFinite(t *testing.T) {
	for _, s := range []string{"NaN", "Infinity", "-Inf", "+inf", "1e400"} {
		_, err := BindMultipart[priced](multipartRequest([][2]string{{"price", s}}, [][2]string{{"file", "a.png"}}))
		if err == nil || bindErrorStatus(err) != http.StatusBadRequest {
			t.Errorf("%q: %v, want a 400", s, err)
		}
	}
	if v, err := BindMultipart[priced](multipartRequest([][2]string{{"price", "-1.5e3"}}, nil)); err != nil || v.Price != -1500 {
		t.Errorf("a finite number: %v %v", v.Price, err)
	}
}

type noteInner struct{ Note string }
type embedsUnexportedPointer struct {
	*noteInner
	File File `json:"file"`
}

// a nil embedded pointer to an unexported struct cannot be allocated by
// reflection: a request carrying its field was a panic (found by hunt 3)
func TestAnUnsettableEmbeddedFieldIsRefusedNotAPanic(t *testing.T) {
	_, err := BindMultipart[embedsUnexportedPointer](multipartRequest([][2]string{{"Note", "x"}}, [][2]string{{"file", "a.png"}}))
	if err == nil || bindErrorStatus(err) != http.StatusBadRequest || !strings.Contains(err.Error(), "Note") {
		t.Fatalf("%v (status %d), want a 400 naming the field", err, bindErrorStatus(err))
	}
	if _, err := BindMultipart[embedsUnexportedPointer](multipartRequest(nil, [][2]string{{"file", "a.png"}})); err != nil {
		t.Fatalf("without the field: %v", err)
	}
}

// an entry no sniff ever reports refused every genuine file in silence
// (found by hunt 3): the first upload says so, once per entry
func TestAnUnsniffableUploadTypeIsNamed(t *testing.T) {
	var logs bytes.Buffer
	log.SetOutput(&logs)
	defer log.SetOutput(os.Stderr)
	u := Uploads{Dir: t.TempDir(), Types: []string{"image/PNG", "image/svg+xml", "Text/CSV"}}
	for i := 0; i < 2; i++ {
		u.save(strings.NewReader("<svg xmlns='http://www.w3.org/2000/svg'/>"), "a.svg")
	}
	out := logs.String()
	if !strings.Contains(out, `"image/svg+xml"`) || !strings.Contains(out, `"Text/CSV"`) || strings.Contains(out, "image/PNG") {
		t.Fatalf("logs: %q", out)
	}
	if strings.Count(out, "image/svg+xml") != 1 {
		t.Errorf("said more than once: %q", out)
	}
}
