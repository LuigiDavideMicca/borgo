package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
	"github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/pushpkg/events"
)

type Ack struct {
	OK bool `json:"ok"`
}

//borgo:route POST /api/say
func Say(w http.ResponseWriter, r *http.Request) {
	events.Announce("hello")
	borgo.JSON(w, http.StatusOK, Ack{OK: true})
}
