package borgo

import (
	"fmt"
	"net/http"
	"path"
	"regexp"
	"strings"
)

var percentEncoded = regexp.MustCompile(`%[0-9A-Fa-f]{2}`)

// The app's own middleware: api/middleware.go.
//
// borgo had authentication and no authorization. A role could not live in
// the session (nothing revokes it) nor outside it (nothing ran before the
// handler). This is the place outside: one function with the shape every Go
// developer already writes, which borgogen finds in package api and registers
// in borgo.gen.go beside the routes -
//
//	var Matcher = []string{"/api/admin/*", "/app/*"}
//
//	func Middleware(next http.Handler) http.Handler { ... }
//
// Where it runs is the design, and each position has its failure direction:
//
//   - after the internal names, /healthz and /metrics. A middleware that
//     blocks bots and answers a probe 403 restarts the container in a loop.
//   - after the redirect to a page's one spelling, and matched on the cleaned
//     path, so /api//admin cannot slip past /api/admin/*.
//   - before /api, static files, the page cache and the render service. A
//     cached copy served before the middleware is an authorization bypassed.
//   - on the internal listener too, where loaders call the api: otherwise a
//     loader reaches /api/admin without meeting the rule the browser meets.
//   - inside a recover: a middleware that panics answers 500, and the handler
//     behind it is never reached by falling through.
type appMiddleware struct {
	wrap    func(http.Handler) http.Handler
	matcher []string
}

// registered is the app's middleware, at most one; guarded by routesMu,
// latched by served like the routes.
var registered *appMiddleware

// UseMiddleware registers the app's middleware, and a Matcher naming the
// paths it covers; nil or empty covers everything the front does not answer
// itself. borgogen generates the call from api/middleware.go - an app writes
// the function and the variable, not this.
//
// A matcher entry is an absolute path, optionally ending in "/*" (the path
// and everything below it) or "*" (a prefix): the grammar Revalidate already
// takes. Anything else is refused here, at registration, with the value: a
// matcher that silently matched nothing would be a guard that guards nothing.
func UseMiddleware(mw func(http.Handler) http.Handler, matcher []string) {
	if mw == nil {
		panic("borgo.UseMiddleware: nil middleware")
	}
	for _, m := range matcher {
		if reason := matcherRefusal(m); reason != "" {
			panic(fmt.Sprintf("borgo.UseMiddleware: matcher %q %s", m, reason))
		}
	}
	routesMu.Lock()
	defer routesMu.Unlock()
	if served {
		panic("borgo.UseMiddleware: registered after borgo.Serve: the server is already mounted, so this middleware would never run; register it in init() or before calling Serve")
	}
	if registered != nil {
		panic("borgo.UseMiddleware: a middleware is already registered; compose them inside api/middleware.go, where their order is visible")
	}
	registered = &appMiddleware{wrap: mw, matcher: append([]string(nil), matcher...)}
}

func matcherRefusal(m string) string {
	switch {
	case m == "":
		return "is empty"
	case !strings.HasPrefix(m, "/"):
		return "must be an absolute path starting with /"
	case strings.Contains(strings.TrimSuffix(m, "*"), "*"):
		return `may only end in "*" or "/*"; a wildcard anywhere else is not supported`
	case strings.ContainsAny(m, "?#"):
		return "is matched against the path alone, without a query or a fragment"
	case percentEncoded.MatchString(m):
		// r.URL.Path is decoded, so an encoded entry compared against it could
		// never match (found by the verifier of phase 2)
		return "is matched against the decoded path: write the characters themselves, /città and not /citt%C3%A0"
	case m != "/" && !strings.HasSuffix(m, "*") && strings.HasSuffix(m, "/"):
		// covers compares the cleaned path, which never ends in a slash:
		// /api/admin/ - ServeMux's spelling of a subtree - guarded nothing
		// at all (found by the verifier of hunt 3's fixes)
		// the spellings offered are clean ones: trimmed, /api//admin/ offered
		// /api//admin, refused in turn, and // offered "" (found by the
		// verifier of this fix)
		clean := path.Clean(m)
		return "ends in a slash, and a path is matched cleaned, without one: write " + clean + " for that path, or " + strings.TrimSuffix(clean, "/") + "/* for it and everything below"
	case path.Clean(strings.TrimSuffix(strings.TrimSuffix(m, "*"), "/")) != strings.TrimSuffix(strings.TrimSuffix(m, "*"), "/") && strings.TrimSuffix(strings.TrimSuffix(m, "*"), "/") != "":
		return "is not a clean path: requests are matched after dot segments and doubled slashes are resolved, so this entry could never match"
	}
	return ""
}

// covers answers whether the middleware applies to a cleaned request path.
func (a *appMiddleware) covers(cleaned string) bool {
	if len(a.matcher) == 0 {
		return true
	}
	for _, m := range a.matcher {
		switch {
		case strings.HasSuffix(m, "/*"):
			base := strings.TrimSuffix(m, "/*")
			if base == "" || cleaned == base || strings.HasPrefix(cleaned, base+"/") {
				return true
			}
		case strings.HasSuffix(m, "*"):
			if strings.HasPrefix(cleaned, strings.TrimSuffix(m, "*")) {
				return true
			}
		default:
			if cleaned == m {
				return true
			}
		}
	}
	return false
}

// registeredMiddleware is the app's middleware, or nil.
func registeredMiddleware() *appMiddleware {
	routesMu.Lock()
	defer routesMu.Unlock()
	return registered
}

// withAppMiddleware puts the app's middleware in front of next for the paths
// it covers. The wrapped chain is built once, not per request, and sits
// inside a recover of its own: on the page path nothing else would turn its
// panic into a 500.
func withAppMiddleware(app *appMiddleware, next http.Handler) http.Handler {
	if app == nil {
		return next
	}
	guarded := recoverMiddleware(app.wrap(next))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if app.covers(path.Clean(r.URL.Path)) {
			guarded.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}
