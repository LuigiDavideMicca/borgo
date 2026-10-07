package api

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"

	"github.com/LuigiDavideMicca/borgo"

	"{{name}}/db"
)

type User struct {
	Username string
	Email    string
	Hash     string
}

// the signup form: borgo.Credentials embedded, so the framework finds the
// username and the password, and the rest is this app's
type Signup struct {
	borgo.Credentials
	Email string `json:"email"`
}

// the session stores only the username - the minimal principal
type Me struct {
	Username string `json:"username"`
}

// the users table is db/migrations/0001_init.sql; borgo.Auth asks only for
// a lookup and a register, and keeps sessions, csrf and the guards itself
var auth = borgo.Auth[User]{
	Lookup: func(ctx context.Context, username string) (User, string, error) {
		var user User
		err := db.DB.QueryRowContext(ctx, `SELECT username, email, hash FROM users WHERE username = ?`, username).
			Scan(&user.Username, &user.Email, &user.Hash)
		if err != nil {
			// login answers 401 to any error, so a database that is down
			// would look like a wrong password: it is logged here instead
			if !errors.Is(err, sql.ErrNoRows) {
				log.Printf("look up user: %v", err)
			}
			return User{}, "", err
		}
		return user, user.Hash, nil
	},
	Principal: func(u User) any { return Me{Username: u.Username} },
}

// register creates the user from the form and the hash of its password;
// what it validates beyond the framework's checks is this app's, and a
// malformed email is refused in the page's action, where it can be shown
func register(ctx context.Context, form Signup, hash string) (User, error) {
	user := User{Username: form.Username, Email: form.Email, Hash: hash}
	// one statement, so two registrations of one name cannot both pass a
	// check made before the insert
	res, err := db.DB.ExecContext(ctx, `INSERT INTO users (username, email, hash) VALUES (?, ?, ?) ON CONFLICT (username) DO NOTHING`, user.Username, user.Email, user.Hash)
	if err != nil {
		log.Printf("register user: %v", err)
		return User{}, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		log.Printf("register user: %v", err)
		return User{}, err
	}
	if n == 0 {
		return User{}, borgo.ErrUserExists
	}
	return user, nil
}

func currentUser(w http.ResponseWriter, r *http.Request) {
	me, ok := borgo.GetSession[Me](r)
	if !ok {
		// unreachable behind Authed; plain text keeps the generated type clean
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	borgo.JSON(w, http.StatusOK, me)
}

func init() {
	borgo.Handle("POST /api/login", auth.LoginHandler)
	borgo.Handle("POST /api/logout", auth.LogoutHandler)
	borgo.Handle("POST /api/register", borgo.Signup(&auth, register))
	borgo.Handle("GET /api/me", borgo.Authed(currentUser))
}
