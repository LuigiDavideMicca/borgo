package borgo

import (
	"fmt"
	"net/http"
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
	// the cookie-first order, settled here; the cookie-second order is settled
	// on the way out of the handler, by privateIfCookies again
	privateIfCookies(w.Header())
}

// unbalancedQuoteAt returns the index of the double quote that opens a string
// the line never closes, or len(line) when every string is closed.
//
// An unterminated quote is the one place the two plausible readings of a
// Cache-Control line disagree about something that matters. A strict RFC 9110
// reader treats everything after it as one quoted string running to the end of
// the line; a lenient comma-splitter, which is what several CDNs actually do,
// sees ordinary directives. Trusting the strict reading hid `s-maxage=600` from
// the guard in `x=", s-maxage=600` while a lenient cache read it and obeyed it.
// So the quote does not open a string at all: from here on the line is split as
// though it were an ordinary character. Over-matching costs a redundant
// `private`; under-matching costs a session.
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

// splitDirectives splits a Cache-Control line on the commas that separate
// directives, leaving the commas inside a balanced quoted argument alone.
//
// The argument of no-cache and private is itself a comma-separated list of
// header field names (RFC 9111 5.2.2.4), so `no-cache="a, public, b"` is one
// directive naming three fields, not three directives. Splitting it blindly
// rewrote the handler's stored `public` header field into a `private` field
// that does not exist, and left the response no longer revalidating the one it
// meant - all of it paid for coverage that was not even achieved, since
// `no-cache="a, public"` came back untouched: the trailing quote stayed glued
// to the token and the whole-directive match failed.
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

// directiveName is a directive's name, without its argument or surrounding
// whitespace. Names are case-insensitive (RFC 9111 5.2), and matching the name
// rather than the whole field is what keeps `publicish` and `x-public`
// somebody else's directive.
func directiveName(field string) string {
	name, _, _ := strings.Cut(field, "=")
	return strings.TrimSpace(name)
}

// bareDirective reports whether a field is a directive name on its own, with no
// ="argument" after it. The distinction is load-bearing for `private`: the
// qualified form private="X" makes only the named header fields private and
// leaves the response as a whole storable by a shared cache (RFC 9111 5.2.2.7),
// so it does not satisfy this guard and a bare `private` is added beside it.
func bareDirective(field string) bool {
	return !strings.Contains(field, "=")
}

// leadingSpace is the whitespace a field is indented by, kept so a rewritten
// directive lands in the same shape as the one it replaced.
func leadingSpace(field string) string {
	return field[:len(field)-len(strings.TrimLeft(field, " \t"))]
}

// quotedSpanCrossesALine reports whether a quoted argument in the joined value
// runs across one of the boundaries the header lines were joined at - the one
// shape where two readers partition the same response differently. stop is the
// unbalanced-quote cutoff the rest of the guard reads by, so this agrees with
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

