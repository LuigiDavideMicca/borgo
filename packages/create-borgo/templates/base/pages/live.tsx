import { useEffect, useState } from "react";

export const head = { title: "Live · {{name}}" };

export default function Live() {
  const [tick, setTick] = useState<string | null>(null);

  // server-sent events, straight from the Go api through the front server
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("tick", (e) => setTick((e as MessageEvent).data));
    return () => source.close();
  }, []);

  return (
    <main>
      <h1>Live</h1>
      <p>
        A goroutine in <code>api/events.go</code> publishes to an SSE hub every second; this page
        subscribes with a plain <code>EventSource</code>. No polling, no websocket setup.
      </p>
      <p className="hint">{tick ? `Go api up for ${tick}` : "connecting…"}</p>
      <a href="/">← Back home</a>
    </main>
  );
}
