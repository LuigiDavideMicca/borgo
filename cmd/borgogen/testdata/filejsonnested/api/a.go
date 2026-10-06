package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

type Inner struct {
	Docs []*borgo.File `json:"docs"`
}

// reached only through a map's values, a slice and a pointer
type Outer struct {
	Tags map[string]Inner `json:"tags"`
}

//borgo:route POST /api/outer
func outer(w http.ResponseWriter, r *http.Request) {
	v, err := borgo.BindMax[Outer](r, 1<<20)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	borgo.JSON(w, http.StatusOK, len(v.Tags))
}
