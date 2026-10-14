package borgo

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"sync"
)

// File is one part of a multipart form that carried a file, as a field of
// the struct BindMultipart decodes into. Name and ContentType are what the
// client said, which is not evidence: a name is a path traversal waiting to
// happen and a type is a claim, so store under a name of your own and sniff
// the bytes before trusting either.
type File struct {
	Name        string
	ContentType string
	Size        int64
	header      *multipart.FileHeader
}

// Open reads the file's bytes, from memory or from the temporary file the
// server spilled it to. The temporary files are removed when the handler
// returns, so copy what must outlive the request.
func (f *File) Open() (io.ReadCloser, error) {
	if f == nil || f.header == nil {
		return nil, ErrNoUpload
	}
	return f.header.Open()
}

const (
	// what BindMultipart reads at most, BindMultipartMax to change it: a
	// screenshot is a few megabytes, a form of them a few more. The public
	// port's BORGO_MAX_BODY is the same number by default, so a route that
	// raises this raises that too
	multipartLimit = 32 << 20
	// files past this are spilled to disk by the parser rather than held;
	// text parts are held, up to this plus the parser's own 10 MiB
	multipartMemory = 8 << 20
)

var errMultipartContentType = errors.New("Content-Type must be multipart/form-data, or application/json for a form that carries no file")

// multipartTypeError is a T BindMultipart cannot decode into: the app's
// mistake, not the client's, so BindError answers it 500 and logs it,
// whatever the request carried
type multipartTypeError struct{ msg string }

func (e *multipartTypeError) Error() string { return e.msg }

// BindMultipart decodes a multipart/form-data body into a struct: text parts
// into fields by their json name (string, bool, integers, floats, and
// []string for a repeated part), files into File, *File or []File. It is
// what Bind is for JSON, for a form with a file in it, and the typed bridge
// reads T as the route's request type with the files as Blobs, so the
// client sends a FormData when the body holds a file.
//
// When it holds none - an optional file the user did not pick - the client
// sends JSON, and BindMultipart reads that too, with every File left zero:
// a file only ever arrives as a part. A part the struct does not name is
// ignored; a field the form did not send keeps its zero value; the first of
// a repeated part fills a scalar; a text part that does not parse as its
// field's type is a 400. A field of a type no part can fill - a map, a
// nested struct, a time.Time, a *int, an embedded File - or two fields
// answering one name is the app's mistake: every request is refused 500,
// with the field named in the log. Names are matched exactly, as the typed
// client sends them.
//
// The body is read at most 32 MiB; BindError answers 413 over it, and over
// the parser's own limits (1000 parts, text parts beyond about 18 MiB held
// in memory), 415 for another Content-Type, 400 for the rest. The parsed
// form's temporary files are removed by the server when the handler returns.
func BindMultipart[T any](r *http.Request) (T, error) {
	return BindMultipartMax[T](r, multipartLimit)
}

// BindMultipartMax is BindMultipart with an explicit body size limit in
// bytes; limit <= 0 disables the cap.
func BindMultipartMax[T any](r *http.Request, limit int64) (T, error) {
	var v T
	rv := reflect.ValueOf(&v).Elem()
	if err := multipartShape(rv.Type()); err != nil {
		return v, err
	}
	ct, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err == nil && ct == "application/json" {
		// a form whose file was optional and absent: no part could carry a
		// file here, so whatever the body says about one is dropped
		v, err := BindMax[T](r, limit)
		zeroFiles(reflect.ValueOf(&v).Elem())
		return v, err
	}
	if err != nil || ct != "multipart/form-data" {
		return v, errMultipartContentType
	}
	if limit > 0 {
		r.Body = http.MaxBytesReader(nil, r.Body, limit)
	}
	if err := r.ParseMultipartForm(multipartMemory); err != nil {
		// wrapped, not replaced: BindError finds the *http.MaxBytesError of
		// an overflow, or the parser's ErrMessageTooLarge, inside it
		return v, fmt.Errorf("multipart form: %w", err)
	}
	if c, ok := r.Context().Value(formCleanupKey{}).(*formCleanup); ok {
		c.add(r.MultipartForm)
	}
	fields := multipartFields(rv.Type(), nil)
	for _, f := range fields {
		files := r.MultipartForm.File[f.name]
		if len(files) == 0 || !fileTypes[f.typ] {
			continue
		}
		field, err := fieldFor(rv, f.index, f.name)
		if err != nil {
			return v, err
		}
		switch f.typ {
		case fileType:
			field.Set(reflect.ValueOf(fileOf(files[0])))
		case reflect.PointerTo(fileType):
			file := fileOf(files[0])
			field.Set(reflect.ValueOf(&file))
		default:
			out := make([]File, 0, len(files))
			for _, h := range files {
				out = append(out, fileOf(h))
			}
			field.Set(reflect.ValueOf(out))
		}
	}
	for _, f := range fields {
		values, sent := r.MultipartForm.Value[f.name]
		if !sent || fileTypes[f.typ] {
			continue
		}
		field, err := fieldFor(rv, f.index, f.name)
		if err != nil {
			return v, err
		}
		if err := setTextField(field, f.name, values); err != nil {
			return v, err
		}
	}
	return v, nil
}

