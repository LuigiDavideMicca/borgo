package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// app types named like borgo-framework's own declarations: a chat app has a
// Channel. They keep their names
type Channel struct {
	Name string `json:"name"`
}

type WsEvents struct {
	X int `json:"x"`
}

//borgo:route GET /api/channel
func GetChannel(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Channel{})
}

//borgo:route GET /api/events
func GetEvents(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, WsEvents{})
}

func announce(c Channel) {
	borgo.Push("live", "channel", c)
}
