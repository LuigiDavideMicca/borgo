package borgo

import (
	"compress/gzip"
	"errors"
	"io"
	"log"
	"maps"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// below this the gzip header eats most of the saving
const gzipMinBytes = 1024

// a gzip.Writer carries ~800 KB of deflate window and hash tables
var gzipWriters sync.Pool

// gzipMiddleware compresses responses when the client accepts gzip. Small
// responses stay identity, event streams and pre-encoded responses pass
// through, and Flush keeps working so SSE and streamed handlers are unhurt.
//
// Every request goes through the writer, gzip or not: Accept-Encoding decides
// what the committed bytes look like, never when the commit happens, so a
// panic means the same thing to a gzip client and an identity one.
func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// whether or not this response ends up compressed: an identity response
		// cached without Vary would be served to gzip-capable clients too
		w.Header().Set("Vary", "Accept-Encoding")
		// repeated field lines are one list (RFC 9110 5.3): "gzip" then "gzip;q=0"
		// is a refusal
		accept := strings.Join(r.Header.Values("Accept-Encoding"), ",")
		gw := &gzipResponseWriter{
			rw:       w,
			declared: -1,
			compress: acceptsGzip(accept),
			// net/http discards a HEAD body: declaring an encoding over nothing, or
			// dropping the Content-Length of the GET it stands in for, misdescribes it
			bodyless: r.Method == http.MethodHead,
		}
		defer gw.finish()
		next.ServeHTTP(gw, r)
		// a panic unwinds past this line, and finish must not ship half a response
		gw.complete = true
	})
}

// acceptsGzip reports whether the client will take a gzip response. "*"
// speaks only for codings the header did not name (RFC 9110 12.5.3), so an
// explicit gzip entry decides on its own, and a refusal wins wherever it
// appears: "gzip, gzip;q=0" is a refusal.
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

// parameter names are case-insensitive too (RFC 9110 5.6.6): "gzip;Q=0" is a
// refusal. Every parameter is read: "gzip;q=1;q=0" is a refusal as well.
func refusesCoding(params []string) bool {
	for _, param := range params {
		name, value, ok := strings.Cut(param, "=")
		if !strings.EqualFold(strings.TrimSpace(name), "q") {
			continue
		}
		// a bare "q", or a q that is not a quality, is no licence to compress for
		// a client whose header could not be read
		if !ok || !positiveQuality(value) {
			return true
		}
	}
	return false
}

// qvalues are "0[.0-3 digits]" or "1[.up to three zeroes]" (RFC 9110 12.4.2)
// and nothing else; not strconv.ParseFloat, which takes "1_0" as ten and
// lets "NaN" through every greater-than-zero test
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
// Headers are snapshotted when WriteHeader commits a status, as net/http
// does, or the same handler would behave differently once its response grew
// past the buffer. A shallow clone is as isolating as net/http's deep one for
// everything the Header API can express: Set and Del replace whole slices,
// and an in-place Add cannot grow the snapshot's view. Measured: two
// allocations (~400 B) and ~0.3 us per response.
type gzipResponseWriter struct {
	rw          http.ResponseWriter
	status      int
	header      http.Header // snapshot taken at WriteHeader, written at commit
	trailers    http.Header // trailer values, held out of that header block
	buf         []byte
	gz          *gzip.Writer
	declared    int64 // Content-Length the handler set, -1 when it set none
	written     int64 // bytes the body took, not bytes the handler offered
	compress    bool  // the client accepts gzip; only what a full buffer becomes
	bodyless    bool  // no body can exist: HEAD, 204, 304
	passthrough bool
	complete    bool
	writeFailed bool // the connection refused bytes; a short body is not the handler's
}

func (g *gzipResponseWriter) Header() http.Header { return g.rw.Header() }

// Hijack is not forwarded (see recoverWriter): a handler cannot take over a
// connection whose headers are staged and whose body may already be a gzip
// stream. http.ResponseController is the supported way through.
func (g *gzipResponseWriter) Unwrap() http.ResponseWriter { return g.rw }

