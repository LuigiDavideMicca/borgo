package borgo

import (
	"compress/gzip"
	"io"
	"log"
	"maps"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// responses below this many bytes ship identity: the gzip header would eat
// most of the saving
const gzipMinBytes = 1024

// a gzip.Writer carries ~800 KB of deflate window and hash tables: allocating
// one per response dwarfs everything else in the request path
var gzipWriters sync.Pool

// gzipMiddleware compresses responses when the client accepts gzip. Small
// responses stay identity, event streams and pre-encoded responses pass
// through, and Flush keeps working so SSE and streamed handlers are unhurt.
func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// the representation depends on Accept-Encoding whether or not this
		// response ends up compressed - and whether or not this client can
		// take gzip: an identity response cached without Vary would be served
		// to gzip-capable clients too
		w.Header().Set("Vary", "Accept-Encoding")
		if !acceptsGzip(r.Header.Get("Accept-Encoding")) {
			next.ServeHTTP(w, r)
			return
		}
		gw := &gzipResponseWriter{rw: w}
		defer gw.finish()
		next.ServeHTTP(gw, r)
		// reached only when the handler returned on its own: a panic unwinds
		// past this line and finish must not ship half a response
		gw.complete = true
	})
}

// acceptsGzip reports whether the client will take a gzip response. "*" speaks
// only for codings the header did not name (RFC 9110 12.5.3), so an explicit
// gzip entry decides on its own: "gzip;q=0, *" is a refusal, and compressing it
// would ship bytes the client just said it cannot decode.
func acceptsGzip(acceptEncoding string) bool {
	wildcard := false
	for _, part := range strings.Split(acceptEncoding, ",") {
		params := strings.Split(part, ";")
		name := strings.TrimSpace(params[0])
		// coding names are case-insensitive (RFC 9110): "GZIP" must compress too
		gzipNamed := strings.EqualFold(name, "gzip")
		if !gzipNamed && name != "*" {
			continue
		}
		if gzipNamed {
			return !refusesCoding(params[1:])
		}
		wildcard = !refusesCoding(params[1:])
	}
	return wildcard
}

// refusesCoding reports whether a coding's parameters carry a zero quality;
// any spelling of it (q=0, q=0.0, q=0.00) is a refusal.
//
// The parameter name is matched case-insensitively, like the coding name
// beside it: RFC 9110 5.6.6 makes parameter names case-insensitive, and
// "gzip;Q=0" is a client refusing gzip in a spelling no less valid than
// "gzip;q=0". Matching only the lowercase one compressed a response for a
// client that had just said it cannot decode it.
func refusesCoding(params []string) bool {
	for _, param := range params {
		name, value, ok := strings.Cut(param, "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(name), "q") {
			continue
		}
		q, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		return err == nil && q <= 0
	}
	return false
}

// gzipResponseWriter holds the status and buffers the first kilobyte, so the
// compress-or-not decision is made before any header reaches the client.
//
// Headers are snapshotted when WriteHeader commits a status, mirroring
// net/http: without that, a header mutated while the buffer still holds the
// response would ship - which stdlib ignores - and the same handler would
// behave differently once its response grows past the buffer and the wire
// commit happens mid-Write. The snapshot is a shallow map clone - Set and Del
// replace or drop whole value slices, and an in-place Add cannot grow the
// snapshot's view of a shared slice, so shallow is as isolating as net/http's
// deep clone for everything the Header API can express. Measured cost: two
// allocations (map header + buckets, ~400 B) and ~0.3 us per response, under
// a percent of serving a real request.
type gzipResponseWriter struct {
	rw          http.ResponseWriter
	status      int
	header      http.Header // snapshot taken at WriteHeader, written at commit
	buf         []byte
	gz          *gzip.Writer
	passthrough bool
	complete    bool
}

func (g *gzipResponseWriter) Header() http.Header { return g.rw.Header() }

// Unwrap lets http.ResponseController reach the underlying writer. Hijack is
// not forwarded - see recoverWriter for why - so a handler cannot take over a
// connection whose headers are staged and whose body may already be a gzip
// stream; http.ResponseController is the supported way through.
func (g *gzipResponseWriter) Unwrap() http.ResponseWriter { return g.rw }

