package api

import "net/http"

func paths() []string { return []string{"/admin/*"} }

var Matcher = paths()

func Middleware(next http.Handler) http.Handler { return next }
