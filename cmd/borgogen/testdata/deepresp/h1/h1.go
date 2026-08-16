package h1

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
	"github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/deepresp/h2"
)

type ROne struct {
	N int `json:"n"`
}

func One(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, ROne{})
	h2.Two(w, r)
}
