// Package events publishes from the domain layer instead of from the http
// handler, which is ordinary layering: it takes no ResponseWriter and no
// Request, so helper following never reaches it.
package events

import (
	"github.com/LuigiDavideMicca/borgo"
	"github.com/LuigiDavideMicca/borgo/cmd/borgogen/testdata/pushpkg/domain"
)

type Note struct {
	Text string `json:"text"`
}

func Announce(text string) {
	borgo.Push("room", "note", Note{Text: text})
	domain.Log(text)
}
