import { useEffect, useState } from "react";
import { useCounter } from "@/lib/use-counter";

export const head = { title: "Refresh · borgo tasks" };

export default function Refresh() {
  const [text, setText] = useState("");
  const { count, increment } = useCounter();

  useEffect(() => {
    (window as unknown as { __hydrated?: boolean }).__hydrated = true;
  }, []);

  return (
    <main>
      <h1>Fast refresh playground</h1>
      <p data-marker>MARKER-0</p>
      <input aria-label="scratch" value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={increment}>count {count}</button>
    </main>
  );
}
