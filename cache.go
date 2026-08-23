package borgo

import (
	"fmt"
	"net/http"
	"net/textproto"
	"slices"
	"strings"
	"time"
)

// Cache marks the response publicly cacheable for maxAge. An optional
// staleWhileRevalidate window lets proxies serve stale content while they
// refresh in the background. A response that carries Set-Cookie is marked
// private instead, so shared caches never store it - in whichever order the
// handler calls the two.
func Cache(w http.ResponseWriter, maxAge time.Duration, staleWhileRevalidate ...time.Duration) {
	value := fmt.Sprintf("public, max-age=%d", clampSeconds(maxAge))
	if len(staleWhileRevalidate) > 0 {
		value += fmt.Sprintf(", stale-while-revalidate=%d", clampSeconds(staleWhileRevalidate[0]))
	}
	w.Header().Set("Cache-Control", value)
	// the cookie-first order; the cookie-second order is settled on the way out
	// of the handler, by privateIfCookies again
	privateIfCookies(w.Header())
}

// unbalancedQuoteAt returns the index of the double quote that opens a string
// the line never closes, or len(line) when every string is closed.
//
// From that quote on the line is split as if the quote were an ordinary
// character: a strict RFC 9110 reader sees one quoted string to the end of
// the line, a lenient comma-splitter (several CDNs) sees directives, and
// trusting the strict reading hid `s-maxage=600` in `x=", s-maxage=600` from
// the guard. Over-matching costs a redundant `private`; under-matching a session.
func unbalancedQuoteAt(line string) int {
	open, quoted, escaped := -1, false, false
	for i := 0; i < len(line); i++ {
		switch c := line[i]; {
		case escaped:
			escaped = false
		case quoted && c == '\\':
			escaped = true
		case c == '"':
			quoted = !quoted
			if quoted {
				open = i
			}
		}
	}
	if quoted {
		return open
	}
	return len(line)
}

// splitDirectives splits a Cache-Control line on the commas between
// directives, not on those inside a balanced quoted argument: the argument of
// no-cache and private is itself a comma-separated list of field names (RFC
// 9111 5.2.2.4), so `no-cache="a, public, b"` is one directive.
func splitDirectives(line string) []string {
	stop := unbalancedQuoteAt(line)
	var fields []string
	start, quoted, escaped := 0, false, false
	for i := 0; i < len(line); i++ {
		switch c := line[i]; {
		case escaped:
			escaped = false
		case quoted && c == '\\':
			escaped = true
		case c == '"' && i < stop:
			quoted = !quoted
		case c == ',' && !quoted:
			fields = append(fields, line[start:i])
			start = i + 1
		}
	}
	return append(fields, line[start:])
}

// case-insensitive (RFC 9111 5.2); matched by name so `publicish` and
// `x-public` stay somebody else's directive
func directiveName(field string) string {
	name, _, _ := strings.Cut(field, "=")
	return strings.TrimSpace(name)
}

// load-bearing for `private`: the qualified private="X" leaves the response
// storable by a shared cache (RFC 9111 5.2.2.7), so it does not satisfy the
// guard and a bare `private` is added beside it
func bareDirective(field string) bool {
	return !strings.Contains(field, "=")
}

func leadingSpace(field string) string {
	return field[:len(field)-len(strings.TrimLeft(field, " \t"))]
}

// reports whether a quoted argument runs across a boundary the header lines
// were joined at: the one shape where two readers partition the same response
// differently. stop is the unbalanced-quote cutoff, so this agrees with
// splitDirectives about which quotes open anything at all.
func quotedSpanCrossesALine(lines []string, value string, stop int) bool {
	if len(lines) < 2 {
		return false
	}
	boundary := make(map[int]bool, len(lines)-1)
	at := 0
	for _, line := range lines[:len(lines)-1] {
		at += len(line)
		boundary[at] = true
		at++ // the comma the join inserted, which is what sits at that index
	}
	quoted, escaped := false, false
	for i := 0; i < len(value); i++ {
		if quoted && boundary[i] {
			return true
		}
		switch c := value[i]; {
		case escaped:
			escaped = false
		case quoted && c == '\\':
			escaped = true
		case c == '"' && i < stop:
			quoted = !quoted
		}
	}
	return false
}

// canonicalisation maps case and nothing else, so a differing length is proof
// of a different field at one comparison. An invalid field name comes back from
// textproto unchanged and matches nothing; net/http will not write it either
func sameField(key, canonical string) bool {
	return len(key) == len(canonical) && textproto.CanonicalMIMEHeaderKey(key) == canonical
}

// under any spelling of the key: h.Values canonicalises the key it looks up,
// net/http's writer emits the map as it finds it, so a w.Header()["set-cookie"]
// = assignment reaches the wire and must reach the guard
func hasField(h http.Header, canonical string) bool {
	for k := range h {
		if sameField(k, canonical) {
			return true
		}
	}
	return false
}

// in the order net/http writes them: writeSubset sorts keys, so byte order is
// the order a cache joins the lines in (RFC 9110 5.3). Map order would decide
// a response by a hash seed.
func fieldKeys(h http.Header, canonical string) []string {
	var keys []string
	for k := range h {
		if sameField(k, canonical) {
			keys = append(keys, k)
		}
	}
	slices.Sort(keys)
	return keys
}

