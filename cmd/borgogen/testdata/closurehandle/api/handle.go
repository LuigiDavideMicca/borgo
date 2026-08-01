package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

type Inline struct {
	A int `json:"a"`
}

type Wrapped struct {
	B string `json:"b"`
}

func named(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Wrapped{})
}

// pick decides the handler at runtime, so there is no body to read types from
// and the route has to say so instead of coming out "response: unknown".
func pick() http.HandlerFunc {
	return named
}

func init() {
	borgo.Handle("GET /api/inline", func(w http.ResponseWriter, r *http.Request) {
		borgo.JSON(w, http.StatusOK, Inline{})
	})
	borgo.Handle("GET /api/wrapped", http.HandlerFunc(named))
	borgo.Handle("GET /api/authedinline", borgo.Authed(func(w http.ResponseWriter, r *http.Request) {
		borgo.JSON(w, http.StatusOK, Wrapped{})
	}))
	borgo.Handle("GET /api/opaque", pick())
}
