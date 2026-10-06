package api

import "github.com/LuigiDavideMicca/borgo"

func notify() {
	//borgo:topic live
	borgo.Push("live", "created", 1)
}
