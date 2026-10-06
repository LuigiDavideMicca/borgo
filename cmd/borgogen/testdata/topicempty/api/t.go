package api

import "github.com/LuigiDavideMicca/borgo"

// `user:${string}` admits "user:" itself: a placeholder may be empty
func notify(name string) {
	borgo.Push("user:", "ev", 1)
	//borgo:topic user:{name}
	borgo.Push("user:"+name, "ev", "s")
}
