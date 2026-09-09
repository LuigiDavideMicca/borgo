package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

type Pong struct {
	Ok bool `json:"ok"`
}

// the page is fully static - this exists because a borgo app has a go half,
// and the exporter's health probe wants an api that answers
//
//borgo:route GET /api/ping
func Ping(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Pong{Ok: true})
}
