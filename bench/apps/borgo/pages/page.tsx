import { useState } from "react";
import { items } from "../../../shared/items.js";

export const head = { title: "bench ssr page" };

const NAV = ["overview", "items", "docs", "about", "status"];

// no loader: the contract's ssr-page scenario renders a locally generated list
// so the measurement is rendering, not whichever data layer a framework likes
export default function BenchPage() {
  const [count, setCount] = useState(0);
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
      <p>
        Twenty rows, server-rendered, plus one component that hydrates on the client.
      </p>
      <button className="counter" onClick={() => setCount(count + 1)}>
        hydrated counter: {count}
      </button>
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
