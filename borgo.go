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
	"net"
	"net/http"
	"net/url"
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
	// would silently register a route that is never mounted, so it panics. It
	// is latched when the mux is built, which is after the last refusal has
	// been returned: a run that would not start leaves Handle working
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
//
// The request must declare Content-Type: application/json. Anything else -
// including no Content-Type at all, which a cross-site fetch can send without
// earning a preflight - is refused as 415.
func Bind[T any](r *http.Request) (T, error) {
	return BindMax[T](r, bindLimit)
}

var errContentType = errors.New("Content-Type must be application/json")

// BindMax is Bind with an explicit body size limit in bytes; limit <= 0
// disables the cap.
func BindMax[T any](r *http.Request, limit int64) (T, error) {
	var v T
	// the header is required, not merely checked when present. A form post
	// cannot declare application/json, and neither can a cross-site fetch
	// without earning a CORS preflight - but a cross-site fetch can send a
	// body with *no* Content-Type at all (a Blob with an empty type is a
	// CORS-safelisted request and is not preflighted), so accepting the empty
	// header would leave the door this check exists to shut wide open.
	// Requiring it means every request that reaches a handler either came
	// same-origin or passed a preflight. Clients must say what they are
	// sending: `curl -d` declares application/x-www-form-urlencoded and is
	// rejected, `curl -H 'Content-Type: application/json' -d ...` binds.
	ct, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || ct != "application/json" {
		return v, errContentType
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
		// a body whose JSON value happens to complete inside the limit still
		// overflows it on the trailing bytes, and the decoder reports that
		// here rather than from Decode. Substituting a plain error would lose
		// the *http.MaxBytesError BindError matches on, answering 400 for a
		// body that is simply too large
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return v, err
		}
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

// Middleware wraps h in the chain borgo.Serve installs around its own routes:
// panic recovery, gzip, and the Set-Cookie/Cache-Control guard that runs as
// each response's headers commit. An app mounting borgo handlers on its own
// server should wrap its mux in it -
//
//	srv := &http.Server{Handler: borgo.Middleware(mux)}
//
// and gets the same guarantees borgo's own server has. Serve is defined in
// terms of this function, so the two cannot drift apart.
//
// It exists because of what cannot be done from inside the call sites. borgo
// makes a response carrying a Set-Cookie say `private`, and enforces it
// wherever it controls the response: borgo.Cache, SetSession and ClearSession
// each run the guard as they go. On a mux borgo does not own, that is all there
// is, and it is not enough - not because a case was missed but because there is
// no last moment on somebody else's mux. Whatever the handler does after the
// last borgo call escapes: SetSession then a hand-written Header().Set, or
// SetSession then borgo.SSE or borgo.NoCache, both of which set Cache-Control
// after the cookie and are therefore exactly the orders that need this. Adding
// a guard to each new setter only moves the gap to the next one.
//
// So the boundary is: served by borgo, or wrapped in this, and the property
// holds for every handler and every order. Neither, and borgo closes the common
// orders through the call sites and the app owns the rest.
//
// One thing the wrapping does not cover, and it is the reason the rule is "wrap
// your mux and put nothing that touches Cache-Control outside the wrapper"
// rather than just "wrap your mux": an outer middleware that writes
// Cache-Control on the way back out - in its own defer, around this one - wins.
// borgo has already committed the response and exited by then, so `public,
// s-maxage=900` from out there reaches the wire beside a session cookie and
// nothing in here can see it. It is the same silent shape as the bug this guard
// exists for, which is why it is written down and not left to be discovered.
func Middleware(h http.Handler) http.Handler {
	return recoverMiddleware(gzipMiddleware(h))
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
			// the last point every response passes through, taken however the
			// handler leaves: a return, a panic, or a return that wrote
			// nothing at all. commit itself only ever ran from Write,
			// WriteHeader and Flush, so a handler that set a Cache-Control and
			// a cookie and then simply returned reached no commit hook, and
			// net/http emitted the staged headers verbatim - `public` on a
			// response carrying a session. A defer on the outermost middleware
			// frame cannot be skipped by a handler doing nothing, which is
			// exactly what the commit hooks could not see.
			rw.commit()
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
				dropAbandonedHeaders(rw.Header())
				WriteJSON(rw, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
			}
		}()
		next.ServeHTTP(rw, r)
	})
}

