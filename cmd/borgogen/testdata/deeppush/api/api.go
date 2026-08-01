package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
	"github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/deeppush/h1"
)

type Ack struct {
	OK bool `json:"ok"`
}

//borgo:route POST /api/go
func Go(w http.ResponseWriter, r *http.Request) {
	h1.One()
	borgo.JSON(w, http.StatusOK, Ack{OK: true})
}
