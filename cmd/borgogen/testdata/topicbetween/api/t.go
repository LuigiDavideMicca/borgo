package api

import "github.com/LuigiDavideMicca/borgo"

func notify(id string) {
	borgo.Push("a:"+id, "e1", 1) //borgo:topic a:{id}
	borgo.Push("b:"+id, "e2", "s")
}
