package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

type OK struct {
	OK bool `json:"ok"`
}

// two handlers on one pattern: the routes are collected and their bridge types
// generated before the clash is noticed, so this is the failure that comes
// latest - the one a naive implementation would already have written output for
//
//borgo:route GET /api/ok
func Ping(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, OK{})
}

//borgo:route GET /api/ok
func PingAgain(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, OK{})
}
