// Package borgo is the go side of the borgo framework: a route registry and
// a server bootstrap. API files register their handlers in init() via Handle,
// and main calls Serve. The core imposes no database and no dependencies.
package borgo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"runtime"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Version is the version of the borgo module, matching the npm packages and
// the git tag of the same release - the two halves ship together and are
// always the same number. Report it in bug reports; borgo doctor prints the
// TypeScript half's.
//
// This line is bumped by hand, in the release PR, and it is the one version
// number in the repository that is. release-please resolves extra-files
// relative to a package's own path, so packages/borgo cannot reach a file at
// the repository root, and giving the root a package entry of its own would
// have it claim the same vX.Y.Z tag that packages/borgo already owns
// (include-component-in-tag: false) - a real risk taken for a one-line edit.
//
// Forgetting it is not quiet: TestVersionMatchesManifest reads
// .release-please-manifest.json and fails the build when the two disagree,
// naming the value it wanted.
const Version = "0.20.1"

var (
	// generated init() functions register on one goroutine, but nothing stops
	// an app from registering lazily: the lock keeps the map from tearing
	routesMu sync.Mutex
	routes   = map[string]http.HandlerFunc{}
	// Serve snapshots the registry into its mux once; a Handle call after that
	// would silently register a route that is never mounted, so it panics
	served    bool
	patternRe = regexp.MustCompile(`^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /\S*$`)
	// the mux is the authority on pattern syntax and conflicts (e.g.
	// "GET /x/{id}" vs "GET /x/{slug}"): registering eagerly moves the
	// panic from Serve to the offending Handle call
	patternCheck = http.NewServeMux()
)

// Handle registers a handler under a net/http method pattern,
// e.g. "GET /api/tasks" or "GET /api/tasks/{id}".
func Handle(pattern string, h http.HandlerFunc) {
	if !patternRe.MatchString(pattern) {
		panic(`borgo.Handle: pattern must be "METHOD /path", e.g. "GET /api/tasks" or "GET /api/tasks/{id}"; got "` + pattern + `"`)
	}
	if h == nil {
		panic(`borgo.Handle: nil handler for pattern "` + pattern + `"`)
	}
	routesMu.Lock()
	// unlocking on the way out of a panic keeps the registry usable for a
	// caller that recovers from a bad pattern
	defer routesMu.Unlock()
	if served {
		panic(`borgo.Handle: pattern "` + pattern + `" registered after borgo.Serve: the route table is already mounted, so this route would never be served; register in init() or before calling Serve`)
	}
	if _, dup := routes[pattern]; dup {
		panic(`borgo.Handle: pattern "` + pattern + `" registered twice; each route file must use a unique method + path`)
	}
	_, file, line, _ := runtime.Caller(1)
	validatePattern(pattern, file, line)
	routes[pattern] = h
}

func validatePattern(pattern, file string, line int) {
	defer func() {
		if r := recover(); r != nil {
			msg := fmt.Sprintf("borgo.Handle: invalid pattern %q: %v", pattern, r)
			if file != "" {
				msg += fmt.Sprintf(" (registered at %s:%d)", file, line)
			}
			panic(msg)
		}
	}()
	patternCheck.Handle(pattern, http.NotFoundHandler())
}

// WriteJSON writes v as a JSON response with the given status code.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	data, err := json.Marshal(v)
	if err != nil {
		// encode before committing the status: an unencodable value must be
		// a logged 500, not a 200 with a truncated body
		log.Printf("borgo: WriteJSON: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, `{"error":"response encoding failed"}`+"\n")
		return
	}
	data = append(data, '\n')
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(status)
	w.Write(data)
}

// JSON writes v as a JSON response with the given status code. Unlike
// WriteJSON its type parameter is visible to static analysis: borgogen reads
// T from every JSON call in a handler to type the route for TypeScript.
func JSON[T any](w http.ResponseWriter, status int, v T) {
	WriteJSON(w, status, v)
}

// bindLimit caps request bodies decoded by Bind at 1 MB, so a handler that
// expects a small JSON payload cannot be fed gigabytes.
const bindLimit = 1 << 20

// Bind decodes the request body as JSON into T, reading at most 1 MB - use
// BindMax for routes that legitimately take more. Its type parameter is
// visible to static analysis: borgogen reads T to type the route's request
// body for the TypeScript api client. On error, respond with BindError to
// get the right status (413 for an oversized body).
func Bind[T any](r *http.Request) (T, error) {
	return BindMax[T](r, bindLimit)
}

var errContentType = errors.New("Content-Type must be application/json")

