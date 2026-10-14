// Package db opens the app's database and keeps its schema current. sqlite
// through a pure-Go driver, so the binary stays static and needs no C
// toolchain; the same database/sql code runs against postgres with its
// driver and the placeholder change noted in migrate.go.
package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"

	_ "modernc.org/sqlite"
)

// the whole directory, not *.sql: a file the pattern missed - 0002_tags.SQL -
// would be skipped in silence, where the runner refuses it by name. all:,
// because a plain directory embed skips names starting with . or _ in
// silence too, and _0003_tags.sql never ran (found by hunt 3)
//
//go:embed all:migrations
var migrations embed.FS

// DB is the app's handle, opened by Open before borgo.Serve.
var DB *sql.DB

// Open opens the sqlite file at path and applies the migrations this build
// carries. Nothing is served until the schema is current.
func Open(ctx context.Context, path string) error {
	// a file database answers one writer at a time: wait for the lock
	// instead of failing, and keep foreign keys on, which sqlite does not
	// by default
	conn, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return fmt.Errorf("db: open %s: %w", path, err)
	}
	if err := conn.PingContext(ctx); err != nil {
		conn.Close()
		return fmt.Errorf("db: open %s: %w", path, err)
	}
	dir, err := fs.Sub(migrations, "migrations")
	if err != nil {
		conn.Close()
		return err
	}
	if err := Migrate(ctx, conn, dir); err != nil {
		conn.Close()
		return err
	}
	DB = conn
	return nil
}
