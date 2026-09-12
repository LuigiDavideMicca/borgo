package api

import "net/http"

var Matcher = []string{"/api/admin/*"}

func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
	})
}

//borgo:route GET /api/admin/ping
func Ping(w http.ResponseWriter, r *http.Request) {}
