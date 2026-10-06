package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// The live page's topic is public: every visitor may hold it and may publish
// to it. A user's own topic, user:<id>, is held only by a socket
// carrying that user's session - the session borgo verified, read here per
// topic at the handshake. Without this, borgo start refuses every
// subscription: a relay with no rule is a relay with the wrong rule.
func init() {
	borgo.CanSubscribe(func(r *http.Request, topic string) bool {
		if topic == "live" {
			return true
		}
		me, ok := borgo.GetSession[Me](r)
		return ok && me.ID != 0 && topic == userTopic(me.ID)
	})
}
