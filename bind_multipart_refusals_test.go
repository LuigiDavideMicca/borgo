package borgo

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func bindStatus(err error) int {
	w := httptest.NewRecorder()
	BindError(w, err)
	return w.Code
}

// a text part that does not parse as its field is the client's mistake: 400,
// naming the field and, for a number, the width it overflowed
func TestBindMultipartRefusesATextPartOfTheWrongType(t *testing.T) {
	type sized struct {
		Small int8    `json:"small"`
		N     uint8   `json:"n"`
		F     float32 `json:"f"`
	}
	for _, tc := range []struct {
		name, value, want string
	}{
		{"count", "three", `field "count": "three" is not an integer`},
		{"pinned", "yes", `field "pinned": "yes" is not a boolean`},
		{"ratio", "half", `field "ratio": "half" is not a number`},
	} {
		ct, body := multipartBody(t, part{name: tc.name, value: tc.value})
		_, err := bindMultipartRequest[attachment](t, ct, body, 0)
		if err == nil || !strings.Contains(err.Error(), tc.want) || bindStatus(err) != http.StatusBadRequest {
			t.Errorf("%s=%s: %v", tc.name, tc.value, err)
		}
	}
	for _, tc := range []struct{ name, value string }{{"small", "300"}, {"n", "300"}, {"f", "1e300"}} {
		ct, body := multipartBody(t, part{name: tc.name, value: tc.value})
		if _, err := bindMultipartRequest[sized](t, ct, body, 0); err == nil || !strings.Contains(err.Error(), "bits") {
			t.Errorf("%s=%s overflowed its width and was accepted: %v", tc.name, tc.value, err)
		}
	}
	// a repeated part fills a scalar with the first
	ct, body := multipartBody(t, part{name: "note", value: "first"}, part{name: "note", value: "second"})
	if a, err := bindMultipartRequest[attachment](t, ct, body, 0); err != nil || a.Note != "first" {
		t.Errorf("repeated scalar: %q %v", a.Note, err)
	}
	// text sent under a file's name is not a file, and not a mistake either:
	// the file fields stay zero, as a file under a text field's name leaves
	// the text field alone
	ct, body = multipartBody(t,
		part{name: "file", value: "not a file"},
		part{name: "extras", value: "nor this"},
		part{name: "note", filename: "n.txt", contentType: "text/plain", value: "a file"},
	)
	if a, err := bindMultipartRequest[attachment](t, ct, body, 0); err != nil || a.File.Name != "" || a.Extras != nil || a.Note != "" {
		t.Errorf("crossed parts: %+v %v", a, err)
	}
	// a broken multipart body is a 400, not a panic
	_, err := bindMultipartRequest[attachment](t, "multipart/form-data; boundary=zzz", []byte("--zzz\r\nnot a part"), 0)
	if err == nil || bindStatus(err) != http.StatusBadRequest {
		t.Errorf("a broken body: %v", err)
	}
}

// the wire the client picks for a form with no file in it is JSON: read it,
// and drop whatever it says about a file - a file only arrives as a part
// (the verifier of the step found an optional file answered 415)
func TestBindMultipartReadsAFormWithNoFileSentAsJSON(t *testing.T) {
	body := []byte(`{"note":"text only","count":2,"tags":["a"],"file":{"Name":"forged","Size":99},"cover":null,"extras":[{"Name":"x"}]}`)
	a, err := bindMultipartRequest[attachment](t, "application/json", body, 0)
	if err != nil {
		t.Fatal(err)
	}
	if a.Note != "text only" || a.Count != 2 || len(a.Tags) != 1 {
		t.Errorf("the text fields: %+v", a)
	}
	if a.File != (File{}) || a.Cover != nil || a.Extras != nil {
		t.Errorf("a file arrived as JSON: %+v %+v %+v", a.File, a.Cover, a.Extras)
	}
	if _, err := a.File.Open(); err == nil {
		t.Error("a file named in JSON opened")
	}
	// the JSON side keeps Bind's own refusals
	if _, err := bindMultipartRequest[attachment](t, "application/json", []byte(`{"note":`), 0); err == nil || bindStatus(err) != http.StatusBadRequest {
		t.Errorf("broken json: %v", err)
	}
	if _, err := bindMultipartRequest[attachment](t, "application/json", []byte(`{"note":"`+strings.Repeat("x", 64)+`"}`), 16); err == nil || bindStatus(err) != http.StatusRequestEntityTooLarge {
		t.Errorf("json over the limit: %v", err)
	}
	// another content type, and none: 415, with the message saying which
	for _, contentType := range []string{"text/plain", "", "multipart/mixed; boundary=x"} {
		_, err := bindMultipartRequest[attachment](t, contentType, []byte(`x`), 0)
		if err == nil || bindStatus(err) != http.StatusUnsupportedMediaType || !strings.Contains(err.Error(), "multipart/form-data") {
			t.Errorf("Content-Type %q: %v", contentType, err)
		}
	}
}

