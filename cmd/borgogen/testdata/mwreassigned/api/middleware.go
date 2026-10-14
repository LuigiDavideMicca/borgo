package api

import "net/http"

var Matcher = []string{"/admin/*"}

func init() {
	Matcher = append(Matcher, "/account")
}

func Middleware(next http.Handler) http.Handler { return next }
