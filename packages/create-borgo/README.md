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

`--yes` (`-y`) takes every default without asking a thing.

- **tailwind** — the scaffold arrives wired for Tailwind v4: the deps, a `style.css`, and the `--tailwind` flag appended to the three scripts that build CSS — `dev`, `build` and `start`. `doctor` does not take it and does not get it.
- **linter** — `biome` writes `biome.json`; `eslint` writes a flat `eslint.config.js` plus `.prettierrc`. Either way you get the same two scripts, `bun run lint` and `bun run format`, and a fresh scaffold passes its own lint.
- **git** — `git init` plus an initial commit, so the scaffold is undoable from the first second. Skipped when the target is already inside a repository.
- **docker** — keeps the multi-stage `Dockerfile`, `docker-compose.yml` and `.dockerignore`.
- **vscode** — `.vscode/extensions.json` recommends the Go extension plus the ones matching your Tailwind and linter choices. `settings.json` follows the linter answer: with `biome` or `eslint` it turns format-on-save on and names the formatter those extensions provide; with `none` it turns format-on-save **off** for everything except Go, because nothing would format a `.ts` or `.tsx` file and a silent no-op on every save is worse than an honest setting.

```bash
bunx create-borgo@latest my-app --template full --tailwind --linter biome
bunx create-borgo@latest ci-app --yes --no-git --no-docker
```

Requires Bun >= 1.3 and Go >= 1.25. Every scaffold ships pages, a Go `api/` package with `//borgo:route` handlers and pregenerated api types (so the typed client works before the first dev run) — see the [repository README](https://github.com/LuigiDavideMicca/borgo) for the full picture.

---

Built by [Luigi Micca](https://luigimicca.com).
