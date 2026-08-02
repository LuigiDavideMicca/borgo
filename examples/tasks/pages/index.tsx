import { useEffect, useState } from "react";
import { CsrfField, apiFetch, redirect, type ActionContext, type LoaderContext } from "borgo-framework";
import type { Task } from "../.borgo/api-types";

export const head = {
  title: "Tasks · borgo",
  meta: [{ name: "description", content: "tasks demo app for the borgo framework" }],
};

// the sentinel header proves in ci that loader code never reaches the client bundle
export async function loader({ api }: LoaderContext) {
  const { tasks } = await api("GET /api/tasks", {
    headers: { "x-borgo-sentinel": "borgo-server-only-sentinel" },
  });
  return { tasks };
}

// classic form post: works without client javascript, redirects back on success
export async function action({ request, api }: ActionContext) {
  const form = await request.formData();
  const title = String(form.get("title") ?? "").trim();
  const body = String(form.get("body") ?? "");

  if (!title) return { error: "give the task a title" };

  await api("POST /api/tasks", { body: { title, body } });
  return redirect("/");
}

export default function Home({
  tasks: initialTasks,
  actionData,
}: {
  tasks: Task[];
  actionData?: { error?: string };
}) {
  const [tasks, setTasks] = useState(initialTasks);

  const refresh = async () => {
    const res = await fetch("/api/tasks");
    setTasks((await res.json()).tasks);
  };

  // live updates: a task created or deleted in another tab appears here
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("task-created", refresh);
    source.addEventListener("task-deleted", refresh);
    return () => source.close();
  }, []);

  // apiFetch, not fetch: a browser call to /api/* that changes something has
  // to echo the csrf token in a header, and this is what attaches it
  const remove = async (id: number) => {
    await apiFetch(`/api/tasks/${id}`, { method: "DELETE" });
    await refresh();
  };

  // the whole-list clear sits behind borgo.Authed: logged out it answers 401
  const [clearError, setClearError] = useState<string | null>(null);
  const clearAll = async () => {
    const res = await apiFetch("/api/tasks", { method: "DELETE" });
    if (res.status === 401) {
      setClearError("log in to clear all tasks");
      return;
    }
    setClearError(null);
    await refresh();
  };

  return (
    <main>
      <h1>Tasks</h1>
      <p>Server-rendered by Bun, data from the Go API, mutations through a borgo action.</p>
      <form method="post">
        <CsrfField />
        <input name="title" placeholder="Title" />
        <input name="body" placeholder="Details (optional)" />
        <button>Add</button>
      </form>
      {actionData?.error && <p className="error">{actionData.error}</p>}
      <ul>
        {tasks.map((t) => (
          <li key={t.ID}>
            <a href={`/tasks/${t.ID}`}>{t.title}</a>
            <button onClick={() => remove(t.ID)}>✕</button>
          </li>
        ))}
      </ul>
      <button type="button" className="clear-all" onClick={clearAll}>
        Clear all
      </button>
      {clearError && (
        <p className="error" data-testid="clear-error">
          {clearError}
        </p>
      )}
    </main>
  );
}
