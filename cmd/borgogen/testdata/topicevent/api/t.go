package api

import "github.com/LuigiDavideMicca/borgo"

func notify(id, event string) {
	//borgo:topic channel:{id}
	borgo.Push("channel:"+id, event, 1)
}
