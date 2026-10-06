package api

import (
	"fmt"

	"github.com/LuigiDavideMicca/borgo"
)

type Msg struct {
	ID   int    `json:"id"`
	Text string `json:"text"`
}

func liveTopic() string { return "live" }

// a computed topic named by its shape: the generator keys the map by the
// pattern and keeps owning the payload type
func notify(id string, m Msg) {
	//borgo:topic channel:{id}
	borgo.Push("channel:"+id, "message", m)
	borgo.Push("channel:"+id, "typing", true) //borgo:topic channel:{id}
	//borgo:topic room:{a}:{b}
	borgo.Push(fmt.Sprintf("room:%s:%s", id, id), "joined", 1)
	// no placeholder: the directive says the topic is exactly this, a
	// literal key like a literal Push would make
	//borgo:topic live
	borgo.Push(liveTopic(), "created", 1)
	// two pushes on one pattern and event union their payloads
	//borgo:topic channel:{id}
	borgo.Push("channel:"+id, "message", "plain")
}

// each on its own line with its own directive at the end: the call on the
// line after a claimed directive does not inherit it
func consecutive(id string) {
	borgo.Push("chat:"+id, "a", 1)   //borgo:topic chat:{id}
	borgo.Push("room:"+id, "b", "s") //borgo:topic room:{id}
}

// what a template literal must escape, and what a literal key must not
func odd(id string) {
	//borgo:topic a`b:{id}
	borgo.Push("a`b:"+id, "e", 1)
	//borgo:topic a\b:{id}
	borgo.Push("a\\b:"+id, "e", 1)
	//borgo:topic ${x}:{id}
	borgo.Push("${x}:"+id, "e", 1)
	//borgo:topic a`b
	borgo.Push(liveTopic()+"x", "e", 1)
	//borgo:topic a\b
	borgo.Push(liveTopic()+"y", "e", 1)
	// a literal topic the pattern admits, with a payload it carries: fine
	borgo.Push("channel:7", "typing", false)
}

// the cap counts literal text in utf-16 units, as the relay counts a topic:
// 127 characters and a placeholder is under it, 128 accented letters are
// 128 units (256 bytes) and under it too
func atTheCap(id string) {
	//borgo:topic xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx{id}
	borgo.Push("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"+id, "e", 1)
	//borgo:topic éééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééééé
	borgo.Push(liveTopic()+"z", "e", 1)
}

// a literal topic the pattern admits, carrying a payload the pattern's
// union holds: fine, it is what the pattern would have said
func narrower() {
	borgo.Push("channel:9", "message", "only a string")
}
