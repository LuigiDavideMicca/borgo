# Getting started

Build one feature on a real app, end to end: a board where signed-in users share links, stored in a database, typed from Go to React, guarded, limited by a setting, and live across browsers. Follow it top to bottom and you will have touched every convention borgo has. It takes about half an hour, and you need [Bun](https://bun.sh) 1.4+ and [Go](https://go.dev) 1.27+.

## Scaffold

```bash
bunx create-borgo@latest board -t full --yes
cd board
bun install
go mod tidy
bun run dev
```

`-t full` is the template with users, sessions and a database already in place; `--yes` takes every other default. In a terminal the scaffolder offers to run the last four commands itself. Either way, open http://localhost:3000 and register an account at `/register`: that is the app this guide builds on.

## What you just got

```
pages/                one file per route: index, login, register, account, live, news
api/                  the Go API: users.go (sessions and login), notes.go, events.go,
                      realtime.go (who may hold a WebSocket topic), middleware.go
db/                   opens SQLite and applies db/migrations/ at boot
env.ts                the app's environment, declared once and typed
env/env.gen.go        the same declarations for Go, written from env.ts - never edited
middleware.ts         the pages' guard: which paths need a session
main.go               the Go entrypoint: opens the database, calls borgo.Serve()
.borgo/               generated: api-types.d.ts (committed) and build plumbing
.env                  SESSION_SECRET, random and unique to this app - never committed
```

Plus `Dockerfile`, `docker-compose.yml`, `index.html`, `style.scss`, `package.json` and `go.mod`.

Two processes are running. The Go binary answers port 3000: it serves `/api/*` in its own process, the static files and the WebSocket topics, and asks the second process - Bun, on a loopback port nothing else can reach - for the one thing that needs JavaScript, a rendered page. From the browser there is one origin and one port.

## A table

A change to the database is a new file in `db/migrations/`, named for its place in the order. Create `db/migrations/0002_links.sql`:

```sql
CREATE TABLE links (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	url        TEXT NOT NULL,
	title      TEXT NOT NULL,
	owner      TEXT NOT NULL REFERENCES users(username),
	created_at TEXT NOT NULL
);
```

Save it and watch the terminal: the API rebuilds, and at boot `db.Open` applies every migration the database has not seen, in a transaction, and records it. Once applied, a migration is history: edit it later and the app refuses to boot rather than run against a schema it does not know, so a change is always a new file. [The database](database.md) has the runner and its rules.

## The Go side

Create `api/links.go`:

```go no-check
package api

import (
	"net/http"
	"time"

	"github.com/LuigiDavideMicca/borgo"

	"board/db"
	"board/env"
)

type Link struct {
	ID        int    `json:"id"`
	URL       string `json:"url"`
	Title     string `json:"title"`
	Owner     string `json:"owner"`
	CreatedAt string `json:"createdAt"`
}

type LinkList struct {
	Links []Link `json:"links"`
}

type LinkCreate struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

func init() {
	borgo.Handle("GET /api/links", borgo.Authed(ListLinks))
	borgo.Handle("POST /api/links", borgo.Authed(CreateLink))
	borgo.Handle("DELETE /api/links/{id}", borgo.Authed(DeleteLink))
}

func ListLinks(w http.ResponseWriter, r *http.Request) {
	rows, err := db.DB.QueryContext(r.Context(), `SELECT id, url, title, owner, created_at FROM links ORDER BY id DESC`)
	if err != nil {
		storeFailed(w, "list links", err)
		return
	}
	defer rows.Close()
	list := LinkList{Links: []Link{}}
	for rows.Next() {
		var l Link
		if err := rows.Scan(&l.ID, &l.URL, &l.Title, &l.Owner, &l.CreatedAt); err != nil {
			storeFailed(w, "list links", err)
			return
		}
		list.Links = append(list.Links, l)
	}
	if err := rows.Err(); err != nil {
		storeFailed(w, "list links", err)
		return
	}
	borgo.JSON(w, http.StatusOK, list)
}

func CreateLink(w http.ResponseWriter, r *http.Request) {
	me, _ := borgo.GetSession[Me](r)
	body, err := borgo.Bind[LinkCreate](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	var count int
	db.DB.QueryRowContext(r.Context(), `SELECT count(*) FROM links WHERE owner = ?`, me.Username).Scan(&count)
	if count >= int(env.Must().LINKS_PER_USER) {
		http.Error(w, "you have shared as many links as this board allows", http.StatusConflict)
		return
	}
	link := Link{URL: body.URL, Title: body.Title, Owner: me.Username, CreatedAt: time.Now().Format(time.RFC3339)}
	res, err := db.DB.ExecContext(r.Context(), `INSERT INTO links (url, title, owner, created_at) VALUES (?, ?, ?, ?)`, link.URL, link.Title, link.Owner, link.CreatedAt)
	if err != nil {
		storeFailed(w, "create link", err)
		return
	}
	id, _ := res.LastInsertId()
	link.ID = int(id)
	go borgo.Push("links", "added", link)
	borgo.JSON(w, http.StatusCreated, link)
}

func DeleteLink(w http.ResponseWriter, r *http.Request) {
	me, _ := borgo.GetSession[Me](r)
	res, err := db.DB.ExecContext(r.Context(), `DELETE FROM links WHERE id = ? AND owner = ?`, r.PathValue("id"), me.Username)
	if err != nil {
		storeFailed(w, "delete link", err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.NotFound(w, r)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

Three handlers, registered in `init` with `borgo.Handle` and wrapped in `borgo.Authed`, which answers `401` to a request without a session before the handler runs. Inside, `borgo.GetSession[Me]` reads who is asking - `Me` is what `api/users.go` stores at login - and the queries are plain `database/sql` against `db.DB`. The delete names the owner in its `WHERE`: someone else's link is a `404`, the same answer as a link that does not exist, so an id tells nobody anything.

Now look at `.borgo/api-types.d.ts`. borgogen read your Go source - not a spec, not the running program - and wrote, among the rest:

```ts no-check
export interface Link {
  id: number;
  url: string;
  title: string;
  owner: string;
  createdAt: string;
}

export interface LinkList {
  links: Array<Link> | null;
}

declare module "borgo-framework" {
  interface ApiRoutes {
    "GET /api/links": { response: LinkList };
    "POST /api/links": { response: Link; request: LinkCreate$Request };
    "DELETE /api/links/{id}": { response: unknown };
  }
  interface WsEvents {
    "links/added": Link;
  }
}
```

The routes are in the type system now, request and response, and so is the `borgo.Push` in `CreateLink`: an `"added"` event on the `"links"` topic carries a `Link`. `links` is `Array<Link> | null` because a nil Go slice is `null` on the wire, and the generator cannot see that this handler never sends one - see [the nil slice trap](typed-bridge.md#the-nil-slice-trap).

## The page

Create `pages/links.tsx`:

```tsx no-check
import { useEffect, useState } from "react";
import { CsrfField, redirect, subscribe, type ActionContext, type LoaderContext } from "borgo-framework";
import type { Link } from "@/.borgo/api-types";

export const head = { title: "Links" };

export async function loader({ api }: LoaderContext) {
  const { links } = await api("GET /api/links");
  return { links: links ?? [] };
}

export async function action({ request, api }: ActionContext) {
  const form = await request.formData();
  const url = String(form.get("url") ?? "").trim();
  const title = String(form.get("title") ?? "").trim();
  if (!URL.canParse(url)) return { error: "that is not a link" };
  await api("POST /api/links", { body: { url, title: title || url } });
  return redirect("/links");
}

export default function Links({ links: initial, actionData }: { links: Link[]; actionData?: { error?: string } }) {
  const [links, setLinks] = useState(initial);
  useEffect(() => setLinks(initial), [initial]);
  useEffect(() => {
    const channel = subscribe("links", (event, link) => {
      if (event === "added") setLinks((now) => (now.some((l) => l.id === link.id) ? now : [link, ...now]));
    });
    return () => channel.close();
  }, []);
  return (
    <main>
      <h1>Links</h1>
      <form method="post">
        <CsrfField />
        <input name="url" placeholder="https://..." />
        <input name="title" placeholder="Title (optional)" />
        <button>Share</button>
      </form>
      {actionData?.error && <p className="error">{actionData.error}</p>}
      <ul>
        {links.map((link) => (
          <li key={link.id}>
            <a href={link.url}>{link.title}</a> · {link.owner}
          </li>
        ))}
      </ul>
    </main>
  );
}
```

The `loader` runs on the server before rendering, and what it returns becomes the props. They are in the HTML before any JavaScript runs, and readable by the visitor, so return what the page shows. The `action` takes the form's `POST`. With JavaScript off it works as a classic post, redirect and get; with it on, the runtime submits over `fetch` and renders in place, and an object returned instead of a redirect becomes `actionData`. `<CsrfField />` is what makes a cross-site copy of the form fail. The check is off under `borgo dev` and enforced in production, so a form without it works now and breaks on the first deploy.

Now break it on purpose. Change `"GET /api/links"` to `"GET /api/link"`, and `bunx tsc --noEmit` answers:

```
pages/links.tsx(8,11): error TS2339: Property 'links' does not exist on type 'unknown'.
pages/links.tsx(8,27): error TS2554: Expected 2 arguments, but got 1.
```

A route Go never registered has no known response, so nothing can be read from it, and no known request, so the call must say what it sends. Change it back, then try `link.titel` in the list: `tsc` names the property that does not exist. The Go handler and the page cannot disagree without one of them failing to build.

## Guard it

Signed out, `/links` would render, and its loader would get a `401` from the API. Guard the page instead. In `middleware.ts`, add it to the matcher:

```ts no-check
export const matcher = ["/account", "/links"];
```

The middleware runs before the loader, before the props a client navigation fetches, and before the action - all three doors of the page - and sends a visitor without a session to `/login`. A redirect in the loader would have guarded the loader only; a `POST` to the page would still have reached the action. [Middleware and authorization](middleware-and-authorization.md) has the rest, including `api/middleware.go`, the same idea in front of the API.

## A limit from the environment

`CreateLink` refuses past `env.Must().LINKS_PER_USER`. Declare it in `env.ts`, under `server`:

```ts no-check
    // how many links one user may share
    LINKS_PER_USER: { type: "number", default: 20 },
```

Save, and `env/env.gen.go` is written again with a typed field, `LINKS_PER_USER float64`, read by the same rules `env.ts` reads it with. Start the app with `LINKS_PER_USER=abc` and both halves refuse to boot, naming the variable:

```
borgo env: 1 variable refused:
  - LINKS_PER_USER: expected a number, got "abc"
```

One declaration, checked in the process that renders and in the process that uses it. See [the environment](environment.md).

## Live

`CreateLink` already calls `borgo.Push("links", "added", link)`, and the page subscribes in an effect whose cleanup closes the socket. One thing is left: saying who may hold the topic. In `api/realtime.go`, `borgo.CanSubscribe` answers for every topic a socket asks for, at the handshake, with the session already verified:

```go no-check
func init() {
	borgo.CanSubscribe(func(r *http.Request, topic string) bool {
		if topic == "live" {
			return true
		}
		// the board is for signed-in users only
		_, signedIn := borgo.GetSession[Me](r)
		return topic == "links" && signedIn
	})
}
```

Open `/links` in two browsers, signed in as two users, and share a link in one: it appears in the other. In the subscription, `link` is a `Link` because of the `WsEvents` entry above, so publishing the wrong shape from Go fails the page's build. Without `CanSubscribe` the production server refuses every topic, and says so at startup. Without `borgo.CanPublish`, any socket admitted to a topic may publish on it too, so a payload is a claim, not proof it came from Go. [Realtime](realtime.md) covers both.

## Ship it

```bash
bun run build
bun run start
```

`build` generates the types and the env package, compiles the client assets - one lazy chunk per route, precompressed - and a single static Go binary in `dist/`; `start` runs both processes from that output. On a server, the scaffold's `Dockerfile` and `docker-compose.yml` are the deployment: `docker compose up -d` builds the image, keeps the database on a volume at `/data`, and requires the `SESSION_SECRET` from `.env`. Behind https, uncomment `SESSION_SECURE` in the compose file first, or the session cookie also travels over plain http.

Read [security](security.md#before-you-go-live) before a real deploy - it ends with a checklist - and [deploy](deploy.md) for the other layouts and the environment reference.

## What you have, and what you don't

A server-rendered React app on a Go API: a migrated database, types shared across the bridge, a guarded page, a form that works with and without JavaScript, a typed setting both halves check, live updates with an authorization rule, and a production build that is two processes and no platform.

What this walkthrough left out, each with the page that covers it: [islands](client-navigation.md#islands), one interactive component on a page that ships no JavaScript of its own; [uploads](typed-bridge.md#uploads-borgobindmultipart), typed and stored by `borgo.Uploads`; [cached pages](pages-and-routing.md#cached-pages) the API invalidates with `borgo.RevalidateTag` - `pages/news.tsx` in this app is one; [layouts and error pages](pages-and-routing.md), [streaming SSR](pages-and-routing.md#streaming-ssr), [static export](deploy.md#static-export), and the [dev loop](dev-experience.md): fast refresh, `borgo doctor`, Tailwind.
