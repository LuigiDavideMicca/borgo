package h1

import (
	"github.com/LuigiDavideMicca/borgo"
	"github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/deeppush/h2"
)

type POne struct {
	N int `json:"n"`
}

func One() {
	borgo.Push("chain", "one", POne{})
	h2.Two()
}