// connectionHeaders are the response headers that describe the connection the
// reply travels over, or the negotiation that picked it - never the bytes of
// any one representation. They are the headers that survive a response being
// replaced by the recovery's 500.
//
// Vary is the one that had to be named. gzipMiddleware sets Vary:
// Accept-Encoding on every request before the handler runs, precisely so a
// shared cache knows the reply depends on the negotiation, and a blanket clear
// took it back off - measured on the wire, both with and without
// Accept-Encoding, because a panic before the response buffer fills starts no
// gzip and so leaves the 500 uncompressed for either client. The practical
// exposure is small: the 500 carries no freshness of its own and 500 is not a
// status a cache may store heuristically (RFC 9111 4.2.2), so nothing should
// keep it. Small is not the point. Vary is the one header whose whole job is to
// tell a shared cache that this reply was negotiated, and deleting it is
// exactly the gesture that must not happen by accident.
//
// Connection is the second, and it is not cosmetic at all: a handler that set
// Connection: close said something about the connection, not about the body it
// then failed to produce, and dropping it silently returned a connection the
// handler had condemned to the keep-alive pool. Keep-Alive travels with it for
// the same reason.
//
// Content framing is deliberately absent. Trailer and Transfer-Encoding
// describe how this message is delimited, and this message is being replaced -
// announcing a trailer the 500 will never send is a promise made by the
// response that died.
//
// Canonical spellings only, matching what h.Set stages and what the rest of
// borgo's header code can see. A header written straight into the map as
// w.Header()["vary"] is dropped with everything else, and that is the correct
// side to be wrong on: keeping too little costs a cache hit, keeping too much
// could carry the abandoned response's cookie onto the error.
var connectionHeaders = [...]string{"Connection", "Keep-Alive", "Vary"}

// dropAbandonedHeaders empties the header map of everything staged for a
// response that will not be sent, keeping what describes the connection it
// would have been sent over.
func dropAbandonedHeaders(h http.Header) {
	var kept [len(connectionHeaders)][]string
	for i, name := range connectionHeaders {
		kept[i] = h[name]
	}
	clear(h)
	for i, name := range connectionHeaders {
		if kept[i] != nil {
			h[name] = kept[i]
		}
	}
}

// recoverWriter records whether the response was committed. It forwards Flush
// and Unwrap so streaming handlers and http.ResponseController still reach the
// real writer.
//
// Hijack is not forwarded as a method, here or on gzipResponseWriter, so a
// `w.(http.Hijacker)` assertion inside a borgo handler fails - gorilla/
// websocket and anything else that reaches for the connection that way cannot
// upgrade. That is not the same thing as hijacking being prevented, and an
// earlier version of this comment implied it was: both wrappers forward Unwrap,
// and http.ResponseController.Hijack unwraps until it finds a Hijacker, so it
// succeeds. Verified on the wire, not reasoned about.
//
// What the missing method buys is that nothing hijacks by accident: the
// supported route is explicit, and borgo's own streaming is server-sent events,
// which needs no hijack, while websockets in a borgo app terminate on the front
// server (the ws relay), not in the go api. The hazard the missing method was
// meant to cover is still open through ResponseController - a connection this
// wrapper has already staged headers for and, past gzipMinBytes, written a gzip
// stream into. Closing it means a Hijack method that refuses on any writer with
// buffered or committed bytes, which is the honest change if the api ever has
// to upgrade in-process; a blind forward is not.
type recoverWriter struct {
	http.ResponseWriter
	wrote bool
}

// commit runs the Set-Cookie/Cache-Control guard just before a response's
// headers reach the wire - whatever it was written by, and whether or not the
// handler set a status explicitly. By now every cookie the handler set is
// staged, so it no longer matters whether borgo.Cache ran before or after
// SetSession.
//
// It belongs here rather than in gzipResponseWriter because that one is only
// installed for clients that accept gzip - a request with no Accept-Encoding
// goes straight to the handler, which is exactly the request a naive cache
// probe makes. recoverWriter wraps unconditionally.
//
// These three call sites are still not enough on their own: they are reached
// only when the handler writes something. recoverMiddleware calls commit from
// its defer as well, which is the call that covers a handler that writes
// nothing, and SetSession and ClearSession call the guard directly, which is
// what covers an app mounting borgo handlers on its own server with none of
// this in the path. The write paths keep their own calls because they commit
// headers before the handler returns, where a defer would arrive too late.
//
// A cookie set after the response is committed is a different matter and not
// one this can help with: net/http has already serialised the header block, so
// the cookie never reaches the wire at all. That is stock behaviour, identical
// without borgo, and it fails closed - no cookie, nothing to protect.
func (w *recoverWriter) commit() {
	if w.wrote {
		return
	}
	privateIfCookies(w.Header())
}