// privateIfCookies makes a response that carries a Set-Cookie say `private`,
// and takes away every directive that would let a shared cache store it:
// `public` becomes `private`, `s-maxage` is dropped, and if nothing then says
// `private` a bare one is added at the front. `max-age` is left alone: it is
// legitimate for a private cache, and `private` already bars the shared one.
// A bare `private` forbids shared storage on its own (RFC 9111 5.2.2.7), so
// `must-revalidate` needs no case; the qualified private="X" does not count.
// The redundant `private` next to a `no-store` is noise, and noise is the side
// to be wrong on: too narrow costs a cache miss, too wide hands one user's
// session to the next requester through a CDN, silently. The direction to
// test is a Set-Cookie response still advertising itself to a shared cache.
//
// Not called once in Cache but from every call site and on the way out of
// the handler, up to four times on one response: the order the handler calls
// Cache and SetSession in must not matter, and every pass must see the
// `private` the pass before it added.
//
// The added `private` goes at the front because it is the only position
// guaranteed not to sit inside a quoted string an earlier field left open.
//
// The fold over every spelling of the key costs one range over the header
// map on the cookieless response, and the matcher is free: measured 26ns to
// 57ns on a four-header response and 25ns to 253ns on a thirty-two-header
// one, no allocation. A gzip-eligible response already clones the same map
// at WriteHeader and re-copies it at commit.
//
// Not reached, each a decision:
//
//   - A response with no Cache-Control is left with none: a guard that invents
//     a policy for a handler that stated none is no longer narrowing. This is
//     not guaranteed safe - a shared cache may store such a response
//     heuristically; nothing in RFC 9111 bars storing Set-Cookie by itself.
//   - Anything the handler does after the last call-site guard on a mux borgo
//     does not own (see borgo.Middleware): no last moment exists there.
//   - 1xx: written immediately with the staged headers, cookie included, and
//     not stored by caches.
//   - Trailers: a Cache-Control under http.TrailerPrefix lives at another key.
//   - An empty list element (`public,,max-age=1`) is dropped, and only on a
//     response already being rewritten (RFC 9110 5.6.1.2: recipients ignore
//     it). A malformed non-empty one such as `=weird` is kept: a guard that
//     deletes what it cannot parse no longer only narrows.
func privateIfCookies(h http.Header) {
	if !hasField(h, "Set-Cookie") {
		return
	}
	keys := fieldKeys(h, "Cache-Control")
	var lines []string
	for _, k := range keys {
		lines = append(lines, h[k]...)
	}
	if len(lines) == 0 {
		return
	}

	// one value, not one per line: RFC 9110 5.3 makes the comma-join the value a
	// cache parses. Judged per line, a `private` on line three sat behind a quote
	// line two left open
	value := strings.Join(lines, ",")
	stop := unbalancedQuoteAt(value)

	var kept []string
	hasPrivate, changed := false, false
	offset := 0
	for _, f := range splitDirectives(value) {
		// a directive counts only if the whole of it lies before any unterminated quote
		readable := offset+len(f) <= stop
		offset += len(f) + 1 // the comma the split consumed
		switch name := directiveName(f); {
		case strings.EqualFold(name, "public"):
			kept = append(kept, leadingSpace(f)+"private")
			hasPrivate, changed = hasPrivate || readable, true
		case strings.EqualFold(name, "s-maxage"):
			changed = true
		case strings.TrimSpace(f) == "":
			// dropped only because this response is being rewritten anyway
		default:
			hasPrivate = hasPrivate || (readable && strings.EqualFold(name, "private") && bareDirective(f))
			kept = append(kept, f)
		}
	}
	if !hasPrivate {
		kept = append([]string{"private"}, kept...)
		changed = true
	}
	// the one exception to "unchanged means untouched", do not delete it: a
	// balanced quote spanning a line boundary is read as one argument by a reader
	// that joins the lines first and as a bare `public` by one that takes them one
	// at a time. Emitting the join says what the guard read. A multi-line value
	// with no span crossing a boundary comes back exactly as it arrived.
	if !changed && !quotedSpanCrossesALine(lines, value, stop) {
		return
	}

	// as the single value it was read as: the handler's line partition cannot be
	// restored once a quoted argument spans it
	var b strings.Builder
	for i, f := range kept {
		if i > 0 {
			b.WriteString(",")
			if leadingSpace(f) == "" {
				b.WriteString(" ") // whitespace only: OWS around a directive is not significant
			}
		}
		b.WriteString(f)
	}
	// the keys the value was read out of, not the canonical one h.Del reaches: a
	// `cache-control` left behind is one field with the rewritten one to a cache
	for _, k := range keys {
		delete(h, k)
	}
	if line := b.String(); strings.TrimSpace(line) != "" {
		h.Add("Cache-Control", line)
	}
}

// not int(d.Seconds()): on 32-bit a >68-year duration overflows into an
// implementation-defined value. int64 holds any duration's seconds exactly.
func clampSeconds(d time.Duration) int64 {
	if d < 0 {
		return 0
	}
	return int64(d / time.Second)
}

// NoCache marks the response as never cacheable - right for anything
// personalized or session-dependent.
func NoCache(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
}
