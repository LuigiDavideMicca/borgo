package db

import (
	"context"
	"database/sql"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func scratch(t *testing.T) *sql.DB {
	t.Helper()
	// the pragmas Open uses, so foreign keys are enforced as in the app
	conn, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "t.db")+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func files(m map[string]string) fstest.MapFS {
	fsys := fstest.MapFS{}
	for name, body := range m {
		fsys[name] = &fstest.MapFile{Data: []byte(body)}
	}
	return fsys
}

func tables(t *testing.T, conn *sql.DB) string {
	t.Helper()
	rows, err := conn.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		rows.Scan(&n)
		names = append(names, n)
	}
	return strings.Join(names, ",")
}

func TestMigrateAppliesInOrderOnce(t *testing.T) {
	conn := scratch(t)
	ctx := context.Background()
	// the second depends on the first: name order, not map order
	fsys := files(map[string]string{
		"0002_b.sql": `ALTER TABLE a ADD COLUMN extra TEXT;`,
		"0001_a.sql": `CREATE TABLE a (id INTEGER); CREATE TABLE a2 (id INTEGER);`,
	})
	if err := Migrate(ctx, conn, fsys); err != nil {
		t.Fatal(err)
	}
	if got := tables(t, conn); got != "a,a2,schema_migrations" {
		t.Errorf("tables: %s", got)
	}
	// again: nothing reapplied (ALTER ... ADD COLUMN twice would fail)
	if err := Migrate(ctx, conn, fsys); err != nil {
		t.Errorf("second run: %v", err)
	}
	fsys["0003_c.sql"] = &fstest.MapFile{Data: []byte(`CREATE TABLE c (id INTEGER);`)}
	if err := Migrate(ctx, conn, fsys); err != nil || tables(t, conn) != "a,a2,c,schema_migrations" {
		t.Errorf("a new file: %v %s", err, tables(t, conn))
	}
	var n int
	conn.QueryRow(`SELECT count(*) FROM schema_migrations`).Scan(&n)
	if n != 3 {
		t.Errorf("%d recorded", n)
	}
}

// a migration that ran is history: editing it, or losing it, refuses
func TestMigrateRefusesARewrittenHistory(t *testing.T) {
	conn := scratch(t)
	ctx := context.Background()
	if err := Migrate(ctx, conn, files(map[string]string{"0001_a.sql": `CREATE TABLE a (id INTEGER);`})); err != nil {
		t.Fatal(err)
	}
	err := Migrate(ctx, conn, files(map[string]string{"0001_a.sql": `CREATE TABLE a (id INTEGER, name TEXT);`}))
	if err == nil || !strings.Contains(err.Error(), "0001_a.sql changed after it was applied") {
		t.Errorf("edited: %v", err)
	}
	err = Migrate(ctx, conn, files(map[string]string{"0002_b.sql": `CREATE TABLE b (id INTEGER);`}))
	if err == nil || !strings.Contains(err.Error(), "0001_a.sql was applied to this database and is not in this build") {
		t.Errorf("missing: %v", err)
	}
	if got := tables(t, conn); got != "a,schema_migrations" {
		t.Errorf("a refused run changed the schema: %s", got)
	}
}

// a migration that fails leaves nothing of itself, and is not recorded
func TestMigrateRollsBackAFailedMigration(t *testing.T) {
	conn := scratch(t)
	ctx := context.Background()
	err := Migrate(ctx, conn, files(map[string]string{
		"0001_a.sql": `CREATE TABLE a (id INTEGER);`,
		"0002_b.sql": `CREATE TABLE b (id INTEGER); INSERT INTO nowhere VALUES (1);`,
	}))
	if err == nil || !strings.Contains(err.Error(), "0002_b.sql") {
		t.Errorf("want the failing file named: %v", err)
	}
	if got := tables(t, conn); got != "a,schema_migrations" {
		t.Errorf("tables: %s", got)
	}
	var names []string
	rows, _ := conn.Query(`SELECT name FROM schema_migrations`)
	for rows.Next() {
		var n string
		rows.Scan(&n)
		names = append(names, n)
	}
	rows.Close()
	if strings.Join(names, ",") != "0001_a.sql" {
		t.Errorf("recorded: %v", names)
	}
}