func (g *gzipResponseWriter) WriteHeader(status int) {
	// net/http writes a 1xx immediately and leaves the response uncommitted;
	// held back it would arrive after the body, which defeats early hints
	if status >= 100 && status < 200 {
		g.rw.WriteHeader(status)
		return
	}
	if g.status != 0 {
		// log like net/http would; forwarding could commit the wrong status while
		// the response is still buffered
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
	// before startGzip deletes it: that deletion hides a wrong one on the
	// compressed path
	g.declared = declaredLength(h)
	g.bodyless = g.bodyless || bodylessStatus(status)
	if g.bodyless || declaresEventStream(h) || declaresEncoding(h) {
		g.startPassthrough(0)
	}
}

// the field's first value on the wire, under whatever spelling of the key
// the handler used: net/http's writer emits the map as it finds it, and
// writeSubset sorts keys, so the smallest key holds the line that arrives
// first. Map order would decide a response by a hash seed.
func firstFieldValue(h http.Header, canonical string) string {
	first := ""
	for k := range h {
		if sameField(k, canonical) && (first == "" || k < first) {
			first = k
		}
	}
	if v := h[first]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// declaresEventStream reads every line under every spelling of Content-Type:
// net/http gates on presence of the key and every line goes on the wire, so
// a text/plain line added before text/event-stream, or a text/event-stream
// assigned through the map, would otherwise get Content-Encoding: gzip over
// a stream, which then reaches the browser in one piece at the end. Values
// are matched whole, after parameters, case-insensitively (RFC 9110 8.3.1).
func declaresEventStream(h http.Header) bool {
	for key, lines := range h {
		if !sameField(key, "Content-Type") {
			continue
		}
		for _, line := range lines {
			for _, value := range strings.Split(line, ",") {
				mediaType, _, _ := strings.Cut(value, ";")
				if strings.EqualFold(strings.TrimSpace(mediaType), "text/event-stream") {
					return true
				}
			}
		}
	}
	return false
}

// declaresEncoding reads every value, not the first: on ["", "br"] the first
// reads "", and compressing the br bytes while h.Set deletes the br
// declaration hands a client br it takes for plaintext. An empty value names
// no coding, so a response carrying only empties still compresses.
func declaresEncoding(h http.Header) bool {
	for key, lines := range h {
		if !sameField(key, "Content-Encoding") {
			continue
		}
		for _, line := range lines {
			if line != "" {
				return true
			}
		}
	}
	return false
}

// -1 for none or for a length that is not a number: net/http logs that one
// itself, except where startGzip has deleted it first, which is why that one
// place repeats it
func declaredLength(h http.Header) int64 {
	// every spelling of the key: oneContentLength has yet to run wherever the
	// answer is taken before commit
	n, err := strconv.ParseInt(firstFieldValue(h, "Content-Length"), 10, 64)
	if err != nil || n < 0 {
		return -1
	}
	return n
}

// net/http's own rule (1xx is handled before this). Not cosmetic on a 304:
// RFC 9110 15.4.5 has it carry the headers a 200 would, and a cache updating
// its stored entry would copy our Content-Encoding onto bytes never compressed
func bodylessStatus(status int) bool {
	return status == http.StatusNoContent || status == http.StatusNotModified
}

// commitHeader restores the WriteHeader-time snapshot into the live map just
// before the wire; a nil snapshot (Flush before WriteHeader) commits the live
// headers, as net/http's implicit commit does. Every path to the wire comes
// through here, which is why the Set-Cookie/Cache-Control guard runs here: at
// commit the order the handler set them in no longer exists.
func (g *gzipResponseWriter) commitHeader() {
	h := g.rw.Header()
	if g.header != nil {
		g.trailers = takeTrailers(h, g.header)
		clear(h)
		maps.Copy(h, g.header)
	}
	varyAcceptEncoding(h)
	privateIfCookies(h)
	oneContentLength(h)
	// the two fields startGzip writes under the canonical key, folded before it
	// writes them
	foldFieldKey(h, "Content-Encoding")
	foldFieldKey(h, "Content-Type")
}

// foldFieldKey moves every spelling of a field onto its canonical key,
// keeping the values in the order their lines reach the wire. h.Set replaces
// h["Content-Encoding"] and leaves h["CONTENT-ENCODING"] beside it, and
// writeSubset sorts keys, so the survivor can arrive first: measured, a
// client took 42 bytes of gzip for text, and a handler's text/html reached an
// identity client while a gzip client got text/plain. No value is dropped or
// reordered.
func foldFieldKey(h http.Header, canonical string) {
	scattered := false
	for k := range h {
		if k != canonical && sameField(k, canonical) {
			scattered = true
			break
		}
	}
	// canonical or absent: one scan, no allocation
	if !scattered {
		return
	}
	var all []string
	for _, k := range fieldKeys(h, canonical) {
		all = append(all, h[k]...)
		delete(h, k)
	}
	// assigned even when empty: a present key with no value is how a handler
	// turns net/http's sniffing off
	h[canonical] = all
}

// oneContentLength leaves the response the single Content-Length its body
// was already sized by. Contradictory ones are unrecoverable to a recipient
// (RFC 9110 8.6): net/http's Transport drops the connection and delivers no
// status. The first value is the one in force, since net/http sizes the body
// by it; identical repeats pass without a word. Every spelling is moved onto
// the canonical key: net/http sizes by h["Content-Length"] alone but emits
// the map as it finds it, so a length assigned through the map is one the
// client counts and stdlib does not.
func oneContentLength(h http.Header) {
	keys, values, first := 0, 0, ""
	for k, v := range h {
		if !sameField(k, "Content-Length") {
			continue
		}
		keys, values = keys+1, values+len(v)
		if first == "" || k < first {
			first = k
		}
	}
	// nothing to settle: one scan, no allocation
	if keys == 0 || (keys == 1 && values <= 1 && first == "Content-Length") {
		return
	}
	var all []string
	for _, k := range fieldKeys(h, "Content-Length") {
		all = append(all, h[k]...)
		// the keys the values were read out of, not the canonical one h.Del reaches
		delete(h, k)
	}
	if len(all) == 0 {
		return
	}
	h["Content-Length"] = all[:1]
	for _, other := range all[1:] {
		if other != all[0] {
			log.Printf("borgo: %d Content-Length lines %q, keeping %q", len(all), all, all[0])
			return
		}
	}
}

// a trailer has no value yet at WriteHeader, where the snapshot is taken:
// clearing trailers with the rest dropped every one of a response short
// enough to commit in finish, and kept them on the same handler with a longer
// body
func takeTrailers(live, snapshot http.Header) http.Header {
	// a Trailer line the handler adds later is as late as any other header, here
	// and in net/http
	announced := snapshot["Trailer"]
	var out http.Header
	for k, v := range live {
		if !isTrailer(k, announced) {
			continue
		}
		if out == nil {
			out = make(http.Header, 1)
		}
		out[k] = v
	}
	return out
}

func isTrailer(key string, announced []string) bool {
	if strings.HasPrefix(key, http.TrailerPrefix) {
		return true
	}
	for _, line := range announced {
		for _, name := range strings.Split(line, ",") {
			if strings.EqualFold(strings.TrimSpace(name), key) {
				return true
			}
		}
	}
	return false
}

// the trailers go back after the header block, not before: a trailer shipped
// as a header is a different response again
func (g *gzipResponseWriter) sendHeader() {
	g.rw.WriteHeader(g.status)
	maps.Copy(g.rw.Header(), g.trailers)
	g.trailers = nil
}

// varyAcceptEncoding re-adds our Vary next to whatever the handler put there:
// a handler that Set "Vary: Cookie" dropped it, and a compressed body with no
// Vary: Accept-Encoding is one a shared cache hands to a client that may not
// decode it. Added, never substituted.
//
// The key is deliberately not folded, the one write here left canonical: Vary
// is a set of field names (RFC 9110 12.5.5), so a `vary` assigned through the
// map costs one repeated Accept-Encoding line and nothing else (measured on
// the wire, under both spellings). This guard can only repeat itself.
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
		return g.send(g.rw, p)
	}
	if g.gz != nil {
		return g.send(g.gz, p)
	}
	// only what the decision needs: appending the whole slice first copied a
	// second megabyte per megabyte served, on the identity path too
	split := min(len(p), max(gzipMinBytes-len(g.buf), 0))
	g.buf = append(g.buf, p[:split]...)
	g.written += int64(split)
	if len(g.buf) < gzipMinBytes {
		return len(p), nil
	}
	// both answers commit at the same byte, so a panic one byte later means the
	// same thing to either client
	if g.compress {
		g.startGzip()
	} else {
		g.startPassthrough(int64(len(p) - split))
	}
	n, err := g.writeCommitted(p[split:])
	return split + n, err
}

