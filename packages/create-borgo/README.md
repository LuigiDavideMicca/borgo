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

Pick one with `--template` (`-t`); in an interactive terminal `create-borgo` asks, anywhere else (CI, piped stdin) it takes the defaults below without blocking.

## Options

Every question has a flag, so nothing has to be answered interactively. Every *on/off* question also has a `--no-` twin; the two that take a value do not — there is no `--no-template`, and `--no-linter` is spelled that way but simply means `--linter none`.

| Question | Flags | Interactive default | Non-interactive |
| --- | --- | --- | --- |
| template | `-t`, `--template <base\|minimal\|full>` | `base` | `base` |
| tailwind | `--tailwind` / `--no-tailwind` | no | no |
| linter | `--linter <biome\|eslint\|none>` / `--no-linter` | `none` | `none` |
| git | `--git` / `--no-git` | yes | yes |
| docker | `--docker` / `--no-docker` | yes | yes |
| vscode | `--vscode` / `--no-vscode` | yes | yes |
| install | `--install` / `--no-install` | yes | no |
| start | `--start` / `--no-start` | yes | no |

`--yes` (`-y`) takes every default without asking a thing — in a terminal that includes installing and starting.

- **install** and **start** — one question in the prompt, two flags. Both default to on in a terminal and off anywhere else, so a scaffold step in CI exits on its own. `--install` runs `bun install` and `go mod tidy`; `--start` implies `--install` and then blocks on `bun run dev`, in a script too — it is a request for a server, and it gets one. `--no-install` also answers start: without dependencies there is nothing to start, so the manual steps are printed instead.

- **tailwind** — the scaffold arrives wired for Tailwind v4: the deps, a `style.css`, and the `--tailwind` flag appended to the four scripts that compile CSS — `dev`, `build`, `start` and `export`. `doctor` does not take it and does not get it.
- **linter** — `biome` writes `biome.json`; `eslint` writes a flat `eslint.config.js` plus `.prettierrc`. Either way you get the same two scripts, `bun run lint` and `bun run format`, and a fresh scaffold passes its own lint.
- **git** — `git init` plus an initial commit, so the scaffold is undoable from the first second. Skipped when the target is already inside a repository.
- **docker** — keeps the multi-stage `Dockerfile`, `docker-compose.yml` and `.dockerignore`.
- **vscode** — `.vscode/extensions.json` recommends the Go extension plus the ones matching your Tailwind and linter choices. `settings.json` follows the linter answer: with `biome` or `eslint` it turns format-on-save on and names the formatter those extensions provide; with `none` it turns format-on-save **off** for everything except Go, because nothing would format a `.ts` or `.tsx` file and a silent no-op on every save is worse than an honest setting.

```bash
bunx create-borgo@latest my-app --template full --tailwind --linter biome
bunx create-borgo@latest ci-app --yes --no-git --no-docker
```

The `full` template also gets a `.env` with a fresh `SESSION_SECRET` (48 CSPRNG bytes, generated per scaffold; `.env` is gitignored and dockerignored in every template): `bun run` loads it and borgo hands it to the Go binary, so sessions work out of the box and no key ever sits in the source. Keep it out of the repository; `borgo deploy init systemd` reads it from the same file.

Requires Bun >= 1.3 and Go >= 1.25 — `bun run doctor` checks both, plus Docker, permissions and the Bun shim. Every scaffold ships pages, a Go `api/` package with `//borgo:route` handlers and pregenerated api types (so the typed client works before the first dev run) — see the [repository README](https://github.com/LuigiDavideMicca/borgo) for the full picture.

---

Built by [Luigi Micca](https://luigimicca.com).
