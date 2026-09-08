import { ApiError, type Head, type LoaderContext } from "borgo-framework";
import type { Task } from "@/.borgo/api-types";

export const head = (props: Record<string, unknown>): Head => {
  const task = props.task as Task | null;
  return { title: task ? `${task.title} · borgo tasks` : "Not found · borgo tasks" };
};

export async function loader({ params, api }: LoaderContext) {
  try {
    const { task } = await api("GET /api/tasks/{id}", { params: { id: params.id } });
    return { task };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { task: null };
    throw error;
  }
}

export default function TaskDetail({ task }: { task: Task | null }) {
  if (!task) {
    return (
      <main>
        <h1>Task not found</h1>
        <a href="/">Back home</a>
      </main>
    );
  }

  return (
    <main>
      <h1>{task.title}</h1>
      <p>{task.body || "No details."}</p>
      <p>Created {task.CreatedAt.slice(0, 10)}</p>
      <a href="/">Back home</a>
    </main>
  );
}
