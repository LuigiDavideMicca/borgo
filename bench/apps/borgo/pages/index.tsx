export const head = { title: "borgo bench" };

// not a benchmarked route; it exists so the app has a root and a 200 at /
export default function Index() {
  return (
    <main>
      <h1>borgo bench app</h1>
      <p>
        Benchmarked routes: <code>/api/hello</code>, <code>/api/items?n=100</code>,{" "}
        <code>/page</code>, <code>/static/payload.json</code>, <code>/api/events</code>.
      </p>
    </main>
  );
}
