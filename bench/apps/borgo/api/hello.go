package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

type Hello struct {
	Message string `json:"message"`
}

//borgo:route GET /api/hello
func HelloHandler(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Hello{Message: "hello, world"})
}
