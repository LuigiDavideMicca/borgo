//go:build plan9

package api

import "github.com/LuigiDavideMicca/borgo"

func notifyPlan9(id string) {
	//borgo:topic plan9:{id}
	borgo.Push("plan9:"+id, "ready", 1)
}
