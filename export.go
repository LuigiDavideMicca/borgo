package borgo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"runtime/debug"
	"strings"
)

// //borgo:export - the bridge from TypeScript to Go.
//
//	//borgo:export
//	func Membership(ctx context.Context, userID int64, slug string) (*Member, error)
//
// borgogen generates, for each such function, a typed adapter registered with
// Export in borgo.gen.go, and a typed stub in .borgo/go.ts; middleware.ts and
// loaders then write `await go.membership(userId, slug)`.
//
// An export is not a route. It is answered only on the internal listener, the
// one that already refuses any request without this boot's key, at
// /__borgo/export/<Name>; on the public port every /__borgo/ name is a 404.
// It is outside the app's middleware on purpose: that middleware judges
// browsers by their cookies, and the caller here is the render service,
// authenticated by the key - the function receives what it needs to decide as
// arguments, and decides.
//
// An app with no render service (an api served alone) has no internal
// listener and nobody to call its exports: they are registered and unmounted.

// ExportHandler is what borgogen generates for one //borgo:export function:
// it decodes the positional arguments into the function's own parameter
// types and calls it. Not for hand-written code.
type ExportHandler func(ctx context.Context, args []json.RawMessage) (any, error)

var (
	// guarded by routesMu, latched by served like the routes
	exports      = map[string]ExportHandler{}
	exportNameRe = regexp.MustCompile(`^[A-Z][A-Za-z0-9_]*$`)
)

const (
	exportPrefix = "/__borgo/export/"
	// positional arguments of a function call, not an upload
	maxExportBody = 8 << 20
)

// Export registers a //borgo:export adapter under the Go function's name.
// borgogen generates the call; an app does not write it.
func Export(name string, h ExportHandler) {
	if !exportNameRe.MatchString(name) {
		panic(fmt.Sprintf("borgo.Export: %q is not the name of an exported Go function", name))
	}
	if h == nil {
		panic("borgo.Export: nil handler for " + name)
	}
	routesMu.Lock()
	defer routesMu.Unlock()
	if served {
		panic("borgo.Export: " + name + " registered after borgo.Serve: the internal listener is already mounted; register in init()")
	}
	if _, dup := exports[name]; dup {
		panic("borgo.Export: " + name + " registered twice")
	}
	exports[name] = h
}

// exportCallError is a call that could not be made: the arguments do not fit
// the function. It means the generated .borgo/go.ts and the running binary
// disagree - a stale build - and it is answered 400, apart from an error the
// function itself returned.
type exportCallError struct{ msg string }

func (e exportCallError) Error() string { return e.msg }

// ExportArity is returned by a generated adapter handed the wrong number of
// arguments. Not for hand-written code.
func ExportArity(name string, want, got int) error {
	return exportCallError{fmt.Sprintf("%s takes %d arguments, the call passed %d: .borgo/go.ts and the running binary disagree, run borgogen and rebuild", name, want, got)}
}

// ExportArgument is returned by a generated adapter whose argument does not
// decode into its parameter. Not for hand-written code.
func ExportArgument(name string, index int, err error) error {
	return exportCallError{fmt.Sprintf("%s: argument %d does not fit its parameter (%v)", name, index+1, err)}
}

type exportAnswer struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

func writeExportAnswer(w http.ResponseWriter, status int, answer exportAnswer) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(answer)
}

// withExports answers the registered exports and hands every other request to
// next. The table is copied when the listener is built, after the registry
// was latched, so nothing can change under a request.
func withExports(next http.Handler) http.Handler {
	routesMu.Lock()
	table := make(map[string]ExportHandler, len(exports))
	for name, h := range exports {
		table[name] = h
	}
	routesMu.Unlock()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, exportPrefix) {
			next.ServeHTTP(w, r)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, exportPrefix)
		h, ok := table[name]
		if !ok {
			writeExportAnswer(w, http.StatusNotFound, exportAnswer{Error: fmt.Sprintf("no export named %q: run borgogen and rebuild", name)})
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeExportAnswer(w, http.StatusMethodNotAllowed, exportAnswer{Error: "an export is called with POST"})
			return
		}
		var args []json.RawMessage
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxExportBody)).Decode(&args); err != nil {
			writeExportAnswer(w, http.StatusBadRequest, exportAnswer{Error: fmt.Sprintf("%s: the arguments are not a json array (%v)", name, err)})
			return
		}
		status, answer := callExport(r.Context(), name, h, args)
		writeExportAnswer(w, status, answer)
	})
}

// callExport runs one call. The function's own error is an answer, 200, which
// the TypeScript side raises as a GoError with the message: a lookup that
// found nothing is not a server fault. A panic is contained, logged with its
// stack, and raised the same way with status 500 - never a process gone.
func callExport(ctx context.Context, name string, h ExportHandler, args []json.RawMessage) (status int, answer exportAnswer) {
	defer func() {
		if p := recover(); p != nil {
			log.Printf("borgo: export %s panicked: %v\n%s", name, p, debug.Stack())
			status, answer = http.StatusInternalServerError, exportAnswer{Error: name + " panicked; the stack is in the go log"}
		}
	}()
	result, err := h(ctx, args)
	if err != nil {
		var callErr exportCallError
		if errors.As(err, &callErr) {
			return http.StatusBadRequest, exportAnswer{Error: callErr.msg}
		}
		return http.StatusOK, exportAnswer{Error: err.Error()}
	}
	raw, err := json.Marshal(result)
	if err != nil {
		log.Printf("borgo: export %s returned a value that does not encode as json: %v", name, err)
		return http.StatusInternalServerError, exportAnswer{Error: name + " returned a value that does not encode as json"}
	}
	return http.StatusOK, exportAnswer{Result: raw}
}
