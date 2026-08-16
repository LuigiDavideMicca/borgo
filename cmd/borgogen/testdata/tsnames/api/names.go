package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// Both names shadow the generics this generator writes.
type Record struct {
	M map[string]int `json:"m"`
}

type Array struct {
	L []int `json:"l"`
}

// Go reserves none of the names TypeScript does, and a one-off type declared
// inside the handler that answers with it is where such a name turns up: these
// three used to be written out as "export interface null", "export interface
// function" and "export interface string", none of which the compiler accepts.
//
//borgo:route GET /api/null
func GetNull(w http.ResponseWriter, r *http.Request) {
	type null struct {
		X int `json:"x"`
	}
	borgo.JSON(w, http.StatusOK, null{})
}

//borgo:route GET /api/function
func GetFunction(w http.ResponseWriter, r *http.Request) {
	type function struct {
		Y int `json:"y"`
	}
	borgo.JSON(w, http.StatusOK, function{})
}

//borgo:route GET /api/string
func GetString(w http.ResponseWriter, r *http.Request) {
	// legal Go: the predeclared string is shadowed inside this function only
	type string struct {
		Z int `json:"z"`
	}
	borgo.JSON(w, http.StatusOK, string{})
}

//borgo:route GET /api/rec
func GetRec(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Record{})
}

//borgo:route GET /api/arr
func GetArr(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Array{})
}
