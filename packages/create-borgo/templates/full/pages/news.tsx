import type { LoaderContext } from "borgo-framework";

export const head = {
  title: "News · {{name}}",
  meta: [{ name: "description", content: "a cached page, dropped by the api when the data changes" }],
};

// isr, the full story: this page is rendered once as nobody, cached, and
// shared with every visitor. it leaves the cache two ways - the clock
// (revalidate seconds) or the data: the handlers in api/notes.go call
// borgo.RevalidateTag("notes") the moment they write, and the next request
// re-renders. the timestamp below is how you can watch it happen.
export const revalidate = 300;
export const tags = ["notes"];

export async function loader({ api }: LoaderContext) {
  const { notes } = await api("GET /api/notes");
  return { count: (notes ?? []).length, renderedAt: new Date().toISOString() };
}

export default function News({ count, renderedAt }: { count: number; renderedAt: string }) {
  return (
    <main>
      <h1>News</h1>
      <p>
        There {count === 1 ? "is" : "are"} <strong>{count}</strong> note{count === 1 ? "" : "s"} —
        as of the last render, at <time>{renderedAt}</time>.
      </p>
      <p>
        Reload: the timestamp holds, this is a cached copy. Now add a note on the{" "}
        <a href="/">home page</a> and reload again: the api called{" "}
        <code>borgo.RevalidateTag("notes")</code> when it wrote, and this page re-rendered. Without
        that call it would still refresh on its own every <code>revalidate = 300</code> seconds.
      </p>
    </main>
  );
}
