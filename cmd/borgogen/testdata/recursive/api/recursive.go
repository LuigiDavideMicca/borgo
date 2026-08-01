package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// A named type whose underlying is not a struct is inlined, so a recursive one
// has no anchor to stop at: expanding Tree once asks for Tree again. It needs a
// declaration of its own for the inner reference to resolve to.
type Tree map[string]Tree

// The cycle can also run through a struct, which does get an interface: Ring
// still has to be named for Hop.next to refer to it.
type Ring []Hop

type Hop struct {
	Next Ring `json:"next"`
}

// A named type that is not recursive keeps being inlined - Money is a number,
// not a declaration of its own.
type Money int

type Wallet struct {
	Balance Money `json:"balance"`
}

//borgo:route GET /api/tree
func GetTree(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Tree{})
}

//borgo:route GET /api/ring
func GetRing(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Ring{})
}

//borgo:route GET /api/wallet
func GetWallet(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Wallet{})
}