func (w *recoverWriter) WriteHeader(status int) {
	// an informational 1xx leaves the response uncommitted: a handler that
	// panics right after sending early hints must still get its 500
	if status >= 100 && status < 200 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.commit()
	w.wrote = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *recoverWriter) Write(p []byte) (int, error) {
	// net/http commits an implicit 200 on the first write without routing it
	// back through WriteHeader, so the guard has to run from here too
	w.commit()
	w.wrote = true
	return w.ResponseWriter.Write(p)
}

func (w *recoverWriter) Flush() {
	w.commit()
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
// "0" disables the timeout. A malformed value is refused rather than defaulted:
// too strict costs a boot the operator can fix from the message, too lax runs
// the server on a timeout nobody chose and nothing prints.
func envDuration(name string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(name)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		return def, fmt.Errorf(`borgo: %s: invalid duration %q (want e.g. "5s"; "0" disables)`, name, v)
	}
	return d, nil
}

// envPort reads API_PORT. It is the one variable net would otherwise settle,
// from inside ListenAndServe, long after the registry is mounted: "nope" came
// back as "lookup tcp/nope: unknown port" from a run that had already closed
// the registry behind it. A value that is not a port number is refused rather
// than defaulted - too strict costs a boot the message names the fix for, too
// lax serves a typo on 3501 and the deployment is reachable at the wrong place.
func envPort() (string, error) {
	v := os.Getenv("API_PORT")
	if v == "" {
		return "3501", nil
	}
	n, err := strconv.Atoi(v)
	// digits only: net takes ":0080" but not ":+80", and neither takes the
	// shapes a typo actually produces (":3501", "3501 ", "8080;ls")
	if err != nil || n < 0 || n > 65535 || strings.Trim(v, "0123456789") != "" {
		return "", fmt.Errorf(`borgo: API_PORT: invalid port %q (want 0-65535; unset uses 3501)`, v)
	}
	return v, nil
}

// envParentPID reads BORGO_PARENT_PID, the supervisor whose exit ends this run;
// 0 means nobody is watching. A value that is not a pid was silently no watch
// at all, which is the failure this variable exists to prevent: on windows a
// force-killed borgo dev leaves the api holding the port until someone finds it
// in the task manager. Refusing costs a boot for a variable no human sets.
func envParentPID() (int, error) {
	v := os.Getenv("BORGO_PARENT_PID")
	if v == "" {
		return 0, nil
	}
	pid, err := strconv.Atoi(v)
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf(`borgo: BORGO_PARENT_PID: invalid pid %q (want a positive integer; unset means no parent watch)`, v)
	}
	return pid, nil
}

// newServer configures the http server borgo.Serve runs. ReadHeaderTimeout
// caps slow-header (slowloris) clients; IdleTimeout reclaims kept-alive
// connections. Read and write timeouts stay 0 by design: they are wall-clock
// deadlines on the whole request, which would kill SSE streams and any
// long-lived response - body abuse is capped by Bind's 1 MB reader instead,
// and borgo.SSE clears the deadlines on its own connection in case an app
// sets BORGO_READ_TIMEOUT / BORGO_WRITE_TIMEOUT anyway.
// Each variable is named in a literal envDuration call: envNamesDoNotCollide
// scrapes these four names out of this file to prove no variable is read as a
// duration here and as a plain number by the front server. Hiding them behind a
// local alias reads as an empty set, and the collision guard has nothing left
// to compare.
func newServer(port string, handler http.Handler) (*http.Server, error) {
	readHeaderTimeout, err := envDuration("BORGO_READ_HEADER_TIMEOUT", 5*time.Second)
	if err != nil {
		return nil, err
	}
	readTimeout, err := envDuration("BORGO_READ_TIMEOUT", 0)
	if err != nil {
		return nil, err
	}
	writeTimeout, err := envDuration("BORGO_WRITE_TIMEOUT", 0)
	if err != nil {
		return nil, err
	}
	idleTimeout, err := envDuration("BORGO_IDLE_TIMEOUT", 2*time.Minute)
	if err != nil {
		return nil, err
	}
	return &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
	}, nil
}

// Serve mounts every registered route and listens on API_PORT (default 3501).
// It also answers GET /healthz, unless a registered route claims it. It blocks
// until the process is signalled, then shuts down gracefully; a listener that
// fails to start, or an environment CheckEnv refuses, is fatal.
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
// cannot start or stops on its own, CheckEnv's if the session environment is
// unusable, and a malformed BORGO_*_TIMEOUT as an error too. It never exits the
// process and never panics its way out: every refusal comes back as a value, so
// an embedder's own cleanup, and any other server it is running, survive a
// borgo that will not start - and so does the route registry, which is only
// closed once the mux is built, after the last refusal.
//
// Cancelling ctx is the way to stop the server: when it returns, the port is
// released and every event stream this run was serving has ended.
func ServeContext(ctx context.Context) error {
	return serveContext(ctx, func() {})
}

