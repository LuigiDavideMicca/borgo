package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/LuigiDavideMicca/borgo"
	"gorm.io/gorm"

	"tasks/db"
)

type User struct {
	gorm.Model
	Username string `gorm:"uniqueIndex" json:"username"`
	Email    string `json:"email"`
	Hash     string `json:"-"`
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

// what the other devices of a user are told when one of them logs out
// everywhere: the moment, so a page can say how long ago
type SignedOut struct {
	At int64 `json:"at"`
}

var auth = borgo.Auth[User]{
	Lookup: func(ctx context.Context, username string) (User, string, error) {
		var user User
		if err := db.DB.First(&user, "username = ?", username).Error; err != nil {
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
	var count int64
	db.DB.Model(&User{}).Where("username = ?", form.Username).Count(&count)
	if count > 0 {
		return User{}, borgo.ErrUserExists
	}
	user := User{Username: form.Username, Email: form.Email, Hash: hash}
	return user, db.DB.Create(&user).Error
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

// when each user last asked to be logged out everywhere. In memory, so per
// process and gone at a restart: an app with several instances keeps the
// cutoffs in a store they share
var revokedBefore sync.Map // username -> time.Time

// every session issued before its user's cutoff reads as no session, on the
// next request of every device holding one - without touching their cookies
func sessionStillValid(r *http.Request, s borgo.SessionInfo) bool {
	var me Me
	if json.Unmarshal(s.Data, &me) != nil {
		return false
	}
	cutoff, revoked := revokedBefore.Load(me.Username)
	return !revoked || s.IssuedAt.After(cutoff.(time.Time))
}

func logoutEverywhere(w http.ResponseWriter, r *http.Request) {
	me, ok := borgo.GetSession[Me](r)
	if !ok {
		// unreachable behind Authed; plain text keeps the generated type clean
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	now := time.Now()
	revokedBefore.Store(me.Username, now)
	borgo.ClearSession(w)
	// the user's other tabs are told on their own topic - one per user, its
	// shape named by the directive so the payload is typed on the page, and
	// held only by that user's sockets (api/realtime.go)
	//borgo:topic user:{username}
	go borgo.Push("user:"+me.Username, "signed-out", SignedOut{At: now.Unix()})
	w.WriteHeader(http.StatusNoContent)
}

func init() {
	borgo.CheckSession(sessionStillValid)
	borgo.Handle("POST /api/login", auth.LoginHandler)
	borgo.Handle("POST /api/logout", auth.LogoutHandler)
	borgo.Handle("POST /api/logout-everywhere", borgo.Authed(logoutEverywhere))
	borgo.Handle("POST /api/register", borgo.Signup(&auth, register))
	borgo.Handle("GET /api/me", borgo.Authed(currentUser))
}
