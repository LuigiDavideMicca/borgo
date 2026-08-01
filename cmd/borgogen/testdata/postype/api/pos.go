package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// The same two one-off stamps ambigtype refuses, with the directive naming the
// declaration it means. Only One's stamp becomes a string; Two's keeps its own
// shape.

//borgo:type stamp@pos.go:17 string

//borgo:route GET /api/one
func One(w http.ResponseWriter, r *http.Request) {
	type stamp struct {
		Sec int `json:"sec"`
	}
	type resp struct {
		At stamp `json:"at"`
	}
	borgo.JSON(w, http.StatusOK, resp{})
}

//borgo:route GET /api/two
func Two(w http.ResponseWriter, r *http.Request) {
	type stamp struct {
		Nano int `json:"nano"`
	}
	type resp struct {
		At stamp `json:"at"`
	}
	borgo.JSON(w, http.StatusOK, resp{})
}
