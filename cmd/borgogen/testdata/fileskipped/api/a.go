package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// a File encoding/json never reads is not one the client sends
type Profile struct {
	Name   string     `json:"name"`
	Avatar borgo.File `json:"-"`
	avatar borgo.File
}

//borgo:route POST /api/profile
func profile(w http.ResponseWriter, r *http.Request) {
	v, err := borgo.Bind[Profile](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	_ = v.avatar
	borgo.JSON(w, http.StatusOK, v.Name)
}
