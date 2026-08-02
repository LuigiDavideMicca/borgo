package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

type Item struct {
	ID string `json:"id"`
}

// Nested stacks three nullable levels five different ways. Every one of these
// is ordinary Go with an ordinary wire shape - json.Marshal of a filled Nested
// writes
//
//	{"grouped":{"g":[{"id":"a"}]},"rows":[[{"id":"b"}]],"chunks":[["Yw=="]],
//	 "deep":{"d":{"e":["f"]}},"mixed":{"m":[{"k":1}]}}
//
// but each rendering has to nest a "| null" inside a type argument list and
// then admit null itself, and a type printed with an unclosed "<" is not a
// wrong type, it is a parse error that takes the whole file's routes down.
type Nested struct {
	Grouped map[string][]*Item             `json:"grouped"`
	Rows    [][]*Item                      `json:"rows"`
	Chunks  [][][]byte                     `json:"chunks"`
	Deep    map[string]map[string][]string `json:"deep"`
	Mixed   map[string][]map[string]int    `json:"mixed"`
}

//borgo:route GET /api/nested/one
func GetNested(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Nested{})
}

// Two answers under one route, each a nullable array of a nullable element:
// the union has to keep both members whole and carry one null for the pair.
//
//borgo:route GET /api/nested/either
func GetEither(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Has("rows") {
		borgo.JSON(w, http.StatusOK, [][]*Item{})
		return
	}
	borgo.JSON(w, http.StatusOK, []map[string]*Item{})
}

//borgo:route POST /api/nested/push
func DoPush(w http.ResponseWriter, r *http.Request) {
	// one WsEvents key, two nullable-array payloads: the same union, reached
	// from the push map instead of from a route
	borgo.Push("room", "mixed", [][]*Item{})
	borgo.Push("room", "mixed", []map[string][]string{})
	borgo.JSON(w, http.StatusOK, Item{})
}