// serveContext is the body of Serve and ServeContext. onShutdown runs once,
// the moment shutdown begins, before waiting for in-flight requests: Serve
// uses it to release its hold on the interrupt signal.
func serveContext(ctx context.Context, onShutdown func()) error {
	// everything that can refuse this run happens before the registry is
	// mounted, the bind included, and the handler goes on afterwards: a run
	// that will not start must leave Handle working, or the caller it handed
	// the refusal to cannot retry. Exiting from in here would take an
	// embedder's process with it, deferred cleanup unrun, which is the one
	// thing ServeContext exists not to do
	port, err := envPort()
	if err != nil {
		return err
	}
	if err := CheckEnv(); err != nil {
		return err
	}
	srv, err := newServer(port, nil)
	if err != nil {
		return err
	}
	grace, err := envDuration("BORGO_SHUTDOWN_TIMEOUT", 10*time.Second)
	if err != nil {
		return err
	}
	parentPID, err := envParentPID()
	if err != nil {
		return err
	}
	if parentPID > 0 && processExited(parentPID) {
		// otherwise this run mounts, shuts down before serving a request, and
		// reports the abort to its caller as a clean nil
		return fmt.Errorf("borgo: parent process %d has already exited; not starting", parentPID)
	}
	// bind before mounting rather than inside ListenAndServe: a port already in
	// use is then a refusal like the others, with the registry untouched and no
	// banner printed for a server that never came up
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return err
	}

	mux, patterns := mountRoutes()
	srv.Handler = Middleware(mux)
	// arm this server's stream-shutdown latch before anything can connect, and
	// drop it on the way out however this run ends: a run that never binds
	// must leave no latch behind it
	defer armStreamShutdown(srv)()
	printStartup(patterns, port)

	parentExited, stopWatchingParent := watchParent(parentPID)
	defer stopWatchingParent()

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		onShutdown()
		shutdown(srv, grace)
	case <-parentExited:
		// on windows a force-killed supervisor delivers no signal: without
		// this the api outlives borgo dev/start, holding the port and the
		// binary until someone finds it in the task manager
		log.Print("borgo: parent process exited; shutting down")
		onShutdown()
		shutdown(srv, grace)
	}
	return nil
}

// mountRoutes snapshots the registry into a mux, adds /healthz unless a route
// claims it, and returns the patterns sorted for the banner. It closes the
// registry as it reads it, in one hold of the lock: a Handle that landed
// between the snapshot and the latch would be accepted and never mounted.
func mountRoutes() (*http.ServeMux, []string) {
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
	return mux, patterns
}