// privateIfCookies makes a response that carries a Set-Cookie say `private`,
// and takes away every directive that would let a shared cache store it.
//
// This used to be a one-shot test inside Cache, which made the guard depend on
// the order the handler happened to call things in: `Cache` before
// `SetSession` saw no cookie yet and emitted `public`, and the session cookie
// was then added to a response that had just told every shared cache it was
// free to store and re-serve it. RFC 9111 3.5 is explicit that `public` is one
// of the directives that authorises a shared cache to store a Set-Cookie
// response, so this is not a theoretical grade of wrong: it is the exact
// combination that hands one user's session to the next requester through a
// CDN. A comment saying "set cookies first" is not a guard - it is a guard's
// absence, written down.
//
// THE RULE. On a response carrying a Set-Cookie and saying anything at all
// about caching: `public` becomes `private`, `s-maxage` is dropped, and if
// nothing then says `private`, `private` is added. `max-age` is left alone
// deliberately, and that is not an oversight - it is legitimate and useful for
// a private cache, and `private` beside it already bars the shared one.
//
// `s-maxage` had to join `public` because 3.5 lists it too: it is by definition
// the directive addressed to shared caches, so `s-maxage=600, max-age=60` on a
// response with a session cookie shipped exactly the authorisation the guard
// exists to remove, and the guard could not see it. Dropping it also settles a
// contradiction the guard used to manufacture out of `public, s-maxage=600`:
// `private, s-maxage=600` tells shared caches both that they may not store the
// response and how long to keep it.
//
// Adding `private` when nothing else says it is what makes the rule one
// sentence with no exceptions to remember. It is also why `must-revalidate` -
// the third directive 3.5 lists - needs no case of its own: a bare `private` is
// itself a prohibition on shared storage (5.2.2.7), so once one is present
// nothing else in the list can authorise one. Bare is the whole of it: the
// qualified private="X" that the same section defines makes only the named
// header fields private and leaves the response storable by a shared cache, so
// it satisfies nothing here and a bare `private` is added beside it. The cost
// is a redundant `private` next to a `no-store` that already forbade
// everything; that is noise, and noise is the side to be wrong on.
//
// The added `private` goes at the front of the whole value, and that position
// is not cosmetic: it is the only place guaranteed not to sit inside a quoted
// string some earlier field left open. An unterminated quote swallows
// everything after it under a strict reader, and it swallowed both the
// `private` this adds and the one a downgraded `public` becomes.
//
// ONE VALUE, NOT ONE PER LINE. Everything here is decided against the
// comma-join of every Cache-Control line, because RFC 9110 5.3 makes that join
// the value and it is what a cache parses. Reading line by line was wrong twice
// over and in the same shape both times: first h.Get, which saw only the first
// line, and then a per-line reachability test, which let a `private` on a later
// line satisfy the guard while an earlier line's unterminated quote hid it from
// every strict reader. The result is emitted as the one value it was read as -
// the handler's line partition cannot be restored once a quoted argument is
// found to span it, and re-deriving one would be the same reasoning again.
//
// Nothing is deleted that the guard is not there to remove. It used to read
// h.Get - the first line only - and write h.Set, which replaces all of them:
// `["public, max-age=60", "no-store"]` came out as `["private, max-age=60"]`,
// dropping a no-store the handler asked for so a private cache could now store
// what the handler forbade storing.
//
// Idempotent, and that has to be checked against the same value the guard reads
// rather than assumed: this runs up to four times on one response, and while
// the added `private` was placed per line but judged per line too, each pass
// declined to see the one the pass before it had added and prepended another.
//
// HOW THIS FAILS IF IT IS WRONG. The two directions are not the same size. Too
// narrow costs a cache miss; too wide hands one user's session cookie to the
// next requester through a CDN, unrecoverable and silent. Every choice here is
// resolved towards `private` for that reason, including the redundant one
// above. The direction to test is a response that carries Set-Cookie and still
// advertises itself to a shared cache - not one that got `private` when it
// wanted `public`.
//
// WHAT IT DOES NOT REACH, each a decision and not an accident:
//
//   - A response with no Cache-Control at all is left with none. A guard that
//     invents a caching policy for a handler that stated none is no longer
//     narrowing, and a Set-Cookie response with no directives is already
//     unstorable by a shared cache under 3.5.
//   - Anything the handler does after the last call-site guard, on a mux borgo
//     does not own. See borgo.Middleware: on such a mux there is no last
//     moment, so this is a boundary and not a bug to chase.
//   - 1xx. net/http writes an informational response immediately and both
//     borgo wrappers hand it straight through, precisely so Early Hints arrive
//     before the body; the staged headers go with it, cookie included. 1xx are
//     not stored by caches (RFC 9111 3 stores final responses), so this is a
//     gap with nothing behind it.
//   - Trailers. A Cache-Control staged under http.TrailerPrefix lives at a
//     different map key and is invisible here. Stock net/http gives the same
//     answer; a trailer is not where a cache reads freshness from.
//   - Header maps written through directly, w.Header()["cache-control"] = or
//     ["set-cookie"] =. h.Values canonicalises the key it looks up and
//     net/http's writer does not, so such an entry is unreachable from the
//     Header API this guard is written against. borgo's own API never does it.
//   - An empty list element - the `,,` in "public,,max-age=1" - is dropped
//     rather than re-emitted. RFC 9110 5.6.1 says senders must not generate one
//     and recipients ignore it, so nothing is lost; it happens only on a
//     response the guard was already rewriting, because tidying is not a reason
//     to touch a response. Only a genuinely blank element goes. A malformed but
//     non-empty one such as `=weird` is kept and passed through: it briefly was
//     not, because its directive name parses as empty and it fell into the same
//     arm, and a guard that deletes what it cannot parse is not a guard that
//     only narrows.
func privateIfCookies(h http.Header) {
	if len(h.Values("Set-Cookie")) == 0 {
		return
	}
	lines := h.Values("Cache-Control")
	if len(lines) == 0 {
		return
	}

	// one value, not one per line. RFC 9110 5.3 makes repeated field lines
	// equivalent to their comma-join, and the join is what a cache parses, so
	// it is what gets read and what the answer is placed against. Deciding
	// per line put a `private` on the third line of a response whose second
	// line left a quote open, where no strict reader could reach it
	value := strings.Join(lines, ",")
	// from an unterminated quote onward nothing is reachable, wherever the line
	// boundaries happened to fall
	stop := unbalancedQuoteAt(value)

	var kept []string
	hasPrivate, changed := false, false
	offset := 0
	for _, f := range splitDirectives(value) {
		// conservative: a directive counts only if the whole of it lies before
		// any unterminated quote
		readable := offset+len(f) <= stop
		offset += len(f) + 1 // the comma the split consumed
		switch name := directiveName(f); {
		case strings.EqualFold(name, "public"):
			kept = append(kept, leadingSpace(f)+"private")
			hasPrivate, changed = hasPrivate || readable, true
		case strings.EqualFold(name, "s-maxage"):
			changed = true
		case strings.TrimSpace(f) == "":
			// an empty list element carries no directive; dropped only because
			// this response is being rewritten anyway
		default:
			hasPrivate = hasPrivate || (readable && strings.EqualFold(name, "private") && bareDirective(f))
			kept = append(kept, f)
		}
	}
	if !hasPrivate {
		kept = append([]string{"private"}, kept...)
		changed = true
	}
	// "unchanged means untouched" has exactly one exception, and it is not an
	// inconsistency with the rule beside it - do not delete this condition.
	//
	// The guard already refuses to trust the strict reading of an unterminated
	// quote, on the grounds that a lenient comma-splitter sees ordinary
	// directives there and under-matching costs a session. A balanced quote
	// that spans a line boundary is the same disagreement wearing the other
	// hat: only a reader that joins every line first can tell that the `public`
	// alone on line two is inside the argument opened on line one, and a reader
	// that takes the lines one at a time sees a bare `public` on a response
	// carrying a session cookie. Emitting the join is the guard saying, in the
	// one shape where it matters, what it read - so a reader cannot arrive at a
	// different answer by partitioning the value differently from us.
	//
	// It is deliberately this narrow. A multi-line value with no quoted span
	// crossing a boundary is one every reader partitions the same way, so it
	// comes back exactly as it arrived, and cookieless responses never reach
	// here at all.
	if !changed && !quotedSpanCrossesALine(lines, value, stop) {
		return
	}

	// emitted as the single value it was read as: the line partition the
	// handler happened to use cannot be restored once a quoted argument is
	// found to span it, and re-deriving one would be the per-line reasoning
	// this function no longer does
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
	h.Del("Cache-Control")
	if line := b.String(); strings.TrimSpace(line) != "" {
		h.Add("Cache-Control", line)
	}
}

// clampSeconds converts a duration to whole seconds without going through a
// platform-sized int: on 32-bit, int(d.Seconds()) of a >68-year duration
// overflows into an implementation-defined value (typically negative), turning
// the header into garbage. int64 holds any duration's seconds exactly.
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
