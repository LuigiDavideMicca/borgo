# create-borgo

Scaffolds a new [borgo](https://github.com/LuigiDavideMicca/borgo) app: file-based React pages server-rendered by Bun, API routes written in Go.

```bash
bunx create-borgo@latest my-app
cd my-app
bun install
go mod tidy
bun run dev
```

Three templates:

- `base` *(default)* — a guided tour: a loader-backed page, a form action, a zero-JS page with an island, live server-sent events from a goroutine.
- `minimal` — bare bones: one page, one Go route.
- `full` — a working app skeleton: notes CRUD, register/login/logout with sessions and CSRF, a protected page, SSE refresh and a typed WebSocket channel (in-memory stores, ready to swap for a real database).

Pick one with `--template` (`-t`); in an interactive terminal `create-borgo` asks, anywhere else (CI, piped stdin) it defaults to `base`. It also asks about Tailwind — or take `--tailwind` (`--no-tailwind` to skip the question): the scaffold arrives wired, with the deps, a `style.css` and the `--tailwind` flag already in every script.

```bash
bunx create-borgo@latest my-app --template full --tailwind
```

Requires Bun >= 1.3 and Go >= 1.25. Every scaffold ships pages, a Go `api/` package with `//borgo:route` handlers, pregenerated api types (so the typed client works before the first dev run), a multi-stage Dockerfile and a compose file — see the [repository README](https://github.com/LuigiDavideMicca/borgo) for the full picture.

---

Built by [Luigi Micca](https://luigimicca.com).
