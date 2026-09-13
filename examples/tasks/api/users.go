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
	Hash     string `json:"-"`
}

// the session stores only the username - the minimal principal
type Me struct {
	Username string `json:"username"`
}

var auth = borgo.Auth[User]{
	Lookup: func(ctx context.Context, username string) (User, string, error) {
		var user User
		if err := db.DB.First(&user, "username = ?", username).Error; err != nil {
			return User{}, "", err
		}
		return user, user.Hash, nil
	},
	Register: func(ctx context.Context, username, hash string) (User, error) {
		var count int64
		db.DB.Model(&User{}).Where("username = ?", username).Count(&count)
		if count > 0 {
			return User{}, borgo.ErrUserExists
		}
		user := User{Username: username, Hash: hash}
		return user, db.DB.Create(&user).Error
	},
	Principal: func(u User) any { return Me{Username: u.Username} },
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
	revokedBefore.Store(me.Username, time.Now())
	borgo.ClearSession(w)
	w.WriteHeader(http.StatusNoContent)
}

func init() {
	borgo.CheckSession(sessionStillValid)
	borgo.Handle("POST /api/login", auth.LoginHandler)
	borgo.Handle("POST /api/logout", auth.LogoutHandler)
	borgo.Handle("POST /api/logout-everywhere", borgo.Authed(logoutEverywhere))
	borgo.Handle("POST /api/register", auth.RegisterHandler)
	borgo.Handle("GET /api/me", borgo.Authed(currentUser))
}