func (g *gzipResponseWriter) writeCommitted(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if g.gz != nil {
		return g.send(g.gz, p)
	}
	return g.send(g.rw, p)
}

// counts what the destination accepted, not what the handler offered: a
// connection refusing bytes is the one way a body comes up short without the
// handler at fault. Except ErrContentLength, the handler's own: net/http
// refuses whole the write that outgrows the declared length where startGzip
// has deleted that length, so counting it as offered keeps the two encodings
// reporting alike.
func (g *gzipResponseWriter) send(w io.Writer, p []byte) (int, error) {
	n, err := w.Write(p)
	switch {
	case err == nil:
		g.written += int64(n)
	case errors.Is(err, http.ErrContentLength):
		g.written += int64(len(p))
	default:
		g.written += int64(n)
		g.writeFailed = true
	}
	return n, err
}

// Flush lets streamed handlers deliver progressively: an active gzip writer
// is sync-flushed, a still-buffering response is committed as identity.
func (g *gzipResponseWriter) Flush() {
	if g.status == 0 {
		g.status = http.StatusOK
		g.declared = declaredLength(g.rw.Header())
	}
	if g.gz != nil {
		g.gz.Flush()
	} else if !g.passthrough {
		g.startPassthrough(0)
	}
	if f, ok := g.rw.(http.Flusher); ok {
		f.Flush()
	}
}

