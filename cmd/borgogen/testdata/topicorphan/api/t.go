package api

import "github.com/LuigiDavideMicca/borgo"

//borgo:topic channel:{id}
func notify(id string) {
	borgo.Push("channel:"+id, "created", 1)
}
