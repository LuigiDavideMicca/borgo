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

// Version is the version of the borgo module, the same number as the npm
// packages and the git tag of the release. Bumped by hand in the release PR:
// release-please cannot reach the repository root from packages/borgo, and a
// root package entry would claim the tag packages/borgo already owns.
// TestVersionMatchesManifest fails the build when this disagrees with
// .release-please-manifest.json.
const Version = "0.21.0" // x-release-please-version

var (
	// init() registers on one goroutine, but an app may register lazily
	routesMu sync.Mutex
	routes   = map[string]http.HandlerFunc{}
	// latched when the mux is built, after the last refusal: a run that
	// would not start leaves Handle working
	served    bool
	patternRe = regexp.MustCompile(`^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /\S*$`)
	// the mux is the authority on pattern syntax and conflicts: registering
	// eagerly moves the panic from Serve to the offending Handle call
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
		// encoded before the status is committed: an unencodable value is a
		// 500, not a 200 with a truncated body
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

// bindLimit caps request bodies decoded by Bind at 1 MB.
const bindLimit = 1 << 20

// Bind decodes the request body as JSON into T, reading at most 1 MB - use
// BindMax for routes that legitimately take more. borgogen reads T to type
// the route's request body for the TypeScript api client. On error, respond
// with BindError to get the right status.
//
// The request must declare Content-Type: application/json; anything else,
// a missing header included, is refused as 415.
func Bind[T any](r *http.Request) (T, error) {
	return BindMax[T](r, bindLimit)
}

var errContentType = errors.New("Content-Type must be application/json")

// BindMax is Bind with an explicit body size limit in bytes; limit <= 0
// disables the cap.
func BindMax[T any](r *http.Request, limit int64) (T, error) {
	var v T
	// required, not merely checked when present: a cross-site fetch can send
	// a body with no Content-Type and no preflight (a Blob with an empty type
	// is CORS-safelisted), so an empty header must be refused too. Every
	// request that binds came same-origin or passed a preflight
	ct, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || ct != "application/json" {
		return v, errContentType
	}
	body := r.Body
	if limit > 0 {
		// no ResponseWriter to mark the connection close-after-reply on
		// overflow: the excess bytes may be read and discarded
		body = http.MaxBytesReader(nil, r.Body, limit)
	}
	dec := json.NewDecoder(body)
	if err := dec.Decode(&v); err != nil {
		return v, err
	}
	if _, err := dec.Token(); err != io.EOF {
		// a value that completes inside the limit can still overflow on the
		// trailing bytes, reported here and not from Decode: the
		// *http.MaxBytesError must survive for BindError to answer 413
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
// Without it, only the orders borgo's own setters see are closed: SetSession
// then borgo.NoCache, or a hand-written Cache-Control, escapes, because there
// is no last moment on somebody else's mux. And nothing that touches
// Cache-Control may sit outside the wrapper: an outer defer that writes
// `public` after this has committed reaches the wire beside the cookie.
func Middleware(h http.Handler) http.Handler {
	return recoverMiddleware(gzipMiddleware(h))
}

// recoverMiddleware answers a panicking handler with a 500 instead of letting
// net/http drop the connection. A response still in gzipMiddleware's buffer
// has not reached the wire, so a panic half way through a small body gets the
// 500 too; once bytes are committed the panic is only logged.
func recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rw := &recoverWriter{ResponseWriter: w}
		defer func() {
			// the write paths commit from Write, WriteHeader and Flush; a
			// handler that staged a cookie and returned without writing
			// reaches none of them, and only this defer
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
				// the staged headers belong to the abandoned response: a
				// Cache-Control would have a cdn hold the 500, a session cookie
				// would hand out a login the request never completed
				dropAbandonedHeaders(rw.Header())
				WriteJSON(rw, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
			}
		}()
		next.ServeHTTP(rw, r)
	})
}

// connectionHeaders survive a response being replaced by the recovery's 500:
// they describe the connection or the negotiation, never the body that died.
// Vary: Accept-Encoding is set by gzipMiddleware before the handler runs and
// must reach a shared cache; Connection: close condemned the connection, not
// the body, and dropping it would return it to the keep-alive pool. Trailer
// and Transfer-Encoding frame the message being replaced, so they go.
// Canonical spellings only: a key written straight into the map as "vary" is
// dropped, and too little kept costs a cache hit where too much could carry
// the abandoned cookie onto the error.
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

