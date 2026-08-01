package api

import (
	"net/http"
	"time"

	"github.com/LuigiDavideMicca/borgo"
)

// time is imported right here, and it has no Tiem in it.
//
//borgo:type time.Tiem string
type Stamp struct {
	At time.Time `json:"at"`
}

//borgo:route GET /api/stamp
func GetStamp(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Stamp{})
}
