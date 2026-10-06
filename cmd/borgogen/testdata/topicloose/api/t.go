package api

import "github.com/LuigiDavideMicca/borgo"

func notify(id string) {
	// borgo:topic a:{id}
	borgo.Push("a:"+id, "e", 1)
}
