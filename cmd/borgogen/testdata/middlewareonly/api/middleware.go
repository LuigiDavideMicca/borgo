package api

import "net/http"

// no routes by directive and no matcher: the mounting must still be written,
// or the middleware of an app that registers its routes by hand never runs
func Middleware(next http.Handler) http.Handler {
	return next
}
