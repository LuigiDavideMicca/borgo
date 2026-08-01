# PWA

Making a borgo app installable and able to serve its own assets offline. One command writes the files, two one-line edits wire them up, and the rest of this page explains what you got so you can change it.

## Set it up

```bash
bunx borgo pwa init
```

That writes two files into `public/`:

- **`manifest.webmanifest`** — the install metadata: your app's name, colors taken from borgo's palette, `display: standalone`, and icon entries. Edit the names and colors; they are yours.
- **`sw.js`** — a working service worker, described below.

Then the two lines the command prints. In `index.html`, inside `<head>`:

```html
<link rel="manifest" href="/manifest.webmanifest" />
```

And in a page or layout that hydrates:

```tsx
import { useEffect } from "react";
import { registerServiceWorker } from "borgo-framework";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  useEffect(() => registerServiceWorker(), []);
  return <div className="app">{children}</div>;
}
```

The manifest references `/icon-192.png` and `/icon-512.png`, which you supply — a browser will install the app without them, but it will not look like yours.

## What the generated worker does

It caches **build output only**: the JavaScript chunks and stylesheet that `borgo build` produced, listed in `/assets/precache.json` together with a `stamp`:

```json
{ "stamp": "8713…", "assets": ["/assets/client.js", "/assets/style.css", "…"] }
```

The stamp is a hash of that content, so it changes exactly when the build output changes — and *does not* change when a rebuild produces identical bytes.

The worker does **not** read that stamp at runtime. It carries its own copy, as the first line of code in the file:

```js
const BUILD = "8713…";
const CACHE = "app-" + BUILD;
```

`borgo build` rewrites that one line in `public/sw.js` on every production build, and rewriting it is the entire mechanism. A service worker reinstalls only when **its own bytes** change: the browser byte-compares the file it fetches against the one it is running, and if they are identical it keeps the old worker and never fires `install` again. A worker that read the stamp from `precache.json` would have fixed bytes, so `install` — the only thing that fills a cache — would run once ever and `activate` — the only thing that prunes — would never run again. Every deploy after the first would be shadowed by the first one's cache, for as long as the site data lives.

So: on install the worker fills `app-<BUILD>`; on activate it deletes every other `app-*` cache and claims open tabs; on fetch it answers same-origin `/assets/` requests out of `app-<BUILD>` specifically (never a bare `caches.match`, which searches every cache oldest-first and would answer for a deploy that has not been pruned yet), falling through to the network for everything else.

`sw.js` is served from the site root with `Cache-Control: no-cache`, so a browser re-checks it on every deploy rather than running last week's worker.

### If you edit `sw.js`, keep the `BUILD` line

The generated file says so in its own header, and it is the one comment in it that is load-bearing. `borgo build` finds the line by matching `^const BUILD = "…";` exactly, on its own line. Anything else you do to the worker survives a rebuild untouched — but if that line is renamed, reformatted, moved into a template literal or deleted, the match fails, **the build stamps nothing and says nothing about it**, and you are back to the fixed-bytes failure above: the first deploy's cache serves your app forever, and the only cure is every user clearing their site data.

If you want a worker borgo does not manage, that is fine — write one without the line and know that cache invalidation is now yours. What you should not do is edit the line by accident and assume the build would have complained.

## What it deliberately does not cache

**Documents.** Server-rendered pages are dynamic and session-dependent, and they ship `Cache-Control: private, no-store`. A blanket document cache in a service worker is how one user ends up looking at another user's page. If you want an offline experience, cache a dedicated offline page and serve *that* on a failed navigation, rather than caching real pages:

```js
// in sw.js, added to the fetch handler - leave `const BUILD = "…";` alone
if (event.request.mode === "navigate") {
  event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html")));
}
```

**`/api/` responses.** Same reasoning, plus mutations. Cache what your app decides is safe, explicitly, per route.

**`precache.json` itself.** It lives under `/assets/`, so the cache-first rule would otherwise swallow it, and a new worker would then install an old build's asset list out of a stale cache. The generated worker excludes it by path and fetches it `no-store`.

## Registration, and why it refuses in dev

`registerServiceWorker(path = "/sw.js")` no-ops server-side, in browsers without support, and **in development**. That last one is deliberate: a caching worker attached to a dev server will serve you yesterday's chunks while you edit, and you will spend an afternoon convincing yourself that fast refresh is broken. Production builds register normally.

The dev guard has one hole, and it fails open. It reads a flag the server writes into the props script — so on a page with `hydrate = false`, which ships no props script, the flag is absent and the call registers the worker even under `borgo dev`. Such a page can still run islands, and an island is exactly where you would call this. If you register from an island, put the page's own `hydrate` back on, or guard the call yourself.

If you need to test the worker locally, run a production build: `bun run build && bun run start`.

## Caveats, honestly

- A service worker outlives your deploys. Ship one only if you are prepared to debug it — an app that is wrong for one user, forever, because of a cached worker is a worse failure than a slow first paint. The dev guard is the first line of that defense; the restamped `BUILD` line is the second, and it only defends you while it is still there for the build to find.
- `borgo export` output is plain static files, and a worker works there too — but `precache.json` lists build assets, not exported pages, so an offline-capable static site needs its asset list extended.
- Nothing here makes your app work offline by itself. It makes the shell load instantly and survive a flaky connection. Real offline means deciding what your data layer does without a network, which is your app's design, not the framework's.
