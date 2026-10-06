package borgo

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
)

type attachment struct {
	Note    string   `json:"note"`
	Count   int      `json:"count"`
	Pinned  bool     `json:"pinned"`
	Ratio   float64  `json:"ratio"`
	Tags    []string `json:"tags"`
	File    File     `json:"file"`
	Cover   *File    `json:"cover"`
	Extras  []File   `json:"extras"`
	private string
	Skipped string `json:"-"`
	Plain   string
}

// a text part is (name, value); a file part also has a filename and a type
type part struct {
	name, filename, contentType, value string
}

func multipartBody(t *testing.T, parts ...part) (string, []byte) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for _, p := range parts {
		if p.filename == "" {
			if err := w.WriteField(p.name, p.value); err != nil {
				t.Fatal(err)
			}
			continue
		}
		h := textproto.MIMEHeader{}
		h.Set("Content-Disposition", `form-data; name="`+p.name+`"; filename="`+p.filename+`"`)
		h.Set("Content-Type", p.contentType)
		fw, err := w.CreatePart(h)
		if err != nil {
			t.Fatal(err)
		}
		io.WriteString(fw, p.value)
	}
	w.Close()
	return w.FormDataContentType(), buf.Bytes()
}

func bindMultipartRequest[T any](t *testing.T, contentType string, body []byte, limit int64) (T, error) {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	r.Header.Set("Content-Type", contentType)
	if limit != 0 {
		return BindMultipartMax[T](r, limit)
	}
	return BindMultipart[T](r)
}

func TestBindMultipartFillsTextAndFiles(t *testing.T) {
	ct, body := multipartBody(t,
		part{name: "note", value: "hello"},
		part{name: "count", value: "3"},
		part{name: "pinned", value: "true"},
		part{name: "ratio", value: "0.5"},
		part{name: "tags", value: "a"},
		part{name: "tags", value: "b"},
		part{name: "file", filename: "shot.png", contentType: "image/png", value: "PNGBYTES"},
		// a second file under a one-file field: the first one sent wins
		part{name: "file", filename: "second.png", contentType: "image/png", value: "LATER"},
		part{name: "cover", filename: "c.jpg", contentType: "image/jpeg", value: "JPG"},
		part{name: "extras", filename: "1.txt", contentType: "text/plain", value: "one"},
		part{name: "extras", filename: "2.txt", contentType: "text/plain", value: "two"},
		part{name: "private", value: "x"},
		part{name: "Skipped", value: "x"},
		// json:"-" names no part at all, not a part called "-"
		part{name: "-", value: "x"},
		part{name: "Plain", value: "untagged"},
		part{name: "unknown", value: "ignored"},
	)
	a, err := bindMultipartRequest[attachment](t, ct, body, 0)
	if err != nil {
		t.Fatal(err)
	}
	if a.Note != "hello" || a.Count != 3 || !a.Pinned || a.Ratio != 0.5 || strings.Join(a.Tags, ",") != "a,b" || a.Plain != "untagged" {
		t.Errorf("text parts: %+v", a)
	}
	if a.File.Name != "shot.png" || a.File.ContentType != "image/png" || a.File.Size != 8 {
		t.Errorf("file: %+v", a.File)
	}
	rc, err := a.File.Open()
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != "PNGBYTES" {
		t.Errorf("file bytes %q", got)
	}
	if a.Cover == nil || a.Cover.Name != "c.jpg" {
		t.Errorf("cover: %+v", a.Cover)
	}
	if len(a.Extras) != 2 || a.Extras[0].Name != "1.txt" || a.Extras[1].Name != "2.txt" {
		t.Errorf("extras: %+v", a.Extras)
	}
	if a.private != "" || a.Skipped != "" {
		t.Errorf("a part the struct does not expose was filled: %+v", a)
	}
}

// what the form did not send keeps its zero, as Bind's decoder leaves it
func TestBindMultipartLeavesWhatWasNotSent(t *testing.T) {
	ct, body := multipartBody(t, part{name: "note", value: "only"})
	a, err := bindMultipartRequest[attachment](t, ct, body, 0)
	if err != nil {
		t.Fatal(err)
	}
	if a.Note != "only" || a.Count != 0 || a.Cover != nil || a.Extras != nil || a.Tags != nil || a.File.Name != "" {
		t.Errorf("%+v", a)
	}
	if _, err := a.File.Open(); err == nil {
		t.Error("opening a file that was not sent must fail")
	}
	if _, err := a.Cover.Open(); err == nil {
		t.Error("opening a nil *File must fail, not panic")
	}
}

// an embedded struct's fields are the form's, as encoding/json flattens them
func TestBindMultipartFlattensAnEmbeddedStruct(t *testing.T) {
	type meta struct {
		Title string `json:"title"`
	}
	type form struct {
		meta
		Doc File `json:"doc"`
	}
	ct, body := multipartBody(t, part{name: "title", value: "t"}, part{name: "doc", filename: "d.pdf", contentType: "application/pdf", value: "%PDF"})
	f, err := bindMultipartRequest[form](t, ct, body, 0)
	if err != nil {
		t.Fatal(err)
	}
	if f.Title != "t" || f.Doc.Name != "d.pdf" {
		t.Errorf("%+v", f)
	}
}
