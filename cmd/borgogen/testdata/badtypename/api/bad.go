package api

import (
	"net/http"
	"time"

	"github.com/LuigiDavideMicca/borgo"
)

// Widgit is a typo for Widget, so this directive can never apply.
//
//borgo:type Widgit string
type Widget struct {
	At time.Time `json:"at"`
}

//borgo:route GET /api/widget
func GetWidget(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Widget{})
}
