package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
	"github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/pkghandler/users"
)

// Registering a handler that lives in another package of the app is ordinary
// layering. api/ knows the function but holds no declaration for it, so the
// walk started at nothing and the route came out "response: unknown" with
// nobody told why.
var auth = &borgo.Auth[users.User]{}

func init() {
	borgo.Handle("GET /api/users", users.List)
	// and one the generator really cannot read: net/http is not this module
	borgo.Handle("GET /api/notfound", http.NotFound)
	// while borgo's own handlers are untyped by the framework's choice, on
	// every run of every app that registers them, and saying so every time is
	// how a warning channel stops being read
	borgo.Handle("POST /api/login", auth.LoginHandler)
}