// a directory beside the migrations is not one of them
func TestMigrateLeavesDirectoriesAlone(t *testing.T) {
	fsys := files(map[string]string{"0001_a.sql": `CREATE TABLE a (id INTEGER);`, "old/notes.txt": "x"})
	if err := Migrate(context.Background(), scratch(t), fsys); err != nil {
		t.Error(err)
	}
}

func TestMigrateRefusesANameWithNoPlaceInTheOrder(t *testing.T) {
	for _, name := range []string{"init.sql", "1_init.sql", "10_x.sql", "0001-init.sql", "0001_init.SQL", "0001_.sql"} {
		err := Migrate(context.Background(), scratch(t), files(map[string]string{name: `SELECT 1;`}))
		if err == nil || !strings.Contains(err.Error(), "has no place in the order") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// the embedded migrations apply to a fresh file, which is what Open does -
// every one of them, the app's own included, so a new migration is checked
// here without editing this test
func TestOpenAppliesTheEmbeddedMigrations(t *testing.T) {
	if err := Open(context.Background(), filepath.Join(t.TempDir(), "app.db")); err != nil {
		t.Fatal(err)
	}
	defer DB.Close()
	names, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil || len(names) == 0 {
		t.Fatalf("embedded migrations: %v %v", names, err)
	}
	var applied int
	DB.QueryRow(`SELECT count(*) FROM schema_migrations`).Scan(&applied)
	if applied != len(names) {
		t.Errorf("%d of %d migrations applied", applied, len(names))
	}
	if got := tables(t, DB); !strings.Contains(got, "notes") || !strings.Contains(got, "users") {
		t.Errorf("tables: %s", got)
	}
}

// one file checked out with CRLF on windows and LF in a linux build is one
// migration (found by the verifier of phase 6)
func TestMigrateReadsCRLFAndLFAsOneFile(t *testing.T) {
	conn := scratch(t)
	ctx := context.Background()
	lf := "CREATE TABLE a (id INTEGER);" + string(rune(10)) + "CREATE TABLE b (id INTEGER);" + string(rune(10))
	crlf := strings.ReplaceAll(lf, string(rune(10)), string(rune(13))+string(rune(10)))
	if err := Migrate(ctx, conn, files(map[string]string{"0001_a.sql": lf})); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, conn, files(map[string]string{"0001_a.sql": crlf})); err != nil {
		t.Errorf("the same text with CRLF: %v", err)
	}
}

const parentChild = `
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE);
INSERT INTO users VALUES (1, 'ann');
INSERT INTO notes VALUES (1, 1);
`

// sqlite's own recipe for changing a table - create, copy, drop, rename -
// must not cascade the drop into the child table (found by the verifier of
// phase 6), and foreign keys are on again afterwards
func TestMigrateRebuildsAParentTableWithoutLosingItsChildren(t *testing.T) {
	conn := scratch(t)
	conn.SetMaxOpenConns(1)
	ctx := context.Background()
	err := Migrate(ctx, conn, files(map[string]string{
		"0001_a.sql": parentChild,
		"0002_b.sql": `
CREATE TABLE users_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '');
INSERT INTO users_new SELECT id, name FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
`,
	}))
	if err != nil {
		t.Fatal(err)
	}
	var notes, on int
	conn.QueryRow(`SELECT count(*) FROM notes`).Scan(&notes)
	conn.QueryRow(`PRAGMA foreign_keys`).Scan(&on)
	if notes != 1 || on != 1 {
		t.Errorf("notes left %d, foreign keys %d", notes, on)
	}
}

// with the keys off during a migration, what it leaves dangling is caught
// before the commit, and nothing of it stays
func TestMigrateRefusesAMigrationThatLeavesRowsDangling(t *testing.T) {
	conn := scratch(t)
	ctx := context.Background()
	err := Migrate(ctx, conn, files(map[string]string{
		"0001_a.sql": parentChild,
		"0002_b.sql": `INSERT INTO notes VALUES (2, 99);`,
	}))
	if err == nil || !strings.Contains(err.Error(), "0002_b.sql") || !strings.Contains(err.Error(), "foreign_key_check") {
		t.Fatalf("want the dangling row refused: %v", err)
	}
	var n int
	conn.QueryRow(`SELECT count(*) FROM notes`).Scan(&n)
	if n != 1 {
		t.Errorf("%d notes", n)
	}
}

// a plain directory embed skipped _0002_x.sql in silence, and so did the
// runner's own listing of hidden names: a hidden or underscored .sql is
// refused by name, while what a file manager leaves beside the files is not
// a migration at all (found by hunt 3)
func TestMigrateRefusesAHiddenMigrationAndIgnoresTheClutter(t *testing.T) {
	for _, name := range []string{"_0002_x.sql", ".0002_x.sql"} {
		err := Migrate(context.Background(), scratch(t), files(map[string]string{"0001_a.sql": `CREATE TABLE a (id INTEGER);`, name: `SELECT 1;`}))
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s: %v", name, err)
		}
	}
	err := Migrate(context.Background(), scratch(t), files(map[string]string{"0001_a.sql": `CREATE TABLE a (id INTEGER);`, ".DS_Store": "x", ".gitkeep": "", "._0001_a.sql": "mac resource fork"}))
	if err != nil {
		t.Errorf("clutter beside the migrations: %v", err)
	}
}