// the limits: the cap, exactly; the default cap; and the parser's own, which
// are 413 too and not a 400 that reads like a malformed form
func TestBindMultipartLimits(t *testing.T) {
	ct, body := multipartBody(t, part{name: "file", filename: "f.bin", contentType: "application/octet-stream", value: strings.Repeat("x", 2048)})
	limit := int64(len(body))
	if _, err := bindMultipartRequest[attachment](t, ct, body, limit); err != nil {
		t.Errorf("a body of exactly the limit: %v", err)
	}
	if _, err := bindMultipartRequest[attachment](t, ct, body, limit-1); bindStatus(err) != http.StatusRequestEntityTooLarge {
		t.Errorf("one byte over the limit: %v", err)
	}
	// the default cap is 32 MiB
	ct, body = multipartBody(t, part{name: "file", filename: "big.bin", contentType: "application/octet-stream", value: strings.Repeat("x", 32<<20)})
	if _, err := bindMultipartRequest[attachment](t, ct, body, 0); bindStatus(err) != http.StatusRequestEntityTooLarge {
		t.Errorf("over the default 32 MiB: %v", err)
	}
	// text is held in memory: 8 MiB of ours plus the parser's 10 take a
	// 17 MiB part and refuse a 20 MiB one, as too large
	ct, body = multipartBody(t, part{name: "note", value: strings.Repeat("x", 17<<20)})
	if _, err := bindMultipartRequest[attachment](t, ct, body, 0); err != nil {
		t.Errorf("a 17 MiB text part: %v", err)
	}
	ct, body = multipartBody(t, part{name: "note", value: strings.Repeat("x", 20<<20)})
	if _, err := bindMultipartRequest[attachment](t, ct, body, 0); bindStatus(err) != http.StatusRequestEntityTooLarge {
		t.Errorf("a 20 MiB text part: %v", err)
	}
	// more parts than the parser takes
	parts := make([]part, 1001)
	for i := range parts {
		parts[i] = part{name: "tags", value: "t"}
	}
	ct, body = multipartBody(t, parts...)
	if _, err := bindMultipartRequest[attachment](t, ct, body, 0); bindStatus(err) != http.StatusRequestEntityTooLarge {
		t.Errorf("1001 parts: %v", err)
	}
}

// a T no part can fill is the app's mistake: refused on every request, sent
// or not, 500 with the field named in the log and nothing about the type
// told to the client
func TestBindMultipartRefusesAFormItCannotFill(t *testing.T) {
	type Nested struct{ X string }
	type tagged struct {
		Meta Nested `json:"meta"`
	}
	// exported: an unexported embedded struct with a tag is skipped, as
	// encoding/json skips it
	type embedsTagged struct {
		Nested `json:"inner"`
	}
	type embedsFile struct {
		File
		Note string `json:"note"`
	}
	// a tag and a Go name meeting on one name
	type twins struct {
		A    string `json:"Same"`
		Same string
	}
	type ints struct {
		N []int `json:"n"`
	}
	type pointer struct {
		P *int `json:"p"`
	}
	type mapped struct {
		M map[string]int `json:"m"`
	}
	var logged bytes.Buffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)
	ct, body := multipartBody(t, part{name: "unrelated", value: "x"})
	for name, bind := range map[string]func() error{
		"a nested struct":          func() error { _, err := bindMultipartRequest[tagged](t, ct, body, 0); return err },
		"a tagged embedded struct": func() error { _, err := bindMultipartRequest[embedsTagged](t, ct, body, 0); return err },
		"an embedded File":         func() error { _, err := bindMultipartRequest[embedsFile](t, ct, body, 0); return err },
		"two fields with one name": func() error { _, err := bindMultipartRequest[twins](t, ct, body, 0); return err },
		"a slice of ints":          func() error { _, err := bindMultipartRequest[ints](t, ct, body, 0); return err },
		"a pointer to a scalar":    func() error { _, err := bindMultipartRequest[pointer](t, ct, body, 0); return err },
		"a map":                    func() error { _, err := bindMultipartRequest[mapped](t, ct, body, 0); return err },
		"not a struct":             func() error { _, err := bindMultipartRequest[int](t, ct, body, 0); return err },
		"a JSON body to a bad shape": func() error {
			_, err := bindMultipartRequest[mapped](t, "application/json", []byte(`{}`), 0)
			return err
		},
	} {
		err := bind()
		w := httptest.NewRecorder()
		BindError(w, err)
		if err == nil || w.Code != http.StatusInternalServerError || strings.Contains(w.Body.String(), "borgo.BindMultipart") {
			t.Errorf("%s: %d %q (%v)", name, w.Code, w.Body.String(), err)
		}
	}
	if !strings.Contains(logged.String(), `field "m" has type map[string]int`) || !strings.Contains(logged.String(), `two fields answering "Same"`) {
		t.Errorf("the log does not name the field:\n%s", logged.String())
	}
}

