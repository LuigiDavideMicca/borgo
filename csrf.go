package borgo

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// The /api half of borgo's csrf check, on the go side. The bun front server
// has always run it before proxying (apiCsrfRejects in util.ts); in front
// mode /api never passes through bun, so the same check runs here, before
// the handler. Mirrored line for line rather than shared: the two must agree
// while both exist, and the test suite says so.
//
// One double-submit token: a cookie minted on rendered pages, echoed in the
// X-CSRF-Token header by a call a page's script makes. A form cannot set the
// header and a cross-site fetch that does is preflighted without CORS
// approval. The attacker this closes is same-site cross-origin - a sibling
// subdomain - whom SameSite=Lax does not stop and who can also toss a
// duplicate cookie: hence the check is armed by the cookie's PRESENCE, not
// by a readable value, and an unreadable token refuses. No body is ever
// read: a refused request costs the handler nothing.

const (
	csrfCookie = "borgo_csrf"
	csrfHeader = "X-CSRF-Token"
)

// csrfEnforced reads BORGO_CSRF with the ParseBool grammar: unset is on in
// production and off in dev (BORGO_DEV), the rule bun applies.
func csrfEnforced() (bool, error) {
	if v := os.Getenv("BORGO_CSRF"); v != "" {
		on, err := strconv.ParseBool(v)
		if err != nil {
			return false, fmt.Errorf(`borgo: BORGO_CSRF: invalid value %q (want "1"/"true" or "0"/"false"; unset means on in production, off in dev)`, v)
		}
		return on, nil
	}
	if v := os.Getenv("BORGO_DEV"); v != "" {
		dev, err := strconv.ParseBool(v)
		if err != nil {
			return false, fmt.Errorf(`borgo: BORGO_DEV: invalid value %q (want "1"/"true" or "0"/"false")`, v)
		}
		return !dev, nil
	}
	return true, nil
}

// unsafeMethod is RFC 9110 §9.2.1's complement: anything but the safe set
// may change state and carries the token.
func unsafeMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodTrace:
		return false
	}
	return true
}

// csrfCookieValue reads the token; duplicates that disagree read as "", the
// same as the session's rule for two cookies that both verify - nothing here
// can break the tie, and guessing may echo one an attacker planted.
//
// Textual, like bun's csrfCookieValue, and not r.CookiesNamed: net/http
// drops a cookie whose value fails RFC 6265, so a tossed `borgo_csrf=a b`
// beside the real token would be invisible here and a disagreeing duplicate
// there - and the two halves must give one verdict (found by the verifier).
func csrfCookieValue(r *http.Request) (value string, present bool) {
	for _, header := range r.Header.Values("Cookie") {
		for _, part := range strings.Split(header, ";") {
			name, found, ok := strings.Cut(part, "=")
			if !ok || strings.TrimSpace(name) != csrfCookie {
				continue
			}
			found = strings.TrimSpace(found)
			if present && found != value {
				return "", true
			}
			value, present = found, true
		}
	}
	return value, present
}

// apiCsrfRejects is the verdict: true means answer 403 and run nothing.
func apiCsrfRejects(r *http.Request) bool {
	if !unsafeMethod(r.Method) {
		return false
	}
	expected, present := csrfCookieValue(r)
	if !present {
		return false // a cookie-less client is not a browser this page armed
	}
	if expected == "" {
		return true
	}
	given := r.Header.Get(csrfHeader)
	return given == "" || !keysEqual(given, expected)
}

// csrfMiddleware guards the public /api path in front mode.
func csrfMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if apiCsrfRejects(r) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, "invalid csrf token")
			return
		}
		next.ServeHTTP(w, r)
	})
}
