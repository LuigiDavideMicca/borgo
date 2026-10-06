package main

import (
	"os"

	"github.com/LuigiDavideMicca/borgo"

	"tasks/api"
	"tasks/db"
)

func main() {
	if os.Getenv("SESSION_SECRET") == "" {
		os.Setenv("SESSION_SECRET", "tasks-demo-secret-0123456789abcdef") // demo only: set a real one in production
	}
	db.Connect()
	db.Migrate(&api.Task{}, &api.User{}, &api.Attachment{})
	borgo.Serve()
}
