import { useState } from "react";

export const head = {
  title: "{{name}}",
  meta: [{ name: "description", content: "react pages server-rendered by bun, api routes in go" }],
};

// no loader and no action: this page is the same for every visitor, so
// `bun run export` writes it to dist/site as it is
export default function Home() {
  const [message, setMessage] = useState("");

  const greet = async () => {
    const res = await fetch("/api/hello");
    setMessage((await res.json()).message);
  };

  return (
    <main className="hero">
      <img src="/logo.svg" alt="borgo" width={120} height={120} />
      <h1>borgo</h1>
      <p className="tagline">React pages server-rendered by Bun · API routes written in Go</p>
      <p className="hint">
        Get started by editing <code>pages/index.tsx</code>
      </p>

      <div className="cards">
        <a className="card" href="/hello/world">
          <h2>SSR with a loader →</h2>
          <p>This page's props are fetched from the Go API on the server, before rendering.</p>
        </a>
        <a className="card" href="/hello/world#greet">
          <h2>Form action →</h2>
          <p>A classic form post handled by a server action, typed body end to end.</p>
        </a>
        <a className="card" href="/about">
          <h2>Zero-JS page →</h2>
          <p>
            <code>hydrate = false</code>: no page bundle at all, with an interactive island in the
            middle of the static HTML.
          </p>
        </a>
        <a className="card" href="/live">
          <h2>Realtime →</h2>
          <p>Server-sent events from a Go goroutine, streamed through the front server.</p>
        </a>
        <button type="button" className="card" onClick={greet}>
          <h2>Call the Go API</h2>
          <p>
            {message || (
              <>
                Fetch <code>/api/hello</code> straight from the browser.
              </>
            )}
          </p>
        </button>
        <a className="card" href="https://github.com/LuigiDavideMicca/borgo">
          <h2>Docs →</h2>
          <p>Conventions, the roadmap and the whole framework source, small enough to read.</p>
        </a>
      </div>

      <p className="credit">
        Built with <a href="https://github.com/LuigiDavideMicca/borgo">borgo</a> · a framework by{" "}
        <a href="https://luigimicca.com">Luigi Micca</a>
      </p>
    </main>
  );
}
