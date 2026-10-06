package api

import (
	"context"

	"github.com/LuigiDavideMicca/borgo"
)

type User struct {
	Username string `json:"username"`
}

type SignupBody struct {
	borgo.Credentials
	Avatar *borgo.File `json:"avatar"`
}

var auth = borgo.Auth[User]{}

func init() {
	borgo.Handle("POST /api/register", borgo.Signup(&auth, func(ctx context.Context, form SignupBody, hash string) (User, error) {
		return User{Username: form.Username}, nil
	}))
}
