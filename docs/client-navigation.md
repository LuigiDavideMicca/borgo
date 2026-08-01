# Client navigation and hydration

What happens after the first paint: client-side transitions, prefetching, scroll restoration, per-route code splitting, hydration modes and islands.

## Client-side navigation and code splitting

Plain `<a>` tags become client-side transitions — no `<Link>` component. The runtime intercepts same-origin left clicks (no modifier keys, no `target`, no `download`), fetches the destination's route chunk and its loader props as JSON (`?__borgo=props`) in parallel, swaps the composed tree in place and updates head, history and scroll. Anything it cannot handle — external links, unknown routes, a failed fetch — falls back to a normal full navigation.

The build emits one lazy chunk per route; React, the runtime and layouts live in the shared entry chunk, loaded once.

The same applies to `<form method="post">`: submits run the page action over `fetch` and re-render in place, keeping the scroll position — see [form actions](pages-and-routing.md#form-actions).

A link to the page you are already on refreshes it and replaces the current history entry rather than pushing a duplicate, the way the browser does — otherwise leaving the page would take two presses of the back button. A link to a `#fragment` on the current page is left entirely to the browser.

Nothing is ever taken over that the user asked for explicitly: a middle click, `Ctrl`/`Cmd`-click, `target`, `download`, and any anchor whose click handler called `preventDefault` all behave natively.

## Prefetching

Links scrolled into the viewport get their route chunk prefetched. Hovering, focusing or touching a link additionally prefetches its loader props — hovering waits a beat first, so sweeping the pointer across a list of fifty links does not fire fifty requests at your server; focus and touch are immediate, because both are deliberate.

Prefetched props are kept for ten seconds, consumed by the navigation that follows, and dropped whenever a form action mutates something — so a hover-then-click usually renders with zero waiting, and never renders data the mutation just invalidated. The cache is bounded, and anything evicted has its response body cancelled rather than left dangling.

By design, props arrive as one JSON payload fetched in parallel with the chunk: loader data is not streamed on client navigations. Streaming applies to the initial server render, where it matters most.

## Scroll restoration

Every history entry gets a key; scroll positions are saved per entry in `sessionStorage`, so they survive a reload and a cross-document round trip. Back and forward restore the saved position, a new navigation goes to the top or to the `#fragment` target, and an action that redirects back to the page you were on leaves you exactly where you were.

## Partial hydration

A page may export `hydrate` (as a literal, so the build can read it without executing the page):

- `export const hydrate = false` — the page is server-rendered HTML only: no props script, no client bundle, no route chunk built. Right for pure content pages; classic form actions still work, and links on it are normal full navigations. These pages also [export statically](deploy.md#static-export) with zero JavaScript.
- `export const hydrate = "visible"` — the entry loads, but the page's chunk is fetched and hydrated only when the element marked `data-borgo-visible` (or the page root, if unmarked) scrolls into view. Right for pages whose interactive part sits below a long read.

The default is eager hydration. Client-side navigation *to* a `"visible"` page hydrates it immediately — the deferral applies to the initial load, where the HTML is already on screen.

## Islands

For finer granularity than the page, drop a component in `islands/` and mark it in any page:

```tsx
import { Island } from "borgo-framework";

export const hydrate = false; // the page ships no page bundle at all

export default function Guide() {
  return (
    <article>
      {/* ...static content... */}
      <Island name="Counter" props={{ start: 5 }} />
      <Island name="Counter" props={{ start: 0 }} client="visible" />
    </article>
  );
}
```

On a `hydrate = false` page each island hydrates independently — through a small dedicated entry that touches only the island markers — so a content page can carry a search box without hydrating anything else. `client="visible"` waits until the island scrolls into view. On normally hydrated pages `<Island>` renders inline as part of the page tree.

The tradeoff, stated: island modules are registered eagerly, so their code rides with the client entry (and the islands entry loads React). `client="visible"` defers the hydration *work*, not the download. Props must be JSON-serializable — they are inlined into the island's HTML marker, and one island with an unreadable marker is skipped without stopping the others on the page.

## When the client cannot cope

Every failure mode falls back to something that works rather than to a broken page:

| Situation | What happens |
| --- | --- |
| Route chunk fails to load (a deploy changed the hashes) | full navigation to the destination |
| Loader props fetch fails | full navigation |
| The destination is not a known route | full navigation |
| A loader redirects to another origin | the browser navigates there |
| A redirect chain exceeds ten hops | full navigation, rather than looping forever |
| A redirect with a `javascript:` or `data:` scheme | refused; a navigation falls back to a full load of the link target, a form submit reloads |
| The server answers a submit with something unparseable | reload, so the page reflects whatever the mutation did |

The runtime never leaves a mutation in an unknown state silently: if it cannot interpret the answer, it goes and asks the server again.
