package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

type Thing struct {
	ID int `json:"id"`
}

var prefix = "/api/"

func thing(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Thing{})
}

//borgo:route GET /api/fixed
func fixed(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Thing{})
}

func init() {
	// mounted and served, but the generator has no key to file it under
	borgo.Handle("GET "+prefix+"thing", thing)
}
