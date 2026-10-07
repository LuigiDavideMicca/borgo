package db

import (
	"log"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"tasks/env"
)

var DB *gorm.DB

func Connect() {
	// env.ts declares DB_PATH and its default; env/env.gen.go reads it
	// with the same rules, so the default lives in one place
	var err error
	DB, err = gorm.Open(sqlite.Open(env.Must().DB_PATH), &gorm.Config{})
	if err != nil {
		log.Fatal("can't open database: ", err)
	}
}

func Migrate(models ...any) {
	if err := DB.AutoMigrate(models...); err != nil {
		log.Fatal("migration failed: ", err)
	}
}
