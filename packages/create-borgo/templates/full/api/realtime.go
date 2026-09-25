package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// Who may hold a websocket topic. The live page's topic is public here;
// a private one reads the session borgo verified, per request:
//
//	s, ok := borgo.GetSession[Session](r)
//	return ok && topic == "user:"+s.User
//
// Without a CanSubscribe, borgo start refuses every subscription and says so
// at startup. borgo.CanPublish decides publishing separately when it should
// differ from holding.
func init() {
	borgo.CanSubscribe(func(r *http.Request, topic string) bool {
		return topic == "live"
	})
}
