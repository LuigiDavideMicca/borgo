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
			declared: -1,
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
	trailers    http.Header // trailer values, held out of that header block
	buf         []byte
	gz          *gzip.Writer
	declared    int64 // Content-Length the handler set, -1 when it set none
	written     int64 // bytes the handler passed to Write
	compress    bool  // the client accepts gzip; only what a full buffer becomes
	bodyless    bool  // no body can exist: HEAD, 204, 304
	passthrough bool
	complete    bool
	writeFailed bool // the connection refused bytes; a short body is not the handler's
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
	// read the length here, before startGzip deletes it: that deletion is what
	// makes a wrong one invisible on the compressed path
	g.declared = declaredLength(h)
	g.bodyless = g.bodyless || bodylessStatus(status)
	if g.bodyless || declaresEventStream(h) || declaresEncoding(h) {
		g.startPassthrough()
	}
}

// firstFieldValue returns the field's first value on the wire, under whatever
// spelling of the key the handler used, or "" for none.
//
// h.Get and h.Values canonicalise the key they look up; net/http's writer
// canonicalises nothing and emits the map as it finds it, so a key assigned
// through the map is a field every reader sees (RFC 9110 5.1) and a canonical
// lookup does not.
//
// Byte order, not map order: writeSubset sorts the keys it emits, so the
// smallest holds the line that arrives first - the one a reader taking a single
// value takes. Map order would decide a response by a hash seed.
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

// declaresEventStream reports whether the response says it is an event stream,
// however the handler wrote that header.
//
// A header declared more than once is read whole, because reading only one of
// its values chooses by order. Header.Get returns the first line, so a handler
// that added text/plain before text/event-stream walked through this gate and
// borgo put Content-Encoding: gzip over a stream - which then reaches the
// browser in one piece at the end, the one thing a stream exists not to do.
// net/http decides on Content-Type by presence of the key and never by the
// value of one line, and every line the map holds goes on the wire, so every
// line has to be read here.
//
// Under every spelling of the key too: net/http reads this field only to decide
// whether to sniff and its answer never reaches the client, while the browser
// the stream is for folds the key. h.Values saw the canonical entry alone, so a
// text/event-stream assigned through the map got Content-Encoding: gzip over
// it. Any spelling settles the answer, so map order is never read into.
//
// A value is matched whole, after its parameters and case-insensitively: media
// types are case-insensitive (RFC 9110 8.3.1), and a single line holding two
// comma-separated values is what an intermediary makes of two Content-Type
// lines.
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

// declaresEncoding reports whether the response names a content coding - any
// value of the field, under any spelling of the key.
//
// Not the first value alone. net/http reads that one by Get, but its answer only
// decides whether to sniff a Content-Type, where borgo's decides whether to
// re-encode the body and overwrite the line describing it. On ["", "br"] - what
// Add("") before Add("br") produces - both read "", and only borgo is destroyed
// by it: it compressed the br bytes and h.Set deleted the br declaration, so a
// client that gunzips once holds br it takes for plaintext. Repeated lines are
// one list (RFC 9110 5.3), and a single value still reads as it did.
//
// An empty value names no coding, so a response carrying only empties still
// compresses.
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

// declaredLength reads the Content-Length the handler set, or -1 for none. A
// length that is not a number is also -1: net/http rejects and logs that one
// itself, and a second complaint about it would say nothing new - except where
// startGzip has deleted the header before net/http could read it, which is why
// that one place repeats it.
func declaredLength(h http.Header) int64 {
	// every spelling of the key: this reads what the response will carry, and
	// oneContentLength has yet to run wherever the answer is taken before commit
	n, err := strconv.ParseInt(firstFieldValue(h, "Content-Length"), 10, 64)
	if err != nil || n < 0 {
		return -1
	}
	return n
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
		g.trailers = takeTrailers(h, g.header)
		clear(h)
		maps.Copy(h, g.header)
	}
	varyAcceptEncoding(h)
	privateIfCookies(h)
	oneContentLength(h)
	// the two fields startGzip writes under the canonical key, folded before it
	// writes them - see foldFieldKey
	foldFieldKey(h, "Content-Encoding")
	foldFieldKey(h, "Content-Type")
}

