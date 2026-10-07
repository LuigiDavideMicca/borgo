package db

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"fmt"
	"io/fs"
	"regexp"
	"slices"
)

// a migration is a file named for its place in the order: 0001_init.sql,
// 0002_add_tags.sql. Applied in name order, so the number leads, and it is
// four digits wide: 10_x.sql would otherwise sort before 9_x.sql
var migrationName = regexp.MustCompile(`^[0-9]{4}_[A-Za-z0-9_]+\.sql$`)

// Migrate applies every migration in fsys that the database has not seen,
// in name order, each in a transaction with the row that records it. A
// migration that ran is history: an applied file whose bytes changed refuses,
// and so does a recorded one missing from fsys - an older build started
// against a newer database. Fix forward with a new file instead. A file
// must not hold BEGIN or COMMIT of its own: the runner owns the transaction.
//
// Written for sqlite: the placeholders are ?, where postgres wants $1, $2,
// and apply turns sqlite's foreign keys off around each migration.
func Migrate(ctx context.Context, db *sql.DB, fsys fs.FS) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		name       TEXT PRIMARY KEY,
		checksum   TEXT NOT NULL,
		applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		return fmt.Errorf("migrations: %w", err)
	}

	// ReadDir returns the entries sorted by name, which is the order
	files, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return fmt.Errorf("migrations: %w", err)
	}
	var names []string
	for _, f := range files {
		if f.IsDir() {
			continue
		}
		if !migrationName.MatchString(f.Name()) {
			return fmt.Errorf("migrations: %s is not named NNNN_what.sql, so it has no place in the order", f.Name())
		}
		names = append(names, f.Name())
	}

	applied := map[string]string{}
	rows, err := db.QueryContext(ctx, `SELECT name, checksum FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("migrations: %w", err)
	}
	for rows.Next() {
		var name, sum string
		if err := rows.Scan(&name, &sum); err != nil {
			rows.Close()
			return fmt.Errorf("migrations: %w", err)
		}
		applied[name] = sum
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("migrations: %w", err)
	}
	for name := range applied {
		if !slices.Contains(names, name) {
			return fmt.Errorf("migrations: %s was applied to this database and is not in this build - is an older build running against a newer database?", name)
		}
	}

	for _, name := range names {
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return fmt.Errorf("migrations: %w", err)
		}
		// the checksum of the text, not of the line endings: a windows
		// checkout and a linux build embed one file with CRLF and LF, and
		// must agree it is the one that ran (found by the verifier of phase 6)
		digest := sha256.Sum256(bytes.ReplaceAll(body, []byte("\r\n"), []byte("\n")))
		sum := hex.EncodeToString(digest[:])
		if was, ok := applied[name]; ok {
			if was != sum {
				return fmt.Errorf("migrations: %s changed after it was applied - a migration that ran is history; undo it in a new file", name)
			}
			continue
		}
		if err := apply(ctx, db, name, string(body), sum); err != nil {
			return fmt.Errorf("migrations: %s: %w", name, err)
		}
	}
	return nil
}

func apply(ctx context.Context, db *sql.DB, name, body, sum string) error {
	// one connection of the pool, with foreign keys off for the migration:
	// the table rebuild sqlite documents (create, copy, drop, rename) would
	// otherwise cascade the drop through every child table and delete their
	// rows in silence (found by the verifier of phase 6). The pragma is a
	// no-op inside a transaction, hence before it; the keys are checked
	// before the commit instead, and turned back on before the connection
	// returns to the pool - or it never returns
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		return err
	}
	defer func() {
		if _, err := conn.ExecContext(context.Background(), `PRAGMA foreign_keys = ON`); err != nil {
			conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()

	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, body); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	dangling := rows.Next()
	rows.Close()
	if dangling {
		return fmt.Errorf("it leaves rows referring to rows that do not exist (see PRAGMA foreign_key_check)")
	}
	// an instance migrating at the same moment waits here for the other's
	// lock, up to the busy timeout, and then either fails or finds the name
	// taken: either way it exits, and boots on the next try
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)`, name, sum); err != nil {
		return err
	}
	return tx.Commit()
}
