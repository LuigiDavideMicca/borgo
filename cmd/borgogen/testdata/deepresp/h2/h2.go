package h2

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
	"github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/deepresp/h3"
)

type RTwo struct {
	N int `json:"n"`
}

func Two(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, RTwo{})
	h3.Three(w, r)
}
