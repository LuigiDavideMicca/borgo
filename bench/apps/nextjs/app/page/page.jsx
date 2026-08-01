import { items } from "../../lib/items.js";
import Counter from "./counter.jsx";

// force-dynamic so the page is server-rendered per request, which is what the
// scenario measures. Left to itself Next would render this once at build time
// and serve a static file - a different (and much faster) thing, and not the
// thing borgo is being compared on.
export const dynamic = "force-dynamic";

export const metadata = { title: "bench ssr page" };

const NAV = ["overview", "items", "docs", "about", "status"];

export default function BenchPage() {
  const rows = items(20);
  return (
    <main data-bench-page="ssr">
      <h1>bench</h1>
      <nav>
        {NAV.map((entry) => (
          <a key={entry} href={`/page#${entry}`}>
            {entry}
          </a>
        ))}
      </nav>
      <p>Twenty rows, server-rendered, plus one component that hydrates on the client.</p>
      <Counter />
      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>title</th>
            <th>tag</th>
            <th>done</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id}>
              <td>{item.id}</td>
              <td>{item.title}</td>
              <td>{item.tag}</td>
              <td>{item.done ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
