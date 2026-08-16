package users

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

type User struct {
	Name string `json:"name"`
}

type Filter struct {
	Q string `json:"q"`
}

// List is a package-level handler like any other, only not in api/.
func List(w http.ResponseWriter, r *http.Request) {
	if _, err := borgo.Bind[Filter](r); err != nil {
		return
	}
	borgo.JSON(w, http.StatusOK, User{})
}