var (
	fileType  = reflect.TypeFor[File]()
	fileTypes = map[reflect.Type]bool{fileType: true, reflect.PointerTo(fileType): true, reflect.SliceOf(fileType): true}
	// a type's verdict, decided once: a nil error or a *multipartTypeError
	multipartShapes sync.Map
)

// multipartField is one field the form fills, reached through value and
// pointer embeddings as encoding/json reaches it
type multipartField struct {
	name  string
	index []int
	typ   reflect.Type
}

// multipartFields lists what a struct's form fills, flattening embedded
// structs as encoding/json does: an untagged embedded struct or pointer to
// one gives up its fields, a tagged one is a field of its own
func multipartFields(t reflect.Type, index []int) []multipartField {
	var out []multipartField
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		at := append(append([]int(nil), index...), i)
		name, tagged := jsonFieldName(f)
		if name == "" {
			continue
		}
		et := f.Type
		if et.Kind() == reflect.Pointer {
			et = et.Elem()
		}
		if f.Anonymous && !tagged && et.Kind() == reflect.Struct && et != fileType {
			out = append(out, multipartFields(et, at)...)
			continue
		}
		if !f.IsExported() {
			continue
		}
		out = append(out, multipartField{name: name, index: at, typ: f.Type})
	}
	return out
}

// jsonFieldName is the name encoding/json gives a field: "" for one it
// skips (json:"-"), "-" for json:"-,", the tag's name, or the Go name
func jsonFieldName(f reflect.StructField) (name string, tagged bool) {
	tag := f.Tag.Get("json")
	if tag == "-" {
		return "", true
	}
	name, _, _ = strings.Cut(tag, ",")
	if name == "" {
		return f.Name, false
	}
	return name, true
}

// multipartShape refuses, once per type, a T the form cannot fill
func multipartShape(t reflect.Type) error {
	if verdict, ok := multipartShapes.Load(t); ok {
		err, _ := verdict.(error)
		return err
	}
	err := checkMultipartShape(t)
	if err == nil {
		multipartShapes.Store(t, false)
		return nil
	}
	multipartShapes.Store(t, err)
	return err
}

func checkMultipartShape(t reflect.Type) error {
	if t.Kind() != reflect.Struct {
		return &multipartTypeError{fmt.Sprintf("borgo.BindMultipart: %s is not a struct", t)}
	}
	if embedsFile(t) {
		return &multipartTypeError{fmt.Sprintf("borgo.BindMultipart: %s embeds borgo.File; a file is a field of its own, named by its json tag", t)}
	}
	seen := map[string]bool{}
	for _, f := range multipartFields(t, nil) {
		if seen[f.name] {
			return &multipartTypeError{fmt.Sprintf("borgo.BindMultipart: %s has two fields answering %q; give each its own json name", t, f.name)}
		}
		seen[f.name] = true
		if fileTypes[f.typ] || textKind(f.typ) || f.typ.Kind() == reflect.Slice && f.typ.Elem().Kind() == reflect.String {
			continue
		}
		return &multipartTypeError{fmt.Sprintf("borgo.BindMultipart: %s field %q has type %s, which a form part cannot fill (string, bool, integers, floats, []string, File, *File or []File)", t, f.name, f.typ)}
	}
	return nil
}

func embedsFile(t reflect.Type) bool {
	for i := 0; i < t.NumField(); i++ {
		if f := t.Field(i); f.Anonymous && (f.Type == fileType || f.Type == reflect.PointerTo(fileType)) {
			return true
		}
	}
	return false
}

func textKind(t reflect.Type) bool {
	switch t.Kind() {
	case reflect.String, reflect.Bool,
		reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return true
	}
	return false
}

// fieldFor reaches a field through its embeddings, allocating an embedded
// pointer on the way: only called when something is about to be set. A nil
// pointer to an unexported struct cannot be allocated from here, and the
// request carrying its field is refused as encoding/json refuses it - it
// was a panic (found by hunt 3)
func fieldFor(rv reflect.Value, index []int, name string) (reflect.Value, error) {
	for i, at := range index {
		if i > 0 && rv.Kind() == reflect.Pointer {
			if rv.IsNil() {
				if !rv.CanSet() {
					return reflect.Value{}, fmt.Errorf("multipart form: field %q is reached through an embedded pointer to an unexported struct, which cannot be set", name)
				}
				rv.Set(reflect.New(rv.Type().Elem()))
			}
			rv = rv.Elem()
		}
		rv = rv.Field(at)
	}
	return rv, nil
}

