# Pages and routing

The page model everything else hangs off: how files become routes, how a page gets its data, how layouts nest, what `<head>` you control, how forms mutate, and what happens when something goes wrong.

## Files are routes

React components in `pages/`, routed by file name. There is no route configuration file to keep in sync:

| File | Route |
| --- | --- |
| `pages/index.tsx` | `/` |
| `pages/about.tsx` | `/about` |
| `pages/tasks/index.tsx` | `/tasks` |
| `pages/tasks/[id].tsx` | `/tasks/:id` |
| `pages/orgs/[org]/members/[id].tsx` | `/orgs/:org/members/:id` |

A `[param]` segment matches exactly one path segment; there are no catch-all or optional segments. Trailing slashes are ignored when matching, so `/tasks/` and `/tasks` are the same route. **A leading underscore means "not a route."** Every file in `pages/` whose basename starts with `_` is excluded from the route table; three of them are then given a job instead — `_layout.tsx` wraps its directory, `_404.tsx` and `_500.tsx` become the error pages. Any other `_`-prefixed file is simply never served: `pages/_helpers.tsx` builds and ships nothing, silently. Put shared components in `components/` rather than `pages/_components/`, so the build has a reason to look at them.

## Loaders

A page may export a `loader` that runs on the server before rendering. Whatever it returns becomes the component's props:

```tsx
import type { LoaderContext } from "borgo-framework";
import type { Task } from "../.borgo/api-types";

export async function loader({ params, api }: LoaderContext) {
  const { task } = await api("GET /api/tasks/{id}", { params: { id: params.id } });
  return { task };
}

export default function TaskDetail({ task }: { task: Task }) {
  return (
    <main>
      <h1>{task.title}</h1>
      <p>{task.body}</p>
    </main>
  );
}
```

