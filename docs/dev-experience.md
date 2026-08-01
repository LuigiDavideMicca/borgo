# Dev experience

What `borgo dev` does while you work: what hot-applies and what reloads, how styling is compiled, what happens when a build breaks, and the diagnostics for when the machine — not the code — is the problem. The CLI reference is at the end.

## Fast refresh

`borgo dev` runs both servers and keeps the browser hot over a WebSocket channel (`/__borgo/dev`). What that means concretely, in decreasing order of magic:

- **Component, page and hook edits apply in place** through [react-refresh](https://www.npmjs.com/package/react-refresh) with the full Babel transform (dev builds only). The current route's new chunk is imported, loader props are refetched, and component state survives a body edit. Change a component's *hooks* — add, remove, reorder, or alter a custom hook's signature — and just that component remounts, Next-style; the rest of the page keeps its state. Editing a custom hook's body hot-applies with dependent state intact.
- **Style edits swap the stylesheet in place** — no reload, no state loss.
- **Everything else is a full reload**: layouts and error pages (they live in the shared entry chunk), `index.html`, and any Go change. On a Go edit the API binary is rebuilt while the old one keeps serving, swapped in, and the browser reloads exactly once — *after* the new API actually answers, so you never land on a dead backend.
- **A broken build does not take the port down.** The front server keeps serving the error overlay and the dev channel, and the page reloads itself when the next good save lands.

The mechanics, honestly: an edit restarts the front server so the server module graph is clean. The browser never reloads for that — it reconnects and hot-applies the change from the boot greeting it receives.

Two details you would otherwise discover the hard way. Identical content does not trigger a rebuild: the watcher hashes what it reads, so an editor that touches a file without changing it costs nothing. And the Go rebuild is deduplicated on its *output*, because Windows can deliver a change event while the file is still half-written — a torn read that fails to compile no longer queues a second pointless rebuild.

## Nothing outlives the session

Every process borgo starts watches the one that started it and exits with it. Kill the terminal, kill the task runner, kill `borgo dev` itself with a signal that runs no handlers — the front server and the Go API still go away, releasing their ports and the API binary.

This is not a nicety. Before it existed, a force-killed session left an API process holding `.borgo/api.exe`, and the next `borgo dev` could not swap the binary in; you had to find the orphan in the task manager. If you see that symptom now, `borgo doctor` names the process for you.

## Styling

The default pipeline compiles the single root `style.scss` into `public/assets/style.css` — expanded in dev, compressed in production. Plain CSS is valid SCSS, so you do not need to know Sass to use it.

### Tailwind, opt-in

Tailwind v4 rides behind a CLI flag, never autodetection: your CSS pipeline should not change because a package appeared in `node_modules`.

New projects get it wired by the scaffolder:

```bash
bunx create-borgo@latest my-app --tailwind
```

For an existing app, three steps. Install it:

```bash
bun add tailwindcss @tailwindcss/postcss postcss
```

Create `style.css` in the app root:

```css
@import "tailwindcss";
```

And pass the flag in `package.json`:

```json
{
  "scripts": {
    "dev": "borgo dev --tailwind",
    "build": "borgo build --tailwind",
    "start": "borgo start --tailwind"
  }
}
```

With the flag, Tailwind owns the stylesheet: it scans your pages and islands for class names and rewrites `public/assets/style.css`, minified in production builds. Editing a page hot-applies new utilities through the normal refresh cycle, and editing `style.css` swaps the stylesheet in place. Without the flag, the SCSS pipeline stays in charge and `style.css` is ignored.

borgo drives Tailwind through its PostCSS plugin rather than its CLI, and the reason is worth knowing if you are wiring this by hand: the CLI is a process spawned per rebuild, while the plugin stays in the one borgo already runs — a warm rebuild goes from roughly 300 ms to under 20. It also drops the CLI's native file-watcher dependency, whose install script Bun blocks by default. An app still on `@tailwindcss/cli` keeps working: borgo falls back to it when the plugin is not installed.

One honest edge of staying in-process: within a single long-lived `borgo dev` session, a utility class you *delete* keeps its rule in the stylesheet until you restart. The rule is inert — nothing references the class — and `borgo build` is always a fresh process, so production output is exact.

## The error overlay

In dev, a server-side render error becomes a readable overlay page instead of the production 500. The client runtime also surfaces uncaught errors and unhandled rejections in the browser, in a dismissable overlay showing the stack.

If the *build* is what broke, the fallback server keeps `/__borgo/dev` alive so the page can heal itself: fix the file, and the browser reloads on its own.

## borgo doctor

`bunx borgo doctor` diagnoses the environment — the class of problem that is never in your code:

Fourteen checks, in three groups. A check that has nothing to say about your app — no `package.json`, no `api/`, no playwright dependency, a filesystem that will not report free space — is skipped rather than reported as passing.

| Check | Group | What it catches |
| --- | --- | --- |
| bun | toolchain | not on `PATH`, older than the required minimum, or an npm-installed shim shadowing the real one |
| bun on PATH | toolchain | a `.cmd`/`.bat`/`.ps1` shim resolving ahead of a real `bun.exe` that is also installed — *informational* |
| go | toolchain | missing, or older than your `go.mod` requires |
| node | toolchain | present or not, and its version — borgo needs none, so this is purely *informational* |
| docker | toolchain | not installed, or installed with an unreachable daemon — *informational* |
| port 3000 (front) | machine | `PORT` already in use, naming the process and its pid |
| port 3501 (api) | machine | `API_PORT` already in use, same |
| disk space | machine | less free space than a build wants |
| api binary | project | a stale API process holding `.borgo/api.exe` so dev cannot swap a new build in |
| api types | project | `.borgo/api-types.d.ts` missing, or stale against your `api/*.go` |
| node_modules | project | missing or not installed |
| app deps | project | `borgo-framework`, `react` and `react-dom` present and consistent, and `go.mod` carrying the `borgogen` tool directive |
| write access | project | `.borgo`, `public/assets` or `dist` not writable — a read-only checkout, a synced folder, an antivirus |
| playwright | project | playwright is a dependency but no browsers are installed |

Every failing check prints its one-line fix. The exit code is 1 when a *real* check fails, so you can gate a script on it; the informational ones print a note in blue and are deliberately kept out of it, because not having Docker on a laptop is not a broken environment. On Windows it reads `netstat` by row shape rather than by the English word `LISTENING`, so it still names the process holding a port on a localized system.

## CLI reference

Run these through Bun (`bun run dev`) or directly (`bunx borgo dev`).

| Command | What it does |
| --- | --- |
| `borgo dev` | both servers, file watching, fast refresh, error overlay |
| `borgo build` | generates types, builds client assets into `public/assets/`, compiles the Go binary into `dist/` |
| `borgo start` | runs from the build output, supervising both processes |
| `borgo export` | prerenders exportable pages into `dist/site/` — see [static export](deploy.md#static-export) |
| `borgo deploy init <target>` | writes a deploy config: `caddy`, `nginx`, `systemd` or `compose` — see [deploy](deploy.md#borgo-deploy-init) |
| `borgo pwa init` | writes `public/manifest.webmanifest` and a working `public/sw.js` — see [PWA](pwa.md) |
| `borgo doctor` | environment diagnosis, exit 1 on any failing check that is not informational |

Flags:

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--tailwind` | `dev`, `build`, `start` | compile CSS with Tailwind instead of SCSS |
| `--front-only` | `start` | run the front server alone, for split deployments where the API lives elsewhere (point `API_URL` at it) |
| `--force` | `deploy init`, `pwa init` | overwrite an existing generated file |
| `-h`, `--help`, `-v`, `--version` | — | print the banner and exit 0 |

`borgo build` fails loudly rather than shipping something stale: if type generation fails, the build stops instead of leaving you with yesterday's types. And `borgo start` notices when `public/assets` was last written by `borgo dev` — a development bundle, unminified and uncompressed — and rebuilds it for production instead of serving it silently.

When the problem is not the environment but the framework, [FAQ and troubleshooting](faq-and-troubleshooting.md) collects the symptoms with their fixes.
