package main

import (
	"context"
	"log"
	"os"

	"github.com/LuigiDavideMicca/borgo"

	_ "{{name}}/api"
	"{{name}}/db"
)

func main() {
	// DB_PATH is declared in env.ts with its default; the schema is current
	// before anything is served
	path := os.Getenv("DB_PATH")
	if path == "" {
		path = "app.db"
	}
	if err := db.Open(context.Background(), path); err != nil {
		log.Fatal(err)
	}

	// this app signs session cookies, and its key lives in .env, generated for
	// this app alone when it was scaffolded. There is deliberately no fallback
	// here: a key compiled into the source is a key every reader has, and one
	// derived from the app's name is public. borgo refuses to issue or accept
	// a session without SESSION_SECRET rather than signing with nothing.
	borgo.Serve()
}