// recoverWriter records whether the response was committed, and forwards
// Flush and Unwrap so streaming handlers and http.ResponseController reach
// the real writer.
//
// Hijack is not a method here or on gzipResponseWriter, so `w.(http.Hijacker)`
// fails in a borgo handler; ResponseController.Hijack still succeeds through
// Unwrap, on a connection that may already hold staged headers or a gzip
// stream. Supporting in-process upgrades means a Hijack that refuses once
// bytes are buffered or committed, not a blind forward.
type recoverWriter struct {
	http.ResponseWriter
	wrote bool
}

// commit runs the Set-Cookie/Cache-Control guard as the headers reach the
// wire, when every cookie the handler set is staged. gzipResponseWriter runs
// it too from commitHeader, but a handler that writes nothing never gets
// there; recoverMiddleware's defer does. A cookie set after the commit never
// reaches the wire at all, which is stock net/http and fails closed.
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
// "0" disables it. A malformed value is refused, not defaulted: defaulting
// would run the server on a timeout nobody chose and nothing prints.
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

// envPort reads API_PORT here, before the registry is mounted, rather than
// letting net.Listen settle it afterwards. A value that is not a port number
// is refused, not defaulted: defaulting serves a typo on 3501 and the
// deployment is reachable at the wrong place.
func envPort() (string, error) {
	v := os.Getenv("API_PORT")
	if v == "" {
		return "3501", nil
	}
	n, err := strconv.Atoi(v)
	// digits only: Atoi takes "+80", net takes ":0080", and a typo produces
	// neither (":3501", "3501 ", "8080;ls")
	if err != nil || n < 0 || n > 65535 || strings.Trim(v, "0123456789") != "" {
		return "", fmt.Errorf(`borgo: API_PORT: invalid port %q (want 0-65535; unset uses 3501)`, v)
	}
	return v, nil
}

// envParentPID reads BORGO_PARENT_PID, the supervisor whose exit ends this run;
// 0 means nobody is watching. A malformed value is refused, not ignored: an
// ignored one is silently no watch, and on windows a force-killed borgo dev
// then leaves the api holding the port.
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

// warnParentMismatch prints one line at boot when BORGO_PARENT_PID is not
// this process's parent: the pid is still watched, but waitParentExit's
// reparent branch is off and only the probe remains, which is better learned
// here than from an orphan. Called after the processExited probe: a pid
// already gone refuses the boot and is not also a mismatch.
func warnParentMismatch(pid, ppid int) {
	if pid <= 0 || pid == ppid {
		return
	}
	log.Printf("borgo: BORGO_PARENT_PID=%d is not this process's parent (%d): the reparent branch is off, only the probe is watching", pid, ppid)
}

// newServer configures the http server borgo.Serve runs. Read and write
// timeouts default to 0 on purpose: they are wall-clock deadlines on the
// whole request and would kill SSE streams - bodies are capped by Bind's 1 MB
// reader instead, and borgo.SSE clears the deadlines on its own connection.
// Each variable stays a literal in its envDuration call: envNamesDoNotCollide
// (packages/borgo/test/util.test.ts) greps them out of this file and fails on
// an alias.
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
	// stop is also passed in: restoring the default handlers as shutdown
	// begins lets a second ctrl-c kill a shutdown that is taking too long
	if err := serveContext(ctx, stop); err != nil {
		log.Fatal(err)
	}
}

// ServeContext is Serve that returns instead of exiting. It mounts every
// registered route, listens on API_PORT and blocks until ctx is cancelled or
// the parent process named by BORGO_PARENT_PID exits, then shuts down
// gracefully within BORGO_SHUTDOWN_TIMEOUT and returns nil. A listener that
// cannot start or stops on its own, a refusal from CheckEnv and a malformed
// BORGO_*_TIMEOUT all come back as errors, never as an exit or a panic, and
// the route registry stays open after any of them.
//
// When it returns, the port is released and every event stream this run was
// serving has ended.
func ServeContext(ctx context.Context) error {
	return serveContext(ctx, func() {})
}

