package borgo

import (
	"compress/gzip"
	"io"
	"log"
	"maps"
	"net/http"
	"runtime"
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
//
// Every request goes through the writer, gzip or not. Accept-Encoding decides
// only what the committed bytes look like, never when the commit happens: with
// the identity path writing straight to the connection, the same handler
// panicking over the same body answered 500 to a client that asked for gzip
// and a truncated 200 to one that did not - the same defect twice, visible
// only to half the clients, which is why it went unnoticed. One writer means
// one commit point, so the two paths cannot drift apart again.
func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// the representation depends on Accept-Encoding whether or not this
		// response ends up compressed - and whether or not this client can
		// take gzip: an identity response cached without Vary would be served
		// to gzip-capable clients too
		w.Header().Set("Vary", "Accept-Encoding")
		// repeated field lines are the same list joined by commas (RFC 9110
		// 5.3): reading only the first, two lines of "gzip" then "gzip;q=0"
		// compressed for a client whose second line refused
		accept := strings.Join(r.Header.Values("Accept-Encoding"), ",")
		gw := &gzipResponseWriter{
			rw:       w,
			compress: acceptsGzip(accept),
			// net/http discards a HEAD body, so there are no bytes to compress
			// and none to describe: declaring an encoding over nothing, and
			// dropping the Content-Length the handler set for the GET it stands
			// in for, both misdescribe the response the client asked about
			bodyless: r.Method == http.MethodHead,
		}
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
//
// A refusal wins wherever it appears. A list may name the same coding twice
// ("gzip, gzip;q=0") and stopping at the first entry read the acceptance and
// missed the refusal behind it - the unsafe direction every time, since the
// client that said no is the one that cannot decode what we then sent.
func acceptsGzip(acceptEncoding string) bool {
	var gzipYes, gzipNo, starYes, starNo bool
	for _, part := range strings.Split(acceptEncoding, ",") {
		params := strings.Split(part, ";")
		// coding names are case-insensitive (RFC 9110): "GZIP" must compress too
		name := strings.TrimSpace(params[0])
		refused := refusesCoding(params[1:])
		switch {
		case strings.EqualFold(name, "gzip"):
			gzipYes, gzipNo = gzipYes || !refused, gzipNo || refused
		case name == "*":
			starYes, starNo = starYes || !refused, starNo || refused
		}
	}
	switch {
	case gzipNo:
		return false
	case gzipYes:
		return true
	case starNo:
		return false
	}
	return starYes
}

// refusesCoding reports whether a coding's parameters withhold acceptance.
//
// The parameter name is matched case-insensitively, like the coding name
// beside it: RFC 9110 5.6.6 makes parameter names case-insensitive, and
// "gzip;Q=0" is a client refusing gzip in a spelling no less valid than
// "gzip;q=0". Matching only the lowercase one compressed a response for a
// client that had just said it cannot decode it.
//
// Every parameter is read, not just the first: "gzip;q=1;q=0" returned on the
// leading q and never saw the refusal behind it.
func refusesCoding(params []string) bool {
	for _, param := range params {
		name, value, ok := strings.Cut(param, "=")
		if !strings.EqualFold(strings.TrimSpace(name), "q") {
			continue
		}
		// a bare "q" names a quality it never gives, and a q that is not a
		// quality is not one the client offered: neither is a licence to
		// compress for a client whose header we could not read
		if !ok || !positiveQuality(value) {
			return true
		}
	}
	return false
}

// positiveQuality reports whether an Accept-Encoding q parameter names a
// weight above zero. HTTP qvalues are "0[.0-3 digits]" or "1[.up to three
// zeroes]" (RFC 9110 12.4.2) and nothing else, so they are read here rather
// than by strconv.ParseFloat, which also accepts Go literal spellings: "q=1_0"
// parsed as ten and compressed for a client whose header held no number at all,
// and "q=NaN" survived every "greater than zero" test.
func positiveQuality(value string) bool {
	whole, frac, dotted := strings.Cut(strings.TrimSpace(value), ".")
	if whole != "0" && whole != "1" {
		return false
	}
	if !dotted {
		return whole == "1"
	}
	if len(frac) > 3 {
		return false
	}
	nonZero := false
	for _, d := range []byte(frac) {
		if d < '0' || d > '9' {
			return false
		}
		nonZero = nonZero || d != '0'
	}
	// "1.5" is not a qvalue; only "1" followed by zeroes is
	if whole == "1" {
		return !nonZero
	}
	return nonZero
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
	compress    bool // the client accepts gzip; only what a full buffer becomes
	bodyless    bool // HEAD: net/http drops the body, so there is none to encode
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
	if g.bodyless || bodylessStatus(status) ||
		strings.HasPrefix(h.Get("Content-Type"), "text/event-stream") || h.Get("Content-Encoding") != "" {
		g.startPassthrough()
	}
}

// bodylessStatus reports the statuses that carry no body, matching net/http's
// own rule (1xx is handled before this). Compressing them announced an
// encoding over zero bytes; on a 304 that is not cosmetic, since RFC 9110
// 15.4.5 has it carry the headers a 200 would and a cache updating its stored
// entry copies our Content-Encoding onto bytes that were never compressed.
func bodylessStatus(status int) bool {
	return status == http.StatusNoContent || status == http.StatusNotModified
}

// commitHeader restores the WriteHeader-time snapshot into the live header
// map just before it reaches the wire, discarding any later mutation. A nil
// snapshot (Flush before WriteHeader) commits the live headers as they are,
// which is what net/http's implicit commit does too.
//
// It is also the one place where every header a response will carry is staged
// at once, which is why the Set-Cookie/Cache-Control guard runs here: at commit
// the order the handler set them in no longer exists to depend on. Every path
// that reaches the wire goes through this - startGzip, startPassthrough and
// finish - so no response leaves committing to a scope it did not mean.
func (g *gzipResponseWriter) commitHeader() {
	h := g.rw.Header()
	if g.header != nil {
		clear(h)
		maps.Copy(h, g.header)
	}
	varyAcceptEncoding(h)
	privateIfCookies(h)
}

// varyAcceptEncoding keeps our Vary on the response next to whatever the
// handler put there. The middleware sets it before the handler runs, but a
// handler that Set or Del'd Vary of its own - "Vary: Cookie" on
// session-dependent content is ordinary - dropped it, and a compressed body
// with no Vary: Accept-Encoding is one a shared cache hands to the next client
// along, which may have no way to decode it. Added, never substituted: the
// handler's own reasons for varying outlive ours.
func varyAcceptEncoding(h http.Header) {
	for _, line := range h.Values("Vary") {
		for _, field := range strings.Split(line, ",") {
			field = strings.TrimSpace(field)
			if field == "*" || strings.EqualFold(field, "Accept-Encoding") {
				return
			}
		}
	}
	h.Add("Vary", "Accept-Encoding")
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
	// buffer only what the decision needs. Appending the whole slice before
	// testing the threshold copied the entire body of a handler that writes it
	// in one call - a second megabyte allocated per megabyte served, on the
	// identity path too. Past the decision the bytes go straight out.
	split := min(len(p), max(gzipMinBytes-len(g.buf), 0))
	g.buf = append(g.buf, p[:split]...)
	if len(g.buf) < gzipMinBytes {
		return len(p), nil
	}
	// the buffer decided: commit here, compressed or not. Both answers commit
	// at the same byte, so a panic one byte later means the same thing to
	// either client
	if g.compress {
		g.startGzip()
	} else {
		g.startPassthrough()
	}
	n, err := g.writeCommitted(p[split:])
	return split + n, err
}

// writeCommitted sends bytes past the commit point, where the encoding is
// settled and nothing is buffered any more.
func (g *gzipResponseWriter) writeCommitted(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if g.gz != nil {
		return g.gz.Write(p)
	}
	return g.rw.Write(p)
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

// finish is the single commit policy both encodings obey: a response already
// committed is truncated, never restated - past the commit point a status can
// no longer be written, so pretending otherwise would only corrupt what the
// client already holds. Below the commit point nothing is on the wire, so the
// response is left uncommitted and the recovery above still owns it.
func (g *gzipResponseWriter) finish() {
	// the response is over. Using a ResponseWriter after the handler returns is
	// already forbidden by net/http, but the leftovers made it worse than
	// inert: the buffer would be shipped a second time, and with g.gz cleared a
	// late write opened a fresh gzip stream nobody closes, sending gzip bytes
	// under no Content-Encoding. Emptied and pinned to passthrough, that write
	// reaches the connection net/http already refuses and stops there
	defer func() {
		g.buf = nil
		g.passthrough = true
	}()
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
