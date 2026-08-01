// Package domain sits two hops from the api package, so its pushes only show
// up if the walk over same-module imports is transitive.
package domain

import "github.com/LuigiDavideMicca/borgo"

type Audit struct {
	At string `json:"at"`
}

func Log(text string) {
	borgo.Push("room", "audit", Audit{At: text})
}