// foldFieldKey moves every spelling of a field onto its canonical key, keeping
// the values in the order their lines reach the wire.
//
// A GUARD THAT WRITES UNDER THE CANONICAL KEY WRITES BESIDE A SPELLING IT DID
// NOT FOLD, NOT OVER IT. h.Set replaces h["Content-Encoding"] and leaves
// h["CONTENT-ENCODING"] where it is, and writeSubset sorts the keys it emits,
// so the survivor can arrive first. Measured: a handler assigning
// h["CONTENT-ENCODING"] = [""] had borgo compress - correctly, an empty value
// names no coding - and ship `CONTENT-ENCODING: ` ahead of its own
// `Content-Encoding: gzip`, so a client reading the first value found none and
// took 42 bytes of gzip for text. Bare net/http hands the same handler's 4096
// plaintext bytes back whole. Content-Type breaks the other way round: borgo's
// sniffed line sorts ahead of a lowercase `content-type`, and the handler's
// text/html reached an identity client while a gzip client got text/plain.
//
// No value is dropped and none is reordered: this collapses keys, and every
// decision about values was already taken by the guards that read them.
// Normalising here rather than at each gate is what 29428b1 did for
// Content-Length: the reads downstream, net/http's own included, stay canonical
// and stay correct.
func foldFieldKey(h http.Header, canonical string) {
	scattered := false
	for k := range h {
		if k != canonical && sameField(k, canonical) {
			scattered = true
			break
		}
	}
	// the response spelling it canonically, or not at all, pays one scan and no
	// allocation
	if !scattered {
		return
	}
	var all []string
	for _, k := range fieldKeys(h, canonical) {
		all = append(all, h[k]...)
		delete(h, k)
	}
	// assigned even when empty: a present key with no value is how a handler
	// turns net/http's sniffing off, and folding must carry that across too
	h[canonical] = all
}