// a COMMIT in the file ended the runner's transaction half way: what came
// after ran outside it, a failure there left the first half applied and
// unrecorded, and every later boot failed on "table already exists" (found
// by hunt 3). A trigger's BEGIN ... END is not a transaction
func TestMigrateRefusesATransactionOfItsOwn(t *testing.T) {
	for _, body := range []string{
		"CREATE TABLE a (id INTEGER);\nCOMMIT;\nCREATE TABLE b (id INTEGER);",
		"BEGIN TRANSACTION;\nCREATE TABLE a (id INTEGER);",
		"begin;\nCREATE TABLE a (id INTEGER);",
		"CREATE TABLE a (id INTEGER);\n  rollback",
		"CREATE TABLE a (id INTEGER);\r\nCOMMIT;\r\nCREATE TABLE b (id INTEGER);",
		"CREATE TABLE a (id INTEGER);\nCOMMIT; -- done\nCREATE TABLE b (id INTEGER);",
		"CREATE TABLE a (id INTEGER); COMMIT; CREATE TABLE b (id INTEGER);",
		"CREATE TABLE a (id INTEGER);\nCOMMIT /* x */;\nCREATE TABLE b (id INTEGER);",
		"CREATE TABLE a (id INTEGER);\nEND;\nCREATE TABLE b (id INTEGER);",
		"CREATE TABLE a (id INTEGER);\nEND TRANSACTION;",
		"CREATE TABLE a (id INTEGER);\nCOMMIT;\f\nCREATE TABLE b (id INTEGER);",
		"SAVEPOINT s;\nCREATE TABLE a (id INTEGER);",
		"CREATE TABLE a (id INTEGER);\n-- the second half\nCOMMIT;",
		"CREATE TABLE a (id INTEGER);\n/* the second half */ COMMIT;",
	} {
		conn := scratch(t)
		err := Migrate(context.Background(), conn, files(map[string]string{"0001_a.sql": body}))
		if err == nil || !strings.Contains(err.Error(), "transaction of its own") {
			t.Errorf("%q: %v", body, err)
		}
		// refused before anything ran
		if got := tables(t, conn); got != "schema_migrations" {
			t.Errorf("%q left tables behind: %s", body, got)
		}
	}
	// a trigger's BEGIN ... END, quoted text and comments are not transactions
	for _, body := range []string{
		"CREATE TABLE a (id INTEGER, n INTEGER);\nCREATE TRIGGER bump AFTER INSERT ON a\nBEGIN\n  UPDATE a SET n = 1 WHERE id = NEW.id;\nEND;",
		"CREATE TABLE a (id INTEGER, note TEXT DEFAULT 'BEGIN;');",
		"CREATE TABLE a (id INTEGER, note TEXT DEFAULT 'a;\nend of note');",
		"CREATE TABLE a (id INTEGER);\n/* COMMIT;\n*/\nCREATE TABLE b (id INTEGER);",
		"CREATE TABLE a (\n  id INTEGER,\n  \"commit\" TEXT\n);",
		"CREATE TABLE a (id INTEGER, n INTEGER);\r\nCREATE TRIGGER bump AFTER INSERT ON a\r\nBEGIN\r\n  UPDATE a SET n = CASE WHEN n IS NULL THEN 1 ELSE n END WHERE id = NEW.id;\r\nEND;",
	} {
		if err := Migrate(context.Background(), scratch(t), files(map[string]string{"0001_a.sql": body})); err != nil {
			t.Errorf("%q: %v", body, err)
		}
	}
}
