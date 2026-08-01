package h2

import (
	"github.com/LuigiDavideMicca/borgo"
	"github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/deeppush/h3"
)

type PTwo struct {
	N int `json:"n"`
}

func Two() {
	borgo.Push("chain", "two", PTwo{})
	h3.Three()
}
