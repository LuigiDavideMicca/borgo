// Package h4 sits four package hops from api, one past the cap the walk over
// same-module imports stops at, so its push is never seen.
package h4

import "github.com/LuigiDavideMicca/borgo"

type PFour struct {
	N int `json:"n"`
}

func Four() {
	borgo.Push("chain", "four", PFour{})
}
