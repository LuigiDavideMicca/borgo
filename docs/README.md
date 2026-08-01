# borgo docs

Start with [getting started](getting-started.md) if you have not built anything yet; everything else is a deep dive on one convention the [README](../README.md) summarizes. Each page opens with what it covers and ends with the honest limits of what it describes — skim the index, read what you need.

Every TypeScript and Go example on these pages is compiled by CI against the real framework types. If a snippet appears here, it builds.

| Page | One line |
| --- | --- |
| [Getting started](getting-started.md) | build a small app end to end: a page, a Go route, a loader, a form action, an island |
| [Pages and routing](pages-and-routing.md) | pages and loaders, layouts, `<head>` management, streaming SSR, form actions, error pages |
| [The typed bridge](typed-bridge.md) | Go API routes, borgogen, typed request bodies, type overrides, honest limits |
| [Client navigation and hydration](client-navigation.md) | client-side transitions, prefetching, scroll restoration, code splitting, hydration modes, islands |
| [Realtime](realtime.md) | server-sent events, WebSocket topics, typed event payloads, `borgo.Push`/`PushT` |
| [Auth and sessions](auth-and-sessions.md) | signed-cookie sessions, password hashing, `borgo.Auth`, guards on both sides of the bridge |
| [Security](security.md) | the default posture: headers, CSP and nonces, CSRF, cookie rules, limits and timeouts, and what borgo leaves to you |
| [Dev experience](dev-experience.md) | fast refresh and its contract, styling and Tailwind, the error overlay, `borgo doctor` |
| [PWA](pwa.md) | manifest, service worker, the precache list, guarded registration |
| [Deploy](deploy.md) | Docker, compose, reverse proxy, systemd, static export, caching, health and metrics, environment reference |
| [FAQ and troubleshooting](faq-and-troubleshooting.md) | the questions people ask, and symptoms with their one-line fixes |

## Where to start

**Building your first app** — start with [getting started](getting-started.md), which takes you from `bunx create-borgo@latest` to a working feature in about twenty minutes. Then read in this order; each page builds on the one before:

1. [Pages and routing](pages-and-routing.md) — the page model everything else hangs off
2. [The typed bridge](typed-bridge.md) — how Go handlers become typed TypeScript calls
3. [Client navigation and hydration](client-navigation.md) — what happens after the first paint
4. [Auth and sessions](auth-and-sessions.md) and [realtime](realtime.md) — when the app needs them
5. [Dev experience](dev-experience.md) — worth ten minutes once, so the dev loop never surprises you

**Running an app in production** — [deploy](deploy.md) is self-contained: pick a layout (single container, two services, systemd), put a reverse proxy in front, wire `/healthz`, and keep the [environment reference](deploy.md#environment-reference) at hand. [Static export](deploy.md#static-export) is there too, for the pages that need no server. Read [security](security.md) once before the first deploy — it ends with a checklist.

**Reviewing borgo for your team** — [security](security.md) states the default posture and, just as importantly, what borgo deliberately does not do; the [typed bridge](typed-bridge.md) and [what this is not](../README.md#what-this-is-not) cover the honest limits of the rest.