func (g *gzipResponseWriter) startGzip() {
	g.commitHeader()
	h := g.rw.Header()
	// sniff before compressing, gated on presence and not value, which is
	// net/http's own gate (`_, haveType := header["Content-Type"]`): an empty
	// field is how a handler turns sniffing off. The canonical key is enough only
	// because commitHeader has folded every other spelling onto it first
	if _, declared := h["Content-Type"]; !declared {
		h.Set("Content-Type", http.DetectContentType(g.buf))
	}
	// net/http logs a Content-Length it cannot parse, but only one it still
	// holds: deleting it below would silence that on the compressed path alone
	if v := h["Content-Length"]; len(v) > 0 && g.declared < 0 {
		log.Printf("borgo: invalid Content-Length of %q", v[0])
	}
	h.Del("Content-Length")
	h.Set("Content-Encoding", "gzip")
	g.sendHeader()
	if gz, ok := gzipWriters.Get().(*gzip.Writer); ok {
		gz.Reset(g.rw)
		g.gz = gz
	} else {
		g.gz = gzip.NewWriter(g.rw)
	}
	g.sendBuffered(g.gz)
}

// pending is what the Write forcing the commit still holds past the buffer:
// the handler's bytes already, so a length they outgrow is already wrong
func (g *gzipResponseWriter) startPassthrough(pending int64) {
	g.passthrough = true
	g.commitHeader()
	g.dropLengthShorterThan(g.written + pending)
	g.sendHeader()
	g.sendBuffered(g.rw)
}

// the buffer was already counted when the handler wrote it
func (g *gzipResponseWriter) sendBuffered(w io.Writer) {
	if len(g.buf) == 0 {
		return
	}
	counted := g.written
	g.send(w, g.buf)
	g.written = counted
	g.buf = nil
}

