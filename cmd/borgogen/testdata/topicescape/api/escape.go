package api

import "github.com/LuigiDavideMicca/borgo"

// event names a template literal or a string cannot hold as written
func notify(id string) {
	//borgo:topic room:{id}
	borgo.Push("room:"+id, "a`b", 1)
	//borgo:topic chat:{id}
	borgo.Push("chat:"+id, "x${y}", 2)
	borgo.Push("bell", "ring\a", 3)
}
