export const head = {
  title: "Now · {{name}}",
  meta: [{ name: "description", content: "a page cached and re-rendered on a clock" }],
};

// isr, the easy version: one export and this page is rendered once, cached,
// and shared with every visitor for 60 seconds, then re-rendered on the next
// request. reload and the timestamp holds until the minute is up. runs in
// production (`bun run build && bun run start`); dev always renders fresh.
export const revalidate = 60;

export default function Now() {
  return (
    <main>
      <h1>Now-ish</h1>
      <p>
        This copy was rendered at <strong>{new Date().toISOString()}</strong> and is at most a
        minute old — <code>revalidate = 60</code> is the whole setup.
      </p>
      <p>
        <a href="/">← Back home</a>
      </p>
    </main>
  );
}