// watchParent returns a channel that closes when the process named by pid
// exits, and the func that ends the watch. For pid 0 - nobody to watch - the
// channel is nil (blocks forever) and the stop is a no-op.
//
// The stop is not optional. The watcher blocks in a wait nothing else ends -
// on windows inside WaitForSingleObject, holding a kernel handle on the parent
// - so without it every ServeContext run left a goroutine parked for the life
// of the process, and ServeContext exists to be called more than once. Each
// run ends its own watcher on the way out.
func watchParent(pid int) (<-chan struct{}, func()) {
	if pid <= 0 {
		return nil, func() {}
	}
	stop := make(chan struct{})
	ch := make(chan struct{})
	go func() {
		// a cancelled watch observed nothing about the parent: closing ch
		// there would report an exit that never happened
		if waitParentExit(pid, stop) {
			close(ch)
		}
	}()
	return ch, sync.OnceFunc(func() { close(stop) })
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

// CheckEnv settles the session environment - SESSION_SECURE and
// SESSION_SECRET - while there is still somebody watching the terminal who can
// fix it. Serve and ServeContext call it before they bind; call it yourself at
// startup if you mount borgo's handlers on your own server, or the first
// request that writes a cookie is where you find out. It logs the warnings and
// returns the refusals.
//
// SESSION_SECURE is refused when it is not a boolean: it was an == "1" test
// once, so SESSION_SECURE=true read as false and quietly issued a cookie the
// browser would send back over plain http.
//
// An unset SESSION_SECRET only warns: an app with no sessions is legitimate,
// and borgo already refuses to issue or verify one, so the failure direction
// is closed.
//
// Set but too short is refused outright. A short key is not a weaker secret,
// it is a searchable one - the whole security of a session cookie is that
// nobody can produce its HMAC, and a handful of bytes can be exhausted offline
// from a single cookie the attacker holds. Warning was worse than either
// alternative: it let a searchable key run in production while printing a line
// nobody reads, which is the same silent-downgrade shape as SESSION_SECURE=true
// issuing a non-Secure cookie. Refusing costs a restart with a real secret;
// accepting costs every session in the app.
//
// The refusal is an error and not a log.Fatal because the caller may be a test
// binary or a program that embeds the api: exiting from inside ServeContext
// killed the process mid-run, skipped its deferred cleanup and took any
// sibling server with it. Serve, which owns its process, still exits.
//
// It also refuses BORGO_HASH_SLOTS, which package init can only log: init runs
// before main, where the only way to refuse is to kill a process that has not
// run a line of its own yet. This is the first moment that refusal can be a
// value. It re-reads the variable rather than replaying what init found - a
// refusal frozen at init outlives the correction and leaves ServeContext dead
// for the life of the process - and says so when a corrected value arrives too
// late to size a semaphore that exists before main does.
// checkPushEnv says at boot what Push would otherwise only reveal on the first
// publish. Every input is environment, so the verdict is settled before a port
// is bound - and a key crossing the network in clear is exactly the event that
// leaves no other trace, hours after the deploy that caused it. It lives here
// rather than beside Push so that publishing stays free of logging.
func checkPushEnv() error {
	// before the key check, not after: a destination no push could reach is
	// broken whether or not a secret is involved, and reading the key first is
	// what left it to be discovered on the first publish instead
	var endpoint *url.URL
	base, from, err := pushBase()
	if err == nil {
		endpoint, err = pushEndpoint(base, from)
	}
	if err != nil {
		// an explicit FRONT_URL is a declared intent, so a broken one stops the
		// boot. A broken default comes from PORT, which the front server reads
		// for itself and may well be fine with - and the message names whichever
		// of the two the operator actually set, never the other
		if from == "FRONT_URL" {
			return err
		}
		log.Printf("borgo: every borgo.Push will fail: %v", err)
		return nil
	}
	if os.Getenv("BORGO_PUSH_KEY") == "" {
		return nil
	}
	if travel := pushKeyMayTravel(endpoint); travel != nil {
		// an unreadable switch is refused here rather than at the first push,
		// the same way SESSION_SECURE is: nobody carries a security setting
		// they cannot read into a running process
		if v := os.Getenv("BORGO_PUSH_INSECURE"); v != "" {
			if _, perr := strconv.ParseBool(v); perr != nil {
				return travel
			}
		}
		log.Printf("borgo: every borgo.Push will fail: %s is not this machine and FRONT_URL is http://, so BORGO_PUSH_KEY would cross the network in clear. Use https, or BORGO_PUSH_INSECURE=1 if that network is one you control", endpoint.Host)
		return nil
	}
	if endpoint.Scheme == "https" || loopbackHost(endpoint.Hostname()) {
		return nil
	}
	// the loophole is open and the key really is leaving in clear. This is the
	// line that has to read worse than the one above it - the refusal is the
	// safe state, and a log that gets skimmed must not have them the wrong way
	// round
	log.Printf("borgo: BORGO_PUSH_KEY crosses the network in clear to %s on every push, because BORGO_PUSH_INSECURE is set", endpoint.Host)
	return nil
}

func CheckEnv() error {
	slots, err := hashSlotCount()
	if err != nil {
		return err
	}
	// compared, not guarded on the variable being set: unsetting it after init
	// asks for the default while the process keeps the cap it was given, which
	// is the same silent difference the other way round
	if slots != cap(hashSlots) {
		log.Printf("borgo: the hash-slot cap is fixed at %d for the life of this process; the environment now asks for %d (BORGO_HASH_SLOTS is read once, at package init)", cap(hashSlots), slots)
	}
	if _, err := sessionSecure(); err != nil {
		return err
	}
	if err := checkPushEnv(); err != nil {
		return err
	}
	secret := os.Getenv("SESSION_SECRET")
	switch {
	case secret == "":
		log.Print("borgo: SESSION_SECRET not set: session and auth routes will fail until it is")
	case len(secret) < sessionSecretMinLen:
		return fmt.Errorf(
			"borgo: SESSION_SECRET is %d bytes; it must be at least %d (openssl rand -base64 48). "+
				"A key this short can be searched offline from one captured cookie, so borgo refuses "+
				"to start rather than sign with it",
			len(secret), sessionSecretMinLen,
		)
	}
	return nil
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
