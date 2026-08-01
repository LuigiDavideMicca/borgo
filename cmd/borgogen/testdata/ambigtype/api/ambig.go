package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// Two handlers declare their own one-off stamp and no package-level one exists,
// so there is nothing a bare name can mean here. Applying the directive to both
// is the silent breadth this fixture exists to refuse.

//borgo:type stamp string

//borgo:route GET /api/one
func One(w http.ResponseWriter, r *http.Request) {
	type stamp struct {
		Sec int `json:"sec"`
	}
	borgo.JSON(w, http.StatusOK, stamp{})
}

//borgo:route GET /api/two
func Two(w http.ResponseWriter, r *http.Request) {
	type stamp struct {
		Nano int `json:"nano"`
	}
	borgo.JSON(w, http.StatusOK, stamp{})
}