// finish is the single commit policy both encodings obey: a response already
// committed is truncated, never restated; below the commit point nothing is
// on the wire and the recovery above still owns it.
func (g *gzipResponseWriter) finish() {
	// emptied and pinned to passthrough: net/http already forbids using the
	// writer after the handler returns, but a late write would otherwise ship the
	// buffer a second time or open a fresh gzip stream nobody closes
	defer func() {
		g.buf = nil
		g.passthrough = true
	}()
	g.reportLengthMismatch()
	if g.gz != nil {
		if err := g.gz.Close(); err != nil {
			log.Printf("borgo: gzip close: %v", err)
		}
		// so the pool does not keep a finished request alive, and a write after the
		// handler returned cannot land in someone else's stream
		g.gz.Reset(io.Discard)
		gzipWriters.Put(g.gz)
		g.gz = nil
		return
	}
	if g.passthrough {
		return
	}
	if g.status == 0 || !g.complete {
		// nothing is on the wire yet: an empty 200, or a panic with a half-written
		// body still in the buffer. Committing that half would send a truncated 200
		// under a Content-Length that no longer matches; left uncommitted, the
		// recovery answers 500 (net/http still writes an empty 200 if nobody does)
		if g.status == 0 && g.complete {
			// a handler that returned without writing leaves net/http to ship its
			// implicit 200 out of the live header, the one road commitHeader never
			// reaches. A panic is excluded: the recovery restates the headers itself
			oneContentLength(g.rw.Header())
			g.dropLengthUnlessItDescribes(0)
		}
		return
	}
	g.commitHeader()
	g.dropLengthUnlessItDescribes(int64(len(g.buf)))
	g.sendHeader()
	// the outcome is not read: reportLengthMismatch has already spoken
	if len(g.buf) > 0 {
		g.rw.Write(g.buf)
	}
}

// dropLengthUnlessItDescribes removes a Content-Length that does not
// describe the n bytes about to go out: net/http refuses an over-long write
// whole, and the buffer coalesces what the handler wrote in pieces, so 400
// bytes under a declared 300 left the client zero where the same handler
// unwrapped got 300. Only where borgo still holds the commit: past it the
// handler has net/http's own error, which is the behaviour to match.
func (g *gzipResponseWriter) dropLengthUnlessItDescribes(n int64) {
	// a bodyless response legitimately describes the body it stands for while
	// writing none: HEAD is the shape that reaches here
	if g.bodyless {
		return
	}
	h := g.rw.Header()
	if declared := declaredLength(h); declared >= 0 && declared != n {
		h.Del("Content-Length")
	}
}

// the same rule at a commit the body has not finished (buffer overflow, a
// Flush): only a length the n bytes already written have outgrown is
// provably wrong. The header leaves in sendHeader, after this. No bodyless
// guard: HEAD, 204 and 304 commit with n zero. After commitHeader, not
// before: the commit restores the snapshot, undoing an earlier deletion, and
// folds every spelling onto the key h.Del reaches.
func (g *gzipResponseWriter) dropLengthShorterThan(n int64) {
	h := g.rw.Header()
	if declared := declaredLength(h); declared >= 0 && declared < n {
		h.Del("Content-Length")
	}
}

// reportLengthMismatch names a handler whose body is not the size it
// promised. The two encodings cannot answer alike: identity ships the length
// and net/http truncates or stalls, while startGzip has to delete it and
// repairs the bug in silence. This is the same line on both paths. Silent on
// a body no length described, one that matched, a bodyless status (the
// length describes the representation asked about), a panic, and a
// connection that stopped taking bytes.
func (g *gzipResponseWriter) reportLengthMismatch() {
	declared := g.declared
	if g.status == 0 {
		// no status was committed, so nothing has read the length yet: a handler
		// that declared one and wrote nothing leaves net/http to ship it over an
		// empty body, and the client waits for a body that never comes
		declared = declaredLength(g.rw.Header())
	}
	if declared < 0 || g.written == declared || g.bodyless || !g.complete {
		return
	}
	// a body that stopped short of a write error is the connection's doing:
	// every client that hangs up mid-download would otherwise be an application bug
	if g.writeFailed && g.written < declared {
		return
	}
	log.Printf("borgo: Content-Length %d but wrote %d bytes", declared, g.written)
}
