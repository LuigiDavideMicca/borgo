package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

//borgo:type Money string
type Money int

// A second directive for Money: whichever of the two the generator picked, the
// other one was a lie about the wire.
//
//borgo:type Money number
type Wallet struct {
	Balance Money `json:"balance"`
}

//borgo:route GET /api/wallet
func GetWallet(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Wallet{})
}
