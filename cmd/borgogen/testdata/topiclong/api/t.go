package api

import "github.com/LuigiDavideMicca/borgo"

func notify(id string) {
	//borgo:topic xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx{id}
	borgo.Push("x"+id, "e", 1)
}
