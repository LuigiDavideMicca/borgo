package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// Declaring a one-off response struct inside the handler that answers with it
// is ordinary Go. Both of these are named "resp" and neither is the other:
// json.Marshal of Alpha's is {"a":1} and of Beta's is {"b":"x","c":true}.

//borgo:route GET /api/alpha
func Alpha(w http.ResponseWriter, r *http.Request) {
	type resp struct {
		A int `json:"a"`
	}
	borgo.JSON(w, http.StatusOK, resp{A: 1})
}

//borgo:route GET /api/beta
func Beta(w http.ResponseWriter, r *http.Request) {
	type resp struct {
		B string `json:"b"`
		C bool   `json:"c"`
	}
	borgo.JSON(w, http.StatusOK, resp{B: "x", C: true})
}

// Non-struct locals share the name too. The recursive one needs a declaration
// of its own, so it claims the name first, and the plain slice next to it -
// json.Marshal of it is [1,2] - used to resolve to that declaration.

//borgo:route GET /api/cyc
func Cyc(w http.ResponseWriter, r *http.Request) {
	type node map[string]node
	borgo.JSON(w, http.StatusOK, node{})
}

//borgo:route GET /api/list
func List(w http.ResponseWriter, r *http.Request) {
	type node []int
	borgo.JSON(w, http.StatusOK, node{1, 2})
}
