package api

import "github.com/LuigiDavideMicca/borgo"

func notify(a, b string) {
	//borgo:topic user:{a}
	borgo.Push("user:"+a, "ev", 1)
	//borgo:topic user:{a}:{b}
	borgo.Push("user:"+a+":"+b, "ev", "s")
}