// zeroFiles clears every file field of a value decoded from JSON: a file
// never arrives that way, whatever the body claims about one
// jsonReads is encoding/json's rule for which fields it reads: exported
// ones, and an unexported embedded struct (or pointer to one) for the
// exported fields it promotes; never one tagged "-"
func jsonReads(f reflect.StructField) bool {
	if f.Tag.Get("json") == "-" {
		return false
	}
	if f.IsExported() {
		return true
	}
	if !f.Anonymous {
		return false
	}
	t := f.Type
	if t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t.Kind() == reflect.Struct
}

// holdsFile reports whether a File is reachable from t through what
// encoding/json reads: exported or embedded fields not tagged "-", pointers,
// slices, arrays and map values.
func holdsFile(t reflect.Type, seen map[reflect.Type]bool) bool {
	if t == fileType {
		return true
	}
	if seen[t] {
		return false
	}
	seen[t] = true
	switch t.Kind() {
	case reflect.Pointer, reflect.Slice, reflect.Array, reflect.Map:
		return holdsFile(t.Elem(), seen)
	case reflect.Struct:
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			if !jsonReads(f) {
				continue
			}
			if holdsFile(f.Type, seen) {
				return true
			}
		}
	}
	return false
}

func zeroFiles(rv reflect.Value) {
	for _, f := range multipartFields(rv.Type(), nil) {
		if !fileTypes[f.typ] {
			continue
		}
		v := rv
		for i, at := range f.index {
			if i > 0 && v.Kind() == reflect.Pointer {
				if v.IsNil() {
					break
				}
				v = v.Elem()
			}
			v = v.Field(at)
		}
		if v.Type() == f.typ {
			v.Set(reflect.Zero(f.typ))
		}
	}
}

func fileOf(h *multipart.FileHeader) File {
	return File{Name: h.Filename, ContentType: h.Header.Get("Content-Type"), Size: h.Size, header: h}
}

func setTextField(field reflect.Value, name string, values []string) error {
	if field.Kind() == reflect.Slice {
		out := reflect.MakeSlice(field.Type(), len(values), len(values))
		for i, s := range values {
			out.Index(i).SetString(s)
		}
		field.Set(out)
		return nil
	}
	value := values[0]
	switch field.Kind() {
	case reflect.String:
		field.SetString(value)
	case reflect.Bool:
		b, err := strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("multipart form: field %q: %q is not a boolean", name, value)
		}
		field.SetBool(b)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n, err := strconv.ParseInt(value, 10, field.Type().Bits())
		if err != nil {
			return fmt.Errorf("multipart form: field %q: %q is not an integer of %d bits", name, value, field.Type().Bits())
		}
		field.SetInt(n)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		n, err := strconv.ParseUint(value, 10, field.Type().Bits())
		if err != nil {
			return fmt.Errorf("multipart form: field %q: %q is not a non-negative integer of %d bits", name, value, field.Type().Bits())
		}
		field.SetUint(n)
	default: // floats: the shape check admitted nothing else
		n, err := strconv.ParseFloat(value, field.Type().Bits())
		// NaN and the infinities parse, and no JSON can carry them: the
		// handler's own echo of the value failed as a 500 (found by hunt 3)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			return fmt.Errorf("multipart form: field %q: %q is not a number of %d bits", name, value, field.Type().Bits())
		}
		field.SetFloat(n)
	}
	return nil
}

// bindErrorStatus is BindError's verdict on an error from Bind or
// BindMultipart
func bindErrorStatus(err error) int {
	var tooLarge *http.MaxBytesError
	var shape *multipartTypeError
	var disk *fs.PathError
	switch {
	case errors.As(err, &shape):
		log.Printf("borgo: %v", err)
		return http.StatusInternalServerError
	case errors.As(err, &disk):
		// a file spilled past the memory threshold could not be written: the
		// server's disk, not the client's form, and its path is not theirs
		// to read (found by the verifier of phase 5)
		log.Printf("borgo: storing an upload: %v", err)
		return http.StatusInternalServerError
	case errors.As(err, &tooLarge), errors.Is(err, multipart.ErrMessageTooLarge):
		return http.StatusRequestEntityTooLarge
	case errors.Is(err, errContentType), errors.Is(err, errMultipartContentType):
		return http.StatusUnsupportedMediaType
	}
	return http.StatusBadRequest
}

// net/http removes a request's spilled upload files once the handler
// returns - for the request it made. Every layer of borgo's ports hands the
// handler a copy (WithContext), and the form was parsed onto the copy, so
// the files of every upload past 8 MiB stayed on disk forever: a signed-in
// user could fill it (found by hunt 3). The outermost layer of each port
// carries a collector the copies share through their context.
type formCleanupKey struct{}

type formCleanup struct {
	mu    sync.Mutex
	forms []*multipart.Form
}

func (c *formCleanup) add(f *multipart.Form) {
	if f == nil {
		return
	}
	c.mu.Lock()
	c.forms = append(c.forms, f)
	c.mu.Unlock()
}

func withFormCleanup(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := &formCleanup{}
		defer func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			for _, f := range c.forms {
				f.RemoveAll()
			}
		}()
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), formCleanupKey{}, c)))
	})
}
