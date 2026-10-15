package api

import "net/http"

var Matcher = []string{"/secret"}

func Middleware(next http.Handler) http.Handler { return next }
