package api

import "net/http"

// a handler, not a middleware: mounting it would be a guard that never calls
// what it guards, and silently skipping it would be no guard at all
func Middleware(w http.ResponseWriter, r *http.Request) {}
