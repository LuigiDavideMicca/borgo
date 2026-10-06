package api

import "github.com/LuigiDavideMicca/borgo"

func notify(id string) {
	//borgo:topic channel/{id}
	borgo.Push("channel/"+id, "created", 1)
}
