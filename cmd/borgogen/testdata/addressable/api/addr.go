package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// PM's MarshalJSON is on the pointer receiver, so encoding/json runs it only
// where the value it holds is addressable. Outer merely holds a PM by value,
// which is enough to make Outer itself reach the wire two different ways in one
// response - the case a single generated interface cannot describe.
//
// TestAddressableVariantsMatchEncodingJSON spells out what json.Marshal writes
// for every field of Holder below.
type PM struct {
	X int `json:"x"`
}

func (p *PM) MarshalJSON() ([]byte, error) { return []byte(`"pm"`), nil }

type Outer struct {
	P PM `json:"p"`
}

// Inner's fields are promoted through a pointer, so reaching them dereferences
// it: they are addressable whatever holds the outer value, map value included.
type Inner struct {
	P PM `json:"p"`
}

type Deref struct {
	*Inner
	B int `json:"b"`
}

// Both carries a MarshalJSON on the pointer receiver and a MarshalText on the
// value one, so the two positions do not merely differ in shape - they run
// different methods.
type Both struct {
	N int `json:"n"`
}

func (b *Both) MarshalJSON() ([]byte, error) { return []byte(`"js"`), nil }
func (b Both) MarshalText() ([]byte, error)  { return []byte("txt"), nil }

// ArrBox holds its Outer in an array, and an array element inherits the
// addressability of the array, so ArrBox itself has two shapes wherever it is
// reached both ways.
type ArrBox struct {
	A [1]Outer `json:"a"`
}

type Holder struct {
	Plain  Outer            `json:"plain"`
	Many   []Outer          `json:"many"`
	Keyed  map[string]Outer `json:"keyed"`
	Ptr    *Outer           `json:"ptr"`
	Arr    [1]Outer         `json:"arr"`
	ArrIn  [][1]Outer       `json:"arrin"`
	Box    ArrBox           `json:"box"`
	Boxes  []ArrBox         `json:"boxes"`
	Deref  Deref            `json:"deref"`
	Derefs []Deref          `json:"derefs"`
	Both   Both             `json:"both"`
	BothIn []Both           `json:"bothin"`
}

// Node is both addressability-sensitive and recursive: its own next is behind a
// pointer, so every hop past the first is addressable and the second variant has
// to be able to refer to itself.
type Node struct {
	P    PM    `json:"p"`
	Next *Node `json:"next"`
}

//borgo:route GET /api/holder
func GetHolder(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Holder{})
}

//borgo:route GET /api/node
func GetNode(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Node{})
}

// The same Outer as the root of a response: nothing addresses it there, so it
// is the plain shape.
//
//borgo:route GET /api/outer
func GetOuter(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Outer{})
}

// And as a slice of it, which is the case that used to be typed as if the
// elements were the plain shape.
//
//borgo:route GET /api/outers
func GetOuters(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, []Outer{})
}

// A map value is never addressable, so this one is the plain shape again.
//
//borgo:route GET /api/outermap
func GetOuterMap(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, map[string]Outer{})
}
