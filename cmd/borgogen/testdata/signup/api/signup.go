package api

import (
	"context"
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

type User struct {
	Username string `json:"username"`
	Email    string `json:"email"`
}

// the signup form of the app: borgo.Credentials embedded, the rest its own
type SignupBody struct {
	borgo.Credentials
	Email string `json:"email"`
	Name  string `json:"name,omitempty"`
}

var auth = borgo.Auth[User]{}

func init() {
	// a framework handler whose request type is the app's: read from the
	// instantiation, since the body is borgo's and never walked
	borgo.Handle("POST /api/register", borgo.Signup(&auth, func(ctx context.Context, form SignupBody, hash string) (User, error) {
		return User{Username: form.Username, Email: form.Email}, nil
	}))
	// through Authed and a conversion, as any handler may be wrapped
	borgo.Handle("POST /api/invite", borgo.Authed(http.HandlerFunc(borgo.Signup(&auth, func(ctx context.Context, form borgo.Credentials, hash string) (User, error) {
		return User{Username: form.Username}, nil
	}))))
	// with the type arguments spelled out, and in parentheses
	borgo.Handle("POST /api/explicit", (borgo.Signup[User, SignupBody](&auth, func(ctx context.Context, form SignupBody, hash string) (User, error) {
		return User{Username: form.Username}, nil
	})))
}
