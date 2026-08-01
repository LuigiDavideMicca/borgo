package api

import "github.com/LuigiDavideMicca/borgo"

func notify() {
	borgo.Push("live/chat", "created", 1)
}
