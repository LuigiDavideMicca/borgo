package api

import "github.com/LuigiDavideMicca/borgo"

// a computed topic is the documented way to publish something that cannot be
// typed: generation succeeds and the event stays out of WsEvents
func notify(topic string) {
	borgo.Push(topic, "created", 1)
}

// a computed event name is the same case on the other argument
func notifyEvent(event string) {
	borgo.Push("live", event, 1)
}
