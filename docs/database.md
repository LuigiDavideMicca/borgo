# The database

borgo imposes no database and grows no ORM: the API is a Go program, and every `database/sql` driver works in it unchanged. What it does not do is leave you without a next step. This page is that step: a driver, a schema kept current by a migration runner small enough to read in one sitting, where to call it, and how it behaves with more than one instance. The `full` template scaffolds exactly this, so a new app starts on it rather than on maps in memory.

## A driver

The template uses SQLite through [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite), a pure-Go driver: the binary stays static (`CGO_ENABLED=0` in the Dockerfile keeps working) and nothing needs a C toolchain. It opens the file with two pragmas a web server wants - wait up to five seconds for the write lock instead of failing at once, and enforce foreign keys, which SQLite leaves off by default:

```go no-check
conn, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
```

The migration runner below is SQLite's - `?` placeholders and `PRAGMA foreign_keys` - and needs both adapted before it runs against another database. For Postgres, import a driver such as `github.com/jackc/pgx/v5/stdlib` and open `sql.Open("pgx", url)` - declare the URL in `env.ts` with `type: "url"` so a malformed one refuses the boot by name. The handlers do not change, with one exception every database/sql user meets: SQLite writes placeholders as `?`, Postgres as `$1`, `$2`.

## Migrations

A migration is a `.sql` file in `db/migrations/`, embedded into the binary, named for its place in the order: `0001_init.sql`, `0002_add_tags.sql`. The number is four digits wide so that the order is the name order. At boot, before anything is served, the runner applies every file the database has not recorded, each in a transaction together with the row that records it:

```go no-check
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
	"strings"
)

// a migration is a file named for its place in the order: 0001_init.sql,
// 0002_add_tags.sql. Applied in name order, so the number leads, and it is
// four digits wide: 10_x.sql would otherwise sort before 9_x.sql
var migrationName = regexp.MustCompile(`^[0-9]{4}_[A-Za-z0-9_]+\.sql$`)

// a statement that begins or ends a transaction, alone on its line. A
// trigger's BEGIN ... END is not one: its BEGIN carries no semicolon, and its
// END is left alone
var transactionStatement = regexp.MustCompile(`(?im)^[[:blank:]]*(BEGIN([[:blank:]]+(DEFERRED|IMMEDIATE|EXCLUSIVE))?([[:blank:]]+TRANSACTION)?[[:blank:]]*;|(COMMIT|ROLLBACK)([[:blank:]]+TRANSACTION)?[[:blank:]]*;?)[[:blank:]]*$`)

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
		// what an editor or a file manager leaves beside the files is not a
		// migration that failed to be named: .DS_Store, .gitkeep. A hidden
		// .sql is one, and is refused below
		if strings.HasPrefix(f.Name(), ".") && !strings.HasSuffix(strings.ToLower(f.Name()), ".sql") {
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
		// the runner owns the transaction: a COMMIT inside the file ended it
		// half way, the statements after ran outside it, and a failure there
		// left the first half applied and unrecorded - the next boot then
		// failed on "table already exists" for good (found by hunt 3)
		if line := transactionStatement.FindString(string(body)); line != "" {
			return fmt.Errorf("migrations: %s holds %q: the runner wraps every migration in a transaction of its own", name, strings.TrimSpace(line))
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
```

What it refuses, and why:

- **An applied migration whose bytes changed.** A migration that ran is history: the database already holds what the old text did, and the new text would never run. Undo or amend it in a new file. The checksum is what notices.
- **A recorded migration missing from the build.** That is an older build started against a database a newer one migrated - a rollback of the code without a rollback of the schema. It refuses rather than serve on a schema it does not know.
- **A file with no place in the order.** `init.sql` or `10_x.sql` would apply in an order nobody chose.

A migration that fails rolls back whole and is not recorded, so fixing the file and booting again retries it. That holds where DDL is transactional, as it is in SQLite and Postgres, and as long as the file holds no `BEGIN` or `COMMIT` of its own: the runner owns the transaction, and refuses a file holding a `BEGIN;`, `COMMIT` or `ROLLBACK` line by name - such a line once kept what came before it while the file stayed unrecorded. A trigger's `BEGIN ... END` is not one. MySQL commits each DDL statement on its own: there, keep one statement per migration, so a failure leaves nothing half-done.

Three details are SQLite's, and the runner handles them:

- **Foreign keys are off while a migration runs.** SQLite's own way to change a table - create the new one, copy, drop the old, rename - would otherwise cascade the drop into every child table and delete their rows without an error. The keys are checked with `PRAGMA foreign_key_check` before the commit instead, so a migration that leaves a row pointing at nothing is refused, and turned back on before the connection returns to the pool.
- **The checksum ignores line endings.** A Windows checkout embeds a file with CRLF and a Linux build with LF; both are the same migration, and a database migrated by one boots under the other.
- **The whole directory is embedded**, not `*.sql`: a file the pattern would miss, `0002_tags.SQL`, is refused by name rather than skipped. In development, a changed `.sql` file rebuilds the API like a `.go` file, so a new migration applies at once.

## Where it runs

In `main.go`, before `borgo.Serve`, so nothing is answered on a schema that is not current yet:

```go no-check
func main() {
	// DB_PATH and its default are declared once, in env.ts: env/env.gen.go
	// reads them with the same rules (see the environment page)
	if err := db.Open(context.Background(), env.Must().DB_PATH); err != nil {
		log.Fatal(err)
	}
	borgo.Serve()
}
```

`log.Fatal` is the right answer to a failed migration: the process exits, the supervisor or the container's restart policy brings it back, and the error is the last line in the log.

## More than one instance

Two instances booting at once may both try the same migration. SQLite lets one write at a time: the second waits for the first's lock, up to the five-second busy timeout, and then either finds the work done and the name recorded - failing on the `schema_migrations` primary key, or on the table that now exists - or gives up with `database is locked`. Either way it rolls back and exits, and restarted it finds the migration recorded and boots. With SQLite there is one machine and one file, so this is a rolling restart at most. With Postgres behind several instances, the cleaner shape is a migration step that runs once per deploy - the same binary with a flag that calls `db.Open` and exits - before the new instances start.

## Tests

Test against a database the test owns: a file in `t.TempDir()`, not `:memory:`. An in-memory SQLite database belongs to one connection, and `database/sql` keeps a pool of them, so a second connection sees an empty database. The template's `db/migrate_test.go` does this, applying migrations from an `fstest.MapFS`.

## In a container

The scaffolded Dockerfile creates `/data` owned by the app's user. The `full` template's Dockerfile sets `DB_PATH=/data/app.db`, so `docker run` works as it is, and its `docker-compose.yml` mounts a volume at `/data`, so the database outlives the container; `borgo deploy init compose` writes the same volume for any app with `db/migrations/`. A volume mounted at a path the image does not have is created root-owned and the app cannot write there; [deploy](deploy.md) has the details.
