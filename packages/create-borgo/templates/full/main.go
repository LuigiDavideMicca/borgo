package main

import (
	"context"
	"log"

	"github.com/LuigiDavideMicca/borgo"

	_ "{{name}}/api"
	"{{name}}/db"
	"{{name}}/env"
)

func main() {
	// env/env.gen.go is written from env.ts by borgo build and borgo dev:
	// DB_PATH and its default are declared there once. The schema is current
	// before anything is served
	if err := db.Open(context.Background(), env.Must().DB_PATH); err != nil {
		log.Fatal(err)
	}

	// this app signs session cookies, and its key lives in .env, generated for
	// this app alone when it was scaffolded. There is deliberately no fallback
	// here: a key compiled into the source is a key every reader has, and one
	// derived from the app's name is public. borgo refuses to issue or accept
	// a session without SESSION_SECRET rather than signing with nothing.
	borgo.Serve()
}