func (g *gzipResponseWriter) WriteHeader(status int) {
	// a 1xx is informational: net/http writes it out immediately and leaves
	// the response uncommitted, so it has to reach the connection now - held
	// back it would arrive after the body, which defeats early hints
	if status >= 100 && status < 200 {
		g.rw.WriteHeader(status)
		return
	}
	if g.status != 0 {
		// log like net/http would: forwarding to the underlying writer could
		// commit the wrong status while the response is still buffered
		if _, file, line, ok := runtime.Caller(1); ok {
			log.Printf("borgo: superfluous WriteHeader(%d) call from %s:%d", status, file, line)
		} else {
			log.Printf("borgo: superfluous WriteHeader(%d) call", status)
		}
		return
	}
	g.status = status
	h := g.rw.Header()
	g.header = maps.Clone(h)
	if strings.HasPrefix(h.Get("Content-Type"), "text/event-stream") || h.Get("Content-Encoding") != "" {
		g.startPassthrough()
	}
}

// commitHeader restores the WriteHeader-time snapshot into the live header
// map just before it reaches the wire, discarding any later mutation. A nil
// snapshot (Flush before WriteHeader) commits the live headers as they are,
// which is what net/http's implicit commit does too.
func (g *gzipResponseWriter) commitHeader() {
	if g.header == nil {
		return
	}
	h := g.rw.Header()
	clear(h)
	maps.Copy(h, g.header)
}

func (g *gzipResponseWriter) Write(p []byte) (int, error) {
	if g.status == 0 {
		g.WriteHeader(http.StatusOK)
	}
	if g.passthrough {
		return g.rw.Write(p)
	}
	if g.gz != nil {
		return g.gz.Write(p)
	}
	g.buf = append(g.buf, p...)
	if len(g.buf) >= gzipMinBytes {
		g.startGzip()
	}
	return len(p), nil
}

// Flush lets streamed handlers deliver progressively: an active gzip writer
// is sync-flushed, a still-buffering response is committed as identity.
func (g *gzipResponseWriter) Flush() {
	if g.status == 0 {
		g.status = http.StatusOK
	}
	if g.gz != nil {
		g.gz.Flush()
	} else if !g.passthrough {
		g.startPassthrough()
	}
	if f, ok := g.rw.(http.Flusher); ok {
		f.Flush()
	}
}

func (g *gzipResponseWriter) startGzip() {
	g.commitHeader()
	h := g.rw.Header()
	// sniff before compressing: net/http would otherwise see gzip bytes
	if h.Get("Content-Type") == "" {
		h.Set("Content-Type", http.DetectContentType(g.buf))
	}
	h.Del("Content-Length")
	h.Set("Content-Encoding", "gzip")
	g.rw.WriteHeader(g.status)
	if gz, ok := gzipWriters.Get().(*gzip.Writer); ok {
		gz.Reset(g.rw)
		g.gz = gz
	} else {
		g.gz = gzip.NewWriter(g.rw)
	}
	g.gz.Write(g.buf)
	g.buf = nil
}

func (g *gzipResponseWriter) startPassthrough() {
	g.passthrough = true
	g.commitHeader()
	g.rw.WriteHeader(g.status)
	if len(g.buf) > 0 {
		g.rw.Write(g.buf)
		g.buf = nil
	}
}

func (g *gzipResponseWriter) finish() {
	if g.gz != nil {
		if err := g.gz.Close(); err != nil {
			log.Printf("borgo: gzip close: %v", err)
		}
		// point the pooled writer away from this response before parking it,
		// so a finished request is not kept alive by the pool - and a write
		// after the handler returned cannot land in someone else's stream
		g.gz.Reset(io.Discard)
		gzipWriters.Put(g.gz)
		g.gz = nil
		return
	}
	if g.passthrough {
		return
	}
	if g.status == 0 || !g.complete {
		// nothing is on the wire yet: either the handler wrote nothing - an
		// empty 200, or a panic before the first byte - or it panicked with a
		// half-written body still in the buffer. Committing that half would
		// send a truncated 200 under a Content-Length that no longer matches;
		// leaving the response uncommitted lets the recovery answer 500
		// (net/http still writes an empty 200 if nobody else does)
		return
	}
	g.commitHeader()
	g.rw.WriteHeader(g.status)
	if len(g.buf) > 0 {
		g.rw.Write(g.buf)
	}
}
