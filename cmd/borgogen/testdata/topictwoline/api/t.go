package api

import "github.com/LuigiDavideMicca/borgo"

func notify(id string) {
	_ = []error{borgo.Push("a:"+id, "e1", 1), borgo.Push("b:"+id, "e2", "s")} //borgo:topic a:{id}
}
