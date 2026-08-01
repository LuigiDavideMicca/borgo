package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// A bare name in a //borgo:type used to be the whole key, so this directive -
// written for the package-level Stamp below - also rewrote the unrelated Stamp
// declared inside Local, silently, and that handler's callers were handed a
// string where the wire carries an object.

//borgo:type Stamp string

type Stamp struct {
	Sec int `json:"sec"`
}

type PkgResp struct {
	At Stamp `json:"at"`
}

//borgo:route GET /api/pkg
func Pkg(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, PkgResp{})
}

//borgo:route GET /api/local
func Local(w http.ResponseWriter, r *http.Request) {
	type Stamp struct {
		Nano int `json:"nano"`
	}
	type resp struct {
		At Stamp `json:"at"`
	}
	borgo.JSON(w, http.StatusOK, resp{})
}
