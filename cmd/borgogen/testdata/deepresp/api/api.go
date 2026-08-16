package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/deepresp/h1"
)

// The chain runs one package further than the cap follows. What sits past it
// is not merely absent from the union: it reads exactly like a handler that
// answers nothing, which is why the cap has to say where it stopped.
//
//borgo:route GET /api/chain
func GetChain(w http.ResponseWriter, r *http.Request) {
	h1.One(w, r)
}
