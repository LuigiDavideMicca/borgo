package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// tsGen.override matches an api type by its bare name whatever scope declares
// it, so a directive naming a function-local one does apply - refusing the run
// over it failed a project whose directive was perfectly good.

//borgo:type stamp string

//borgo:route GET /api/stamped
func Stamped(w http.ResponseWriter, r *http.Request) {
	type stamp struct {
		Sec int `json:"sec"`
	}
	type resp struct {
		At stamp `json:"at"`
	}
	borgo.JSON(w, http.StatusOK, resp{})
}
