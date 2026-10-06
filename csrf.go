package borgo

import (
	"fmt"
	"mime"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// The /api half of borgo's csrf check. The bun front server used to run it
// before proxying; since the go front serves /api in process it runs here,
// before the handler. The action half stays in bun (csrfRejects in util.ts),
// which refuses a session without a readable token outright: a server action
// is only ever posted by a page borgo rendered.
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
		// a cookie-less client is not a browser this page armed - unless it
		// carries a session and a body a plain <form> can send: the csrf
		// cookie dies with the browser session while the session cookie
		// lives on, and since BindMultipart a form post reaches a handler
		// that reads it. A sibling subdomain posting one is the attacker
		// this file exists for (found by the verifier of phase 5)
		return r.Method == http.MethodPost && hasSessionCookie(r) && formSendable(r)
	}
	if expected == "" {
		return true
	}
	given := r.Header.Get(csrfHeader)
	return given == "" || !keysEqual(given, expected)
}

// needsCsrfToken: a session the /api guard arms for, holding no token to
// echo
func needsCsrfToken(r *http.Request) bool {
	_, present := csrfCookieValue(r)
	return !present && hasSessionCookie(r)
}

func hasSessionCookie(r *http.Request) bool {
	return len(r.CookiesNamed(sessionCookie)) > 0
}

// formSendable reports whether the body is one an HTML form can send
// cross-site without a preflight: the three CORS-safelisted types, and no
// type at all
func formSendable(r *http.Request) bool {
	ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	switch ct {
	case "", "multipart/form-data", "application/x-www-form-urlencoded", "text/plain":
		return true
	}
	return false
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
