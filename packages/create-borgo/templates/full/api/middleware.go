package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// The paths this middleware stands in front of. Without Matcher it would
// cover everything the app serves: api routes, pages, files, the websocket
// handshake and the loaders' own api calls. Entries are matched on the
// cleaned path, so /x/../account cannot slip past.
var Matcher = []string{"/account", "/api/me"}

// One function in the shape every Go developer writes, found by borgogen
// and registered beside the routes. It runs before the page cache and
// before middleware.ts, with the session borgo already verified: what it
// decides, the handler and the page read instead of deciding again -
// borgo.Forward hands a value on to middleware.ts and the loaders as
// `locals`, borgo.With keeps it on the Go side only.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if me, ok := borgo.GetSession[Me](r); ok {
			r = borgo.Forward(r, "username", me.Username)
		}
		next.ServeHTTP(w, r)
	})
}
