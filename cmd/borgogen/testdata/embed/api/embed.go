package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// base is unexported, but encoding/json still promotes its exported fields:
// json.Marshal(Doc{base{1, "n"}, "t"}) is {"id":1,"name":"n","title":"t"}.
type base struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type Doc struct {
	base
	Title string `json:"title"`
}

// Child's own id shadows the promoted one: {"name":"n","id":9}.
type Base struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Child struct {
	Base
	ID int `json:"id"`
}

// L1.x and L2.x sit at the same depth and are both tagged, so encoding/json
// drops the name entirely: {"y":0}.
type L1 struct {
	X int `json:"x"`
}

type L2 struct {
	X string `json:"x"`
}

type Tie struct {
	L1
	L2
	Y int `json:"y"`
}

// Both branches reach Leaf.v at the same depth: json.Marshal(Diamond{}) is
// {"a1":0,"b1":0}.
type Leaf struct {
	V int `json:"v"`
}

type BranchA struct {
	Leaf
	A1 int `json:"a1"`
}

type BranchB struct {
	Leaf
	B1 int `json:"b1"`
}

type Diamond struct {
	BranchA
	BranchB
}

// encoding/json skips a whole promoted group when the pointer it hangs off is
// nil, and says nothing about it: json.Marshal(PtrOuter{B: 1}) is {"b":1} and
// json.Marshal(PtrOuter{&PtrInner{7}, 1}) is {"a":7,"b":1}. Deep's fields are
// two hops down but still behind the same nil pointer.
type PtrInner struct {
	A int `json:"a"`
}

type PtrMid struct {
	PtrInner
	C int `json:"c"`
}

type PtrOuter struct {
	*PtrInner
	B int `json:"b"`
}

type Deep struct {
	*PtrMid
	D int `json:"d"`
}

//borgo:route GET /api/doc
func GetDoc(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Doc{})
}

//borgo:route GET /api/child
func GetChild(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Child{})
}

//borgo:route GET /api/tie
func GetTie(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Tie{})
}

//borgo:route GET /api/diamond
func GetDiamond(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Diamond{})
}

//borgo:route GET /api/ptrouter
func GetPtrOuter(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, PtrOuter{})
}

//borgo:route GET /api/deep
func GetDeep(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Deep{})
}
