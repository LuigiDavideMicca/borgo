package h4

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

type RFour struct {
	N int `json:"n"`
}

func Four(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, RFour{})
}
