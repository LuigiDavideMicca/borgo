package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// The live page's topic is public: every visitor may hold it and may publish
// to it. Without this, borgo start refuses every subscription - a relay with
// no rule is a relay with the wrong rule - and a topic that should be
// private is decided here, per request, with the session borgo verified.
func init() {
	borgo.CanSubscribe(func(r *http.Request, topic string) bool {
		return topic == "live"
	})
}
