package api

import "github.com/LuigiDavideMicca/borgo"

func notify(id string) {
	borgo.Push("channel:42", "ev", 1)
	//borgo:topic channel:{id}
	borgo.Push("channel:"+id, "ev", "s")
}