// BindMax is Bind with an explicit body size limit in bytes; limit <= 0
// disables the cap.
func BindMax[T any](r *http.Request, limit int64) (T, error) {
	var v T
	// a browser form cannot send application/json - nor omit the header
	// entirely - so rejecting other declared types blocks cross-site form
	// posts while a bare curl or test request still binds
	if raw := r.Header.Get("Content-Type"); raw != "" {
		if ct, _, _ := mime.ParseMediaType(raw); ct != "application/json" {
			return v, errContentType
		}
	}
	body := r.Body
	if limit > 0 {
		// the nil writer means the server cannot mark the connection
		// close-after-reply on overflow: Bind's signature has no
		// ResponseWriter, so the excess bytes may be read and discarded
		body = http.MaxBytesReader(nil, r.Body, limit)
	}
	dec := json.NewDecoder(body)
	if err := dec.Decode(&v); err != nil {
		return v, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return v, errors.New("unexpected data after JSON body")
	}
	return v, nil
}

// BindError answers a Bind error: 413 when the body exceeded the limit,
// 415 for a non-JSON content type, 400 for anything else, as JSON.
func BindError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, errContentType):
		status = http.StatusUnsupportedMediaType
	}
	WriteJSON(w, status, map[string]string{"error": err.Error()})
}

// recoverMiddleware answers a panicking handler with a 500 instead of letting
// net/http drop the connection, which reaches the browser as an opaque network
// error. Nothing has reached the wire while the response is still buffered, so
// a handler that panicked half way through a small body gets the 500 too,
// rather than a truncated 200. Once bytes are committed - a streamed or
// compressed response past the buffer - the panic is only logged: appending to
// them would corrupt the response.
func recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rw := &recoverWriter{ResponseWriter: w}
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler {
				panic(v) // net/http's own signal to drop the response
			}
			log.Printf("borgo: panic serving %s %s: %v\n%s", r.Method, r.URL.Path, v, debug.Stack())
			if !rw.wrote {
				// the headers staged for the abandoned response belong to it,
				// not to this error: a Cache-Control from borgo.Cache would
				// have a cdn hold the 500 for everyone, and a session cookie
				// would hand out a login the request never completed
				clear(rw.Header())
				WriteJSON(rw, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
			}
		}()
		next.ServeHTTP(rw, r)
	})
}

// recoverWriter records whether the response was committed. It forwards Flush
// and Unwrap so streaming handlers and http.ResponseController still reach the
// real writer.
type recoverWriter struct {
	http.ResponseWriter
	wrote bool
}

func (w *recoverWriter) WriteHeader(status int) {
	// an informational 1xx leaves the response uncommitted: a handler that
	// panics right after sending early hints must still get its 500
	if status >= 100 && status < 200 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.wrote = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *recoverWriter) Write(p []byte) (int, error) {
	w.wrote = true
	return w.ResponseWriter.Write(p)
}

func (w *recoverWriter) Flush() {
	w.wrote = true
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *recoverWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

var startTime = time.Now()

// healthz answers the api's own liveness probe; the front server's /healthz
// aggregates it into the app-level view.
func healthz(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"uptime": time.Since(startTime).Seconds(),
	})
}

// envDuration reads a timeout override, e.g. BORGO_READ_HEADER_TIMEOUT=10s;
// "0" disables the timeout.
func envDuration(name string, def time.Duration) time.Duration {
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		panic(`borgo: ` + name + `: invalid duration "` + v + `" (want e.g. "5s"; "0" disables)`)
	}
	return d
}

// newServer configures the http server borgo.Serve runs. ReadHeaderTimeout
// caps slow-header (slowloris) clients; IdleTimeout reclaims kept-alive
// connections. Read and write timeouts stay 0 by design: they are wall-clock
// deadlines on the whole request, which would kill SSE streams and any
// long-lived response - body abuse is capped by Bind's 1 MB reader instead,
// and borgo.SSE clears the deadlines on its own connection in case an app
// sets BORGO_READ_TIMEOUT / BORGO_WRITE_TIMEOUT anyway.
func newServer(port string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: envDuration("BORGO_READ_HEADER_TIMEOUT", 5*time.Second),
		ReadTimeout:       envDuration("BORGO_READ_TIMEOUT", 0),
		WriteTimeout:      envDuration("BORGO_WRITE_TIMEOUT", 0),
		IdleTimeout:       envDuration("BORGO_IDLE_TIMEOUT", 2*time.Minute),
	}
}

// Serve mounts every registered route and listens on API_PORT (default 3501).
// It also answers GET /healthz, unless a registered route claims it. It blocks
// until the process is signalled, then shuts down gracefully; a listener that
// fails to start is fatal.
//
// Use ServeContext to get the error back instead of exiting - a test or a
// program that embeds the api needs to be able to stop the server and carry on.
func Serve() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// stop restores the default handlers the moment shutdown begins: a second
	// ctrl-c then kills a shutdown that is taking too long
	if err := serveContext(ctx, stop); err != nil {
		log.Fatal(err)
	}
}