// serveContext is the body of Serve and ServeContext. onShutdown runs once,
// the moment shutdown begins, before waiting for in-flight requests.
func serveContext(ctx context.Context, onShutdown func()) error {
	// every refusal, the bind included, comes before the registry is mounted:
	// a run that will not start must leave Handle working for a retry
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
		// left to the watch, this run would mount, shut down at once and
		// report the abort as a clean nil
		return fmt.Errorf("borgo: parent process %d has already exited; not starting", parentPID)
	}
	warnParentMismatch(parentPID, os.Getppid())
	// bound here, not in ListenAndServe: a port in use is a refusal like the
	// others, with the registry untouched and no banner printed
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return err
	}

	mux, patterns := mountRoutes()
	srv.Handler = Middleware(mux)
	// armed before anything can connect, dropped however this run ends
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
		// on windows a force-killed supervisor delivers no signal
		log.Print("borgo: parent process exited; shutting down")
		onShutdown()
		shutdown(srv, grace)
	}
	return nil
}

// mountRoutes snapshots the registry into a mux, adds /healthz unless a route
// claims it, and returns the patterns sorted for the banner. The latch is set
// in the same hold of the lock as the snapshot: a Handle landing between the
// two would be accepted and never mounted.
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
// exits, and the func that ends the watch. For pid 0 the channel is nil
// (blocks forever) and the stop is a no-op.
//
// The stop is not optional: nothing else ends the watcher's wait, and
// ServeContext runs more than once per process.
func watchParent(pid int) (<-chan struct{}, func()) {
	if pid <= 0 {
		return nil, func() {}
	}
	stop := make(chan struct{})
	ch := make(chan struct{})
	go func() {
		// a cancelled watch observed nothing: closing ch would report an
		// exit that never happened
		if waitParentExit(pid, stop) {
			close(ch)
		}
	}()
	return ch, sync.OnceFunc(func() { close(stop) })
}

// shutdown stops accepting and lets in-flight requests finish; anything still
// open when the grace expires is cut, so the process always exits. A grace of
// 0 waits for the last request however long it takes.
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

// checkPushEnv says at boot what Push would otherwise reveal on the first
// publish - and a key crossing the network in clear is the event that leaves
// no other trace. It lives here rather than beside Push so that publishing
// stays free of logging.
func checkPushEnv() error {
	// the destination before the key: an unreachable one is broken whether
	// or not a secret is involved
	var endpoint *url.URL
	base, from, err := pushBase()
	if err == nil {
		endpoint, err = pushEndpoint(base, from)
	}
	if err != nil {
		// an explicit FRONT_URL is a declared intent and stops the boot; a
		// broken default comes from PORT, which the front server reads for
		// itself and may be fine with
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
		// an unreadable switch is refused at boot, as SESSION_SECURE is
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
	// the key really is leaving in clear: this line has to read worse than
	// the refusal above it, which is the safe state
	log.Printf("borgo: BORGO_PUSH_KEY crosses the network in clear to %s on every push, because BORGO_PUSH_INSECURE is set", endpoint.Host)
	return nil
}

// CheckEnv settles the session and push environment while somebody is still
// watching the terminal. Serve and ServeContext call it before they bind;
// call it yourself at startup if you mount borgo's handlers on your own
// server, or the first request that writes a cookie is where you find out.
// It logs the warnings and returns the refusals, never exits: the caller may
// be a test binary or an embedder with cleanup of its own.
//
// SESSION_SECURE is refused when it is not a boolean, not read as false: that
// issued a cookie the browser sends back over plain http. An unset
// SESSION_SECRET only warns, since borgo already refuses to issue or verify a
// session without one; a short one is refused, because a handful of bytes can
// be searched offline from a single captured cookie, and a warning let that
// run in production.
//
// BORGO_HASH_SLOTS is re-read rather than replayed from init: a refusal
// frozen at init would outlive the correction and leave ServeContext dead for
// the life of the process. Init is the only place the cap can be sized, so a
// corrected value arriving later is logged as too late.
func CheckEnv() error {
	slots, err := hashSlotCount()
	if err != nil {
		return err
	}
	// compared, not guarded on the variable being set: unsetting it after
	// init asks for the default while the process keeps the cap it was given
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
