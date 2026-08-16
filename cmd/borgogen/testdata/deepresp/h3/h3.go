package h3

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
	"github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/deepresp/h4"
)

type RThree struct {
	N int `json:"n"`
}

func Three(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, RThree{})
	h4.Four(w, r)
}
