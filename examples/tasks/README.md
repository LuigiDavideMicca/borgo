# tasks — the borgo demo app

The kitchen-sink app this repository develops against, and the one the Playwright suite runs on. If you want to see every convention working in one place — before writing your own — this is the place.

What it exercises: tasks CRUD through form actions backed by GORM + SQLite, register/login/logout with signed-cookie sessions and CSRF, a loader-guarded page (`/account`), server-sent events and a typed WebSocket topic (`/live`), islands (`/islands`), every hydration mode side by side (`/hydration`), streaming SSR with a deliberately slow section (`/slow`), fast-refresh playground (`/refresh`), custom error pages, and a cached page (`/news`, `revalidate` + `tags`) that the Go handler invalidates the moment a task is written.

## Run it

From the repository root:

```bash
bun install
cd examples/tasks
bun run dev
```

Open http://localhost:3000. The database is a SQLite file (`tasks.db`, or `DB_PATH`) created and migrated at boot; delete it to start fresh.

This app depends on the *workspace* borgo, not the npm package — it is the framework's own test bed, so it always tracks the source in this repository. A standalone app starts from `bunx create-borgo@latest` instead; its `full` template is the closest scaffold to this demo.

## Deploy shape

The `Dockerfile` here builds from the **repository root** (`docker build -f examples/tasks/Dockerfile -t borgo-tasks .`), because it needs the workspace packages; a scaffolded app uses its own generated Dockerfile, which installs borgo from npm. Same runtime shape either way: static Go binary, `oven/bun:slim`, one container.
