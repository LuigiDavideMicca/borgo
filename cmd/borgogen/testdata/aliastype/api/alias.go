package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// An alias is a name in its own right, so a directive can target it: the app
// serializes cents as a decimal string on the way out.
//
//borgo:type Cents string
type Cents = int

//borgo:type Weight string
type Weight float64

type Price struct {
	Amount Cents  `json:"amount"`
	Ship   Weight `json:"ship"`
	Raw    int    `json:"raw"`
}

//borgo:route GET /api/price
func GetPrice(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Price{})
}
