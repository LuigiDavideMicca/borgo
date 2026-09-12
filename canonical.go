package borgo

import (
	"net/http"
	"path"
	"strings"
)

// One spelling per page, decided at the door.
//
// This is canonicalPath in packages/borgo/src/router.ts, mirrored: the render
// service has applied it since 0.21 because every alias the router accepted
// became its own page cache key - /ne%77s stored a second copy of /news, and
// a flood of spellings stored one render pair each (measured, 15 spellings ->
// 12 extra stored renders), while Revalidate("/news") dropped only the bare
// spelling and /news/ kept serving the pre-invalidation copy, under "manual"
// forever.
//
// It has to be here too, and not only there, because the cache moved here.
// The front keyed on the cleaned path and forwarded the path as written, so a
// single request for /news/ reached the render service, came back 308, and a
// 308 is unstorable: the refusal was recorded under the CANONICAL key and the
// real page was rendered per visitor for the rest of the window - forever for
// a "manual" page. One free unauthenticated request turned the cache off.
// Found by the verifier of phase 1.
//
// Answering the redirect here rather than forwarding it also keeps one rule
// for the whole app: an alias of a cacheable page and an alias of an ordinary
// page get the same 308, instead of one being answered 200 from a cache and
// the other redirected.
//
// The two halves must agree, so the rule is the rule there: only unreserved
// octets decode (rfc 3986 - %77 IS w), a kept triplet gets uppercase hex (the
// rfc's canonical form, so hex-case aliases collapse), %2F stays %2F because
// decoding it would change how many segments the path has, and a malformed
// escape passes through untouched. Go's server refuses a malformed escape
// before a handler sees it, but the mirror keeps the case so the tables match.
//
// Dot segments are this side's own addition: path.Clean resolves them, and it
// is also what collapses the slash runs and the trailing slash the mirror
// above would otherwise do by hand. A browser never sends "/x/../news", but
// the front is not only spoken to by browsers.
func canonicalPath(p string) string {
	if p == "" {
		return "/"
	}
	var b strings.Builder
	b.Grow(len(p))
	for i := 0; i < len(p); i++ {
		c := p[i]
		if c != '%' || i+2 >= len(p) || !isHexDigit(p[i+1]) || !isHexDigit(p[i+2]) {
			b.WriteByte(c)
			continue
		}
		triplet := p[i+1 : i+3]
		decoded := unhexDigit(triplet[0])<<4 | unhexDigit(triplet[1])
		if isUnreserved(decoded) {
			b.WriteByte(decoded)
		} else {
			b.WriteByte('%')
			b.WriteString(strings.ToUpper(triplet))
		}
		i += 2
	}
	return path.Clean(b.String())
}

func isHexDigit(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func unhexDigit(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}

// isUnreserved is rfc 3986 §2.3, which is UNRESERVED in router.ts.
func isUnreserved(c byte) bool {
	return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ||
		c == '-' || c == '.' || c == '_' || c == '~'
}

// redirectToCanonical answers the 308 when the request named an alias, and
// reports whether it did. Permanent, and method-preserving: a form action
// posted to an alias must arrive at the page, not as a GET.
func redirectToCanonical(w http.ResponseWriter, r *http.Request, canonical string) bool {
	if canonical == r.URL.EscapedPath() {
		return false
	}
	target := canonical
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	http.Redirect(w, r, target, http.StatusPermanentRedirect)
	return true
}
