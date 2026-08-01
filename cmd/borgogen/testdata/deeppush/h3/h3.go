package h3

import (
	"github.com/LuigiDavideMicca/borgo"
	"github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/deeppush/h4"
)

type PThree struct {
	N int `json:"n"`
}

func Three() {
	borgo.Push("chain", "three", PThree{})
	h4.Four()
}
