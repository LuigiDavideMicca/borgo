package api

import "github.com/LuigiDavideMicca/borgo"

func notify(id string) {
	//borgo:topic a,b:{id}
	borgo.Push("a,b:"+id, "e", 1)
}
