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
	// at commit, by privateIfCookies again
	privateIfCookies(w.Header())
}

// privateIfCookies downgrades a `public` Cache-Control to `private` on a
// response that carries a Set-Cookie.
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
// So it runs again at header commit, where every cookie the handler set is
// staged whatever order they were set in. Idempotent, and it only ever narrows:
// a response with no cookie is untouched, and one already `private`, `no-store`
// or anything else is left as it is.
func privateIfCookies(h http.Header) {
	if len(h.Values("Set-Cookie")) == 0 {
		return
	}
	value := h.Get("Cache-Control")
	if value == "" {
		return
	}
	parts := strings.Split(value, ",")
	changed := false
	for i, part := range parts {
		// a whole directive, matched as one: directive names are
		// case-insensitive (RFC 9111 5.2), `publicish` is somebody else's
		// directive, and `public` can appear anywhere in the list, not only
		// first - a handler is free to write "max-age=60, public" by hand
		if !strings.EqualFold(strings.TrimSpace(part), "public") {
			continue
		}
		indent := part[:len(part)-len(strings.TrimLeft(part, " \t"))]
		parts[i] = indent + "private"
		changed = true
	}
	if changed {
		h.Set("Cache-Control", strings.Join(parts, ","))
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