The loader receives `{ request, params, api, apiUrl }`. `params` is `Record<string, string>` — every value is a string, decoded, exactly as it appeared in the URL. `api` is the [typed client](typed-bridge.md#the-generated-client); `apiUrl` is the raw base URL for anything it does not model.

Loader code is stripped from client bundles at build time, so server-only imports, database handles and secrets used there never reach the browser.

The loader runs on the initial server render *and* on client-side navigations to that page — in the second case the client fetches its result as JSON rather than re-rendering the document. You do not write anything different for the two cases.

### A loader can answer instead of returning props

Return a `Response` and rendering is skipped. `redirect(to, status = 303)` makes that an auth guard:

```tsx
import { ApiError, redirect, type LoaderContext } from "borgo-framework";

export async function loader({ api }: LoaderContext) {
  try {
    return { me: await api("GET /api/me") };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return redirect("/login");
    throw error;
  }
}
```

This works identically on a full page load and on a client-side navigation: the runtime receives the redirect as data and follows it as a client navigation, so the guard cannot be bypassed by arriving through a link. See [auth and sessions](auth-and-sessions.md) for the full pattern.

## Layouts

A `_layout.tsx` in any `pages/` directory wraps every page below it. Layouts nest, outermost first, and receive only `children`:

```tsx
import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header>
        <a href="/">Tasks</a>
        <a href="/about">About</a>
      </header>
      {children}
      <footer>built with borgo</footer>
    </div>
  );
}
```

`pages/_layout.tsx` wraps everything; `pages/admin/_layout.tsx` additionally wraps everything under `/admin`. Layouts live in the shared entry chunk rather than per-route chunks, which is why editing one triggers a full reload in dev instead of a hot update.

Layouts do not have loaders. A layout that needs data fetches it client-side, or every page under it returns what the layout needs — deliberate, because a loader per layout level means a waterfall or a coordination protocol, and neither is worth the weight here.

## The page head

Export `head` as an object, or as a function of the page's props:

```tsx
import type { Head } from "borgo-framework";

export const head = {
  title: "Tasks",
  meta: [{ name: "description", content: "Everything still to do" }],
};
```

```tsx no-check
export const head = (props: { task: Task }): Head => ({
  title: `${props.task.title} · Tasks`,
  meta: [{ property: "og:title", content: props.task.title }],
});
```

During server rendering the title replaces the shell's `<title>` and the metas are injected into `<head>`. After hydration the runtime owns both, updating them on every client-side navigation and restoring the shell's title on a page that exports no `head`. Meta entries are arbitrary attribute maps, so `property`, `name`, `httpEquiv` and the rest all work.

## Streaming SSR

Pages render through `renderToReadableStream`, so a `<Suspense>` boundary that suspends on the server sends the rest of the document immediately and streams the slow part in when it resolves:

```tsx
import { Suspense, use } from "react";

function SlowPanel({ stats }: { stats: Promise<{ total: number }> }) {
  return <p>{use(stats).total} tasks all time</p>;
}

export default function Dashboard({ stats }: { stats: Promise<{ total: number }> }) {
  return (
    <main>
      <h1>Dashboard</h1>
      <Suspense fallback={<p className="fallback">Counting…</p>}>
        <SlowPanel stats={stats} />
      </Suspense>
    </main>
  );
}
```

The stream is pull-based: React is asked for the next chunk only when the client has room for it, so a slow connection throttles the render instead of letting a whole document pile up in server memory, and a client that goes away ends the render rather than paying for a page nobody will read.

## Form actions

A page may export an `action`; the front server runs it for `POST` requests to that page's URL:

```tsx
import { CsrfField, redirect, type ActionContext } from "borgo-framework";

export async function action({ request, api }: ActionContext) {
  const form = await request.formData();
  const title = String(form.get("title") ?? "").trim();
  if (!title) return { error: "give the task a title" };
  await api("POST /api/tasks", { body: { title, body: String(form.get("body") ?? "") } });
  return redirect("/");
}

export default function Home({ actionData }: { actionData?: { error?: string } }) {
  return (
    <main>
      <form method="post">
        <CsrfField />
        <input name="title" placeholder="Title" />
        <button>Add</button>
      </form>
      {actionData?.error && <p className="error">{actionData.error}</p>}
    </main>
  );
}
```

What the action returns decides what happens next:

- **A `Response`** is sent as-is. `redirect(to)` gives you post/redirect/get, which is what you want after a successful mutation.
- **Any other object** re-renders the page with that object as the `actionData` prop, merged over the loader's props — the loader runs again first, so the page sees fresh data *and* the action's result. Validation errors belong here.

On hydrated pages the runtime enhances the form: the action runs over `fetch` and the page re-renders in place, keeping your scroll position. A redirect back to the same page refreshes it where you are; a redirect elsewhere becomes a client-side navigation. Without JavaScript — or on a `hydrate = false` page — the identical form falls back to the classic post cycle. Both paths are real, and both are tested.

Forms the runtime cannot re-render in place stay native: a `GET` form, a cross-origin target, a post to `/api/...`. To force the classic full-page submit on any form, add `data-borgo-native`:

```tsx
<form method="post" action="/report.csv" data-borgo-native>
  <button>Download</button>
</form>;
```

`<CsrfField />` is required inside every `<form method="post">` — see [CSRF protection](security.md#csrf-protection) for what it defends against.

One limit worth stating: an action that returns its **own HTML document** (rather than props or a redirect) is swapped into the page by the runtime, and because that reuses the current browsing context, inline scripts in that document are blocked by the page's existing Content-Security-Policy and the page's hydration does not re-run. It is the right behavior for the error documents this path actually serves; if you need to send a custom HTML page from an action, redirect to a route that renders it instead.

## Hydration control

A page controls how much JavaScript it ships:

```tsx no-check
export const hydrate = false;      // no page bundle at all
export const hydrate = "visible";  // hydrate when the marked section scrolls into view
```

`hydrate = false` pages are pure server-rendered HTML; individual interactive pieces can still be `<Island>` components. See [client navigation and hydration](client-navigation.md#partial-hydration).

## Error pages

- `pages/_404.tsx` renders unmatched routes with status 404.
- `pages/_500.tsx` renders server errors in production with status 500, without leaking the error.

Both go through the normal layout chain, and both may have loaders. In development an SSR error renders as a readable overlay instead of `_500`, and the client runtime surfaces uncaught errors and unhandled rejections in the browser. If `_500` itself throws, the response degrades to a plain text 500 rather than a loop.

On the Go side, `borgo.Handle` panics with an actionable message on a malformed or duplicate pattern rather than failing silently at request time, and a handler that panics answers a JSON 500 instead of dropping the connection.
