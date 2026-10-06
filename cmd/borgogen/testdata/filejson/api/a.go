package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

type Avatar struct {
	Note string     `json:"note"`
	Pic  borgo.File `json:"pic"`
}

//borgo:route POST /api/avatar
func avatar(w http.ResponseWriter, r *http.Request) {
	v, err := borgo.Bind[Avatar](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	borgo.JSON(w, http.StatusOK, v.Note)
}
