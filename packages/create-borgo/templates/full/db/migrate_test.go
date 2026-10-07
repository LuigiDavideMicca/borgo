package db

import (
	"context"
	"database/sql"
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

// the embedded migrations apply to a fresh file, which is what Open does
func TestOpenAppliesTheEmbeddedMigrations(t *testing.T) {
	if err := Open(context.Background(), filepath.Join(t.TempDir(), "app.db")); err != nil {
		t.Fatal(err)
	}
	defer DB.Close()
	if got := tables(t, DB); got != "notes,schema_migrations,users" {
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
