package api

import "net/http"

var Matcher = "/api/admin/*"

func Middleware(next http.Handler) http.Handler {
	return next
}