// oneContentLength leaves the response the single Content-Length its body was
// already sized by. Both lines of a handler that Adds a second one reach the
// wire, and RFC 9110 8.6 has a recipient treat contradictory ones as
// unrecoverable: net/http's Transport drops the connection and delivers no
// status, while above the buffer startGzip deletes them all - the same correct
// body reaching a gzip client and no identity client at all.
//
// The first value is the one already in force, since net/http sizes the body by
// it: keeping it states the choice the response has made rather than making
// one, where keeping the last would contradict the bytes being sent. Identical
// repeats are legal to a client and pass without a word.
//
// EVERY SPELLING, MOVED ONTO THE CANONICAL KEY. net/http sizes the body by
// h["Content-Length"] alone but emits the map as it finds it, so a length
// assigned through the map is a line the client counts and stdlib does not -
// stdlib puts its own beside it, and the Transport then delivers no status and
// no body at all, on all four crossings. Above the buffer it was worse:
// startGzip deleted the canonical one and left that one describing the
// uncompressed body, unmaking for the gzip client alone a response stdlib
// delivers whole. Normalising here keeps every later read canonical, net/http's
// own included.
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
	// the response that has nothing to settle pays one scan and no allocation
	if keys == 0 || (keys == 1 && values <= 1 && first == "Content-Length") {
		return
	}
	var all []string
	for _, k := range fieldKeys(h, "Content-Length") {
		all = append(all, h[k]...)
		// the keys the values were read out of, not the canonical one h.Del
		// reaches, or the kept line would sit beside the ones it replaces
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

// takeTrailers collects the trailers the handler has set so far, which the
// snapshot restore must not take with it.
//
// A trailer is read out of the header map after the handler returns, so at
// WriteHeader - where the snapshot is taken - none of them has a value yet.
// Clearing them with the rest dropped every trailer of a response short enough
// to commit in finish, while the same handler with a longer body committed
// mid-Write and kept the ones set after that point: the response deciding
// itself on a byte count the handler never sees, which is the one thing the
// snapshot is here to prevent.
func takeTrailers(live, snapshot http.Header) http.Header {
	// only the announcement being committed counts: a Trailer line the handler
	// adds later is as late as any other header, here and in net/http
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

// isTrailer reports whether a header key holds a trailer rather than a header:
// either the TrailerPrefix spelling, which needs no announcement, or a name the
// response announced in Trailer.
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

// sendHeader commits the status, then puts the trailers back in the map the
// response reads them from at the end. They go back after the header block and
// not before, because a trailer shipped as a header is a different response
// again - and which one the client got would once more depend on whether the
// commit happened before or after the handler set it.
func (g *gzipResponseWriter) sendHeader() {
	g.rw.WriteHeader(g.status)
	maps.Copy(g.rw.Header(), g.trailers)
	g.trailers = nil
}

// varyAcceptEncoding keeps our Vary on the response next to whatever the
// handler put there. The middleware sets it before the handler runs, but a
// handler that Set or Del'd Vary of its own - "Vary: Cookie" on
// session-dependent content is ordinary - dropped it, and a compressed body
// with no Vary: Accept-Encoding is one a shared cache hands to the next client
// along, which may have no way to decode it. Added, never substituted: the
// handler's own reasons for varying outlive ours.
//
// The key is not folded, and this is the one write here left canonical. Vary is
// a set of field names (RFC 9110 12.5.5), so a `vary` assigned through the map
// costs one repeated Accept-Encoding line and nothing else - measured on the
// wire and at the client, with the handler's own `*` or `Cookie` still in force
// beside it. This guard can only repeat itself, never under-add, where an
// unfolded Content-Encoding cost the response.
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
	g.written += int64(len(p))
	if g.passthrough {
		return g.noteWrite(g.rw.Write(p))
	}
	if g.gz != nil {
		return g.noteWrite(g.gz.Write(p))
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
		return g.noteWrite(g.gz.Write(p))
	}
	return g.noteWrite(g.rw.Write(p))
}

// noteWrite remembers that the destination refused bytes, which is the one way
// a body can come up short without the handler being at fault.
func (g *gzipResponseWriter) noteWrite(n int, err error) (int, error) {
	if err != nil {
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
		g.startPassthrough()
	}
	if f, ok := g.rw.(http.Flusher); ok {
		f.Flush()
	}
}

func (g *gzipResponseWriter) startGzip() {
	g.commitHeader()
	h := g.rw.Header()
	// sniff before compressing: net/http would otherwise see gzip bytes. The
	// gate is presence and not value, which is net/http's own gate
	// (`_, haveType := header["Content-Type"]`): declaring the field empty is
	// how a handler turns sniffing off, and reading the first value alone both
	// overrode that and replaced a second, real value standing behind it - so
	// the same handler was typed one way for a client that asked for gzip and
	// another for a client that did not. The canonical key is enough only
	// because commitHeader has folded every other spelling onto it first
	if _, declared := h["Content-Type"]; !declared {
		h.Set("Content-Type", http.DetectContentType(g.buf))
	}
	// net/http names a Content-Length it cannot parse, but only one it still
	// holds. Deleting it here takes that complaint away from the compressed
	// path alone: the same handler was named for a client sending identity and
	// passed over for one sending gzip - the very split this file reports for a
	// length that is merely wrong, in the one spelling that reached the wire
	// without it. Below the buffer nothing is deleted and net/http still speaks,
	// so this says it exactly where it would otherwise be lost.
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
	g.noteWrite(g.gz.Write(g.buf))
	g.buf = nil
}

func (g *gzipResponseWriter) startPassthrough() {
	g.passthrough = true
	g.commitHeader()
	g.sendHeader()
	if len(g.buf) > 0 {
		g.noteWrite(g.rw.Write(g.buf))
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
	g.reportLengthMismatch()
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
		if g.status == 0 && g.complete {
			// a handler that returned without writing or committing leaves
			// net/http to ship its implicit 200 out of the live header, which
			// is the one road commitHeader never reaches. A panic is excluded:
			// the recovery restates the headers itself
			oneContentLength(g.rw.Header())
			g.dropLengthUnlessItDescribes(0)
		}
		return
	}
	g.commitHeader()
	g.dropLengthUnlessItDescribes(int64(len(g.buf)))
	g.sendHeader()
	if len(g.buf) > 0 {
		g.rw.Write(g.buf)
	}
}

// dropLengthUnlessItDescribes removes a Content-Length that does not describe
// the n bytes about to go out, which is the rule startGzip already applies to
// compressed bytes, reaching here because the buffer made it necessary here too.
//
// net/http refuses an over-long write whole rather than truncating it, and the
// buffer had coalesced into one write what the handler wrote in pieces: 400
// bytes under a declared 300 left the client zero, where the same handler
// unwrapped got 300 and a usable response. A short body, and a length declared
// over nothing written, stall the client the same way.
//
// Only where borgo still holds the commit: past it the header has gone and the
// handler has net/http's own error, which is the behaviour to match, not undo.
// reportLengthMismatch still names the handler; this stops the client paying.
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

// reportLengthMismatch names a handler whose body is not the size it promised.
//
// The two encodings cannot be made to answer that handler alike: identity ships
// the declared length and net/http then truncates or stalls the body, which the
// client reads as "unexpected EOF", while startGzip has to delete the header -
// it describes the uncompressed body and would be wrong over compressed bytes -
// and so repairs the same bug in silence. Aligning them on the wire would mean
// sending one client a response we know to be wrong. What is left is to stop
// the silence: the handler is at fault either way, and this is the same line on
// both paths, so the developer whose browser asks for gzip sees what the health
// check and curl have been seeing.
//
// It says nothing about a response that is merely unusual. A body that no
// Content-Length described, one that matched, one on a status that carries no
// body at all (net/http drops that body, so whatever the counter holds never
// described what the client received, while the length still describes the
// representation the request asked about), one cut short by a panic, and one
// cut short because the connection stopped taking bytes are all correct, or at
// least not this defect, and none of them is worth a line.
func (g *gzipResponseWriter) reportLengthMismatch() {
	declared := g.declared
	if g.status == 0 {
		// no status was ever committed, so nothing has read the length yet: a
		// handler that declared one and returned without writing a byte leaves
		// net/http to ship it under an implicit 200 over an empty body, and the
		// client waits for a body that was never coming. Read here, that lands
		// on both encodings at once - with nothing written there is nothing to
		// compress, so neither path had reached WriteHeader
		declared = declaredLength(g.rw.Header())
	}
	if declared < 0 || g.written == declared || g.bodyless || !g.complete {
		return
	}
	// a body that stopped short of a write error is the connection's doing; the
	// handler that checks Write and returns - io.Copy, http.ServeContent - is
	// the well-behaved one, and every client that hangs up mid-download would
	// otherwise be reported as an application bug
	if g.writeFailed && g.written < declared {
		return
	}
	log.Printf("borgo: Content-Length %d but wrote %d bytes", declared, g.written)
}