// ServeContext is Serve that returns instead of exiting. It mounts every
// registered route, listens on API_PORT and blocks until ctx is cancelled or
// the parent process named by BORGO_PARENT_PID exits, then shuts the server
// down gracefully within BORGO_SHUTDOWN_TIMEOUT and returns nil. It returns
// the listener's error - a port already in use, most often - if the server
// cannot start or stops on its own.
//
// Cancelling ctx is the way to stop the server: when it returns, the port is
// released and every event stream has ended.
func ServeContext(ctx context.Context) error {
	return serveContext(ctx, func() {})
}

// serveContext is the body of Serve and ServeContext. onShutdown runs once,
// the moment shutdown begins, before waiting for in-flight requests: Serve
// uses it to release its hold on the interrupt signal.
func serveContext(ctx context.Context, onShutdown func()) error {
	mux := http.NewServeMux()
	routesMu.Lock()
	patterns := make([]string, 0, len(routes))
	for pattern, handler := range routes {
		mux.HandleFunc(pattern, handler)
		patterns = append(patterns, pattern)
	}
	_, healthzTaken := routes["GET /healthz"]
	served = true
	routesMu.Unlock()
	if !healthzTaken {
		mux.HandleFunc("GET /healthz", healthz)
	}
	sort.Slice(patterns, func(i, j int) bool {
		a, b := strings.SplitN(patterns[i], " ", 2), strings.SplitN(patterns[j], " ", 2)
		if a[1] != b[1] {
			return a[1] < b[1]
		}
		return a[0] < b[0]
	})

	port := os.Getenv("API_PORT")
	if port == "" {
		port = "3501"
	}

	// build the server before the banner so a bad BORGO_*_TIMEOUT fails
	// before "api on :port" is printed
	srv := newServer(port, recoverMiddleware(gzipMiddleware(mux)))
	grace := envDuration("BORGO_SHUTDOWN_TIMEOUT", 10*time.Second)
	srv.RegisterOnShutdown(signalShutdown)
	// arm the stream-shutdown latch before anything can connect, so a second
	// run in the same process does not inherit the first one's cancellation
	armShutdown()
	warnSessionSecret()
	printStartup(patterns, port)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		onShutdown()
		shutdown(srv, grace)
	case <-watchParent():
		// on windows a force-killed supervisor delivers no signal: without
		// this the api outlives borgo dev/start, holding the port and the
		// binary until someone finds it in the task manager
		log.Print("borgo: parent process exited; shutting down")
		onShutdown()
		shutdown(srv, grace)
	}
	return nil
}

// watchParent returns a channel that closes when the process named by
// BORGO_PARENT_PID exits; without the env it returns nil (blocks forever).
func watchParent() <-chan struct{} {
	v := os.Getenv("BORGO_PARENT_PID")
	if v == "" {
		return nil
	}
	pid, err := strconv.Atoi(v)
	if err != nil || pid <= 0 {
		return nil
	}
	ch := make(chan struct{})
	go func() {
		waitParentExit(pid)
		close(ch)
	}()
	return ch
}

// shutdown stops accepting and lets in-flight requests finish. Event streams
// end as soon as Shutdown runs the registered hook; anything still open when
// BORGO_SHUTDOWN_TIMEOUT expires is cut, so the process always exits. A grace
// of 0 waits for the last request however long it takes.
func shutdown(srv *http.Server, grace time.Duration) {
	ctx := context.Background()
	if grace > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, grace)
		defer cancel()
	}
	if srv.Shutdown(ctx) != nil {
		log.Printf("borgo: %v shutdown grace elapsed with requests still open; closing them", grace)
		srv.Close()
	}
}

// warnSessionSecret surfaces a missing or weak SESSION_SECRET at startup:
// without this, session routes panic per request while /healthz stays green.
// Not fatal - apps without sessions are legitimate.
func warnSessionSecret() {
	secret := os.Getenv("SESSION_SECRET")
	switch {
	case secret == "":
		log.Print("borgo: SESSION_SECRET not set: session and auth routes will fail until it is")
	case len(secret) < 32:
		log.Printf("borgo: SESSION_SECRET is %d bytes; use at least 32 random bytes", len(secret))
	}
}

func colorEnabled() bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	fi, err := os.Stdout.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

func printStartup(patterns []string, port string) {
	var dim, sage, terra, reset string
	if colorEnabled() {
		dim, sage, terra, reset = "\x1b[2m", "\x1b[38;5;108m", "\x1b[38;5;173m", "\x1b[0m"
	}
	home, ok, dot := "⌂", "✓", "·"
	if !consoleUnicode() {
		home, ok, dot = "^", "+", "-"
	}
	if os.Getenv("BORGO_RELOAD") != "" {
		fmt.Printf("  %s%s%s api restarted on :%s\n", sage, ok, reset, port)
		return
	}
	fmt.Printf("\n  %s%s%s api %s%s :%s%s\n", terra, home, reset, dim, dot, port, reset)
	for _, p := range patterns {
		parts := strings.SplitN(p, " ", 2)
		fmt.Printf("  %s%-7s%s %s\n", sage, parts[0], reset, parts[1])
	}
}
