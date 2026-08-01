package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// The memory probe holds thousands of these open at once and then drops them
// abruptly, which is the point: the scenario measures the cost of *holding* a
// connection, not of pushing data through it.
//
// The contract requires the first flush to happen immediately (a `: ping`
// comment), so a client can tell an accepted connection from a pending one.
// That is also why this uses borgo.SSE directly rather than borgo.NewSSEHub:
// the hub sends nothing until something is published, and the front server
// does not complete the response's header block until the first body byte -
// so a hub-backed endpoint leaves a spec-abiding client waiting for headers
// that never arrive. Worth fixing upstream; here it is simply avoided.
//
//borgo:route GET /api/events
func EventsHandler(w http.ResponseWriter, r *http.Request) {
	stream, err := borgo.SSE(w, r)
	if err != nil {
		return
	}
	if err := stream.Ping(); err != nil {
		return
	}
	<-stream.Done()
}
