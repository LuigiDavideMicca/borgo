import type { LoaderContext } from "borgo-framework";

export const head = {
  title: "News · borgo",
  meta: [{ name: "description", content: "isr demo page for the borgo framework" }],
};

// isr: rendered once as nobody, cached, served to everyone for a minute — or
// until the api calls borgo.RevalidateTag("news"). the render stamp is how a
// human (and the e2e) can tell a cached copy: two requests inside the window
// carry the same stamp.
export const revalidate = 60;
export const tags = ["news"];

export async function loader({ api }: LoaderContext) {
  const { tasks } = await api("GET /api/tasks");
  return { count: (tasks ?? []).length, renderedAt: new Date().toISOString() };
}

export default function News({ count, renderedAt }: { count: number; renderedAt: string }) {
  return (
    <main>
      <h1>Newsroom</h1>
      <p>
        There {count === 1 ? "is" : "are"} <strong data-testid="count">{count}</strong> task
        {count === 1 ? "" : "s"} in the system — as of the last render.
      </p>
      <p>
        This page declares <code>revalidate = 60</code> with <code>tags = ["news"]</code>: the copy
        you are reading was rendered at <time data-testid="rendered-at">{renderedAt}</time> and is
        shared with every visitor until it goes stale or the api drops it.
      </p>
    </main>
  );
}
