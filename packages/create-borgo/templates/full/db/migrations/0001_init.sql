CREATE TABLE users (
	username TEXT PRIMARY KEY,
	email    TEXT NOT NULL,
	hash     TEXT NOT NULL
);

CREATE TABLE notes (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	title      TEXT NOT NULL,
	body       TEXT NOT NULL,
	created_at TEXT NOT NULL
);
