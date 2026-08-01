import { Island } from "borgo-framework";

export const head = { title: "About · {{name}}" };

// this page ships zero page javascript: only the island below hydrates
export const hydrate = false;

export default function About() {
  return (
    <main>
      <h1>About</h1>
      <p>
        Pages live in <code>pages/</code> and map to routes by file name. API
        routes live in <code>api/</code> as Go files that register themselves.
      </p>
      <p>
        This page exports <code>hydrate = false</code>, so it is pure server-rendered HTML — open
        the network tab: no page bundle. The counter is an island from{" "}
        <code>islands/Counter.tsx</code>; it hydrates on its own.
      </p>
      <Island name="Counter" props={{ start: 0 }} />
      <p>
        <a href="/">← Back home</a>
      </p>
    </main>
  );
}