// names as encoding/json gives them: an embedded pointer to a struct is
// flattened and allocated only when filled, json:"-," names the field "-",
// a file behind an embedded pointer, on the JSON wire: zeroed when JSON
// allocated the pointer, and no panic when it left it nil (found by the
// verifier of phase 5)
func TestBindMultipartJSONZeroesAFileBehindAnEmbeddedPointer(t *testing.T) {
	type Scan struct {
		Doc File `json:"doc"`
	}
	type form struct {
		*Scan
		Note string `json:"note"`
	}
	f, err := bindMultipartRequest[form](t, "application/json", []byte(`{"note":"n"}`), 0)
	if err != nil || f.Scan != nil || f.Note != "n" {
		t.Errorf("nil: %+v %v", f, err)
	}
	f, err = bindMultipartRequest[form](t, "application/json", []byte(`{"doc":{"Name":"forged","Size":9}}`), 0)
	if err != nil || f.Scan == nil || f.Doc != (File{}) {
		t.Errorf("allocated: %+v %v", f, err)
	}
}

// an unexported embedded struct gives up its exported fields
func TestBindMultipartNamesFieldsAsJSONDoes(t *testing.T) {
	type Inner struct {
		Deep string `json:"deep"`
	}
	type other struct {
		Shallow string `json:"shallow"`
	}
	type form struct {
		*Inner
		other
		Dash string `json:"-,"`
		Doc  File   `json:"doc"`
	}
	ct, body := multipartBody(t, part{name: "deep", value: "d"}, part{name: "shallow", value: "s"}, part{name: "-", value: "dash"})
	f, err := bindMultipartRequest[form](t, ct, body, 0)
	if err != nil {
		t.Fatal(err)
	}
	if f.Inner == nil || f.Deep != "d" || f.Shallow != "s" || f.Dash != "dash" {
		t.Errorf("%+v", f)
	}
	ct, body = multipartBody(t, part{name: "shallow", value: "s"})
	if f, err := bindMultipartRequest[form](t, ct, body, 0); err != nil || f.Inner != nil {
		t.Errorf("an embedded pointer allocated with nothing to fill: %+v %v", f, err)
	}
	// and the JSON wire leaves a nil embedded pointer nil
	if f, err := bindMultipartRequest[form](t, "application/json", []byte(`{"shallow":"s"}`), 0); err != nil || f.Inner != nil || f.Shallow != "s" {
		t.Errorf("json: %+v %v", f, err)
	}
}

// a temp dir the server cannot write is the server's failure, answered 500
// with the path in the log and not in the body
func TestBindMultipartAnUnwritableTempDirIsTheServers(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "gone")
	for _, k := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(k, missing)
	}
	type form struct {
		Doc File `json:"doc"`
	}
	var logged bytes.Buffer
	log.SetOutput(&logged)
	defer log.SetOutput(os.Stderr)
	ct, body := multipartBody(t, part{name: "doc", filename: "big.bin", contentType: "application/octet-stream", value: strings.Repeat("x", 9<<20)})
	_, err := bindMultipartRequest[form](t, ct, body, 64<<20)
	w := httptest.NewRecorder()
	BindError(w, err)
	if w.Code != http.StatusInternalServerError || strings.Contains(w.Body.String(), "gone") {
		t.Errorf("answered %d %s", w.Code, w.Body)
	}
	if !strings.Contains(logged.String(), "gone") {
		t.Errorf("the log does not name the path: %q", logged.String())
	}
}

// the files a request spilled to disk are the server's to remove, after the
// handler returns: Open works during it and not after
func TestBindMultipartFilesLiveAsLongAsTheHandler(t *testing.T) {
	type form struct {
		Doc File `json:"doc"`
	}
	type spilled struct {
		doc  File
		path string
	}
	kept := make(chan spilled, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f, err := BindMultipartMax[form](r, 64<<20)
		if err != nil {
			BindError(w, err)
			return
		}
		rc, err := f.Doc.Open()
		if err != nil {
			t.Errorf("open in the handler: %v", err)
			return
		}
		io.Copy(io.Discard, rc)
		file, ok := rc.(*os.File)
		rc.Close()
		if !ok {
			t.Error("a 9 MiB part was not spilled to a file")
			kept <- spilled{}
			return
		}
		kept <- spilled{f.Doc, file.Name()}
	}))
	defer srv.Close()
	// over the in-memory threshold, so it is spilled to a temporary file
	ct, body := multipartBody(t, part{name: "doc", filename: "big.bin", contentType: "application/octet-stream", value: strings.Repeat("x", 9<<20)})
	res, err := http.Post(srv.URL, ct, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("answered %d", res.StatusCode)
	}
	// net/http removes the spilled files after the handler returns, which
	// can be just after the client has its response: wait for it, bounded,
	// looking without opening - on windows an open handle is what stops a
	// removal, and net/http does not try twice
	got := <-kept
	waitFor(t, func() bool {
		_, err := os.Stat(got.path)
		return errors.Is(err, fs.ErrNotExist)
	}, "the spilled file removed once its handler returned")
	if rc, err := got.doc.Open(); err == nil {
		rc.Close()
		t.Error("a spilled file opened after its handler returned")
	}
}
