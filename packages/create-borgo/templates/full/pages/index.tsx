import { useCallback, useEffect, useState } from "react";
import { CsrfField, apiFetch, redirect, type ActionContext, type LoaderContext } from "borgo-framework";
import type { Note } from "../.borgo/api-types";

export const head = {
  title: "Notes · {{name}}",
  meta: [{ name: "description", content: "a borgo app with auth, crud and realtime" }],
};

// props are fetched on the server before rendering; the route and the
// response shape both come from the generated api types
export async function loader({ api }: LoaderContext) {
  const { notes } = await api("GET /api/notes");
  return { notes };
}

// the form below posts here; enhanced by the runtime (no reload), still
// working as a classic post without javascript
export async function action({ request, api }: ActionContext) {
  const form = await request.formData();
  const title = String(form.get("title") ?? "").trim();
  if (!title) return { error: "give the note a title" };
  await api("POST /api/notes", { body: { title, body: String(form.get("body") ?? "") } });
  return redirect("/");
}

export default function Home({
  notes: initialNotes,
  actionData,
}: {
  notes: Note[];
  actionData?: { error?: string };
}) {
  const [notes, setNotes] = useState(initialNotes);
  useEffect(() => setNotes(initialNotes), [initialNotes]);

  // memoised so the subscription below depends on a value that does not
  // change every render - without it the effect would resubscribe constantly
  const refresh = useCallback(async () => {
    const res = await fetch("/api/notes");
    setNotes((await res.json()).notes);
  }, []);

  // a note created or deleted in another tab appears here live
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("note-created", refresh);
    source.addEventListener("note-deleted", refresh);
    return () => source.close();
  }, [refresh]);

  // apiFetch, not fetch: a browser call to /api/* that changes something has
  // to echo the csrf token in a header, and this is what attaches it
  const remove = async (id: number) => {
    await apiFetch(`/api/notes/${id}`, { method: "DELETE" });
    await refresh();
  };

  return (
    <main>
      <h1>Notes</h1>
      <p>Server-rendered by Bun, data from the Go API, mutations through a borgo action.</p>
      <form method="post">
        <CsrfField />
        <input name="title" placeholder="Title" />
        <input name="body" placeholder="Details (optional)" />
        <button type="submit">Add</button>
      </form>
      {actionData?.error && <p className="error">{actionData.error}</p>}
      <ul className="notes">
        {notes.map((n) => (
          <li key={n.id}>
            <span>{n.title}</span>
            <button type="button" onClick={() => remove(n.id)}>✕</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
