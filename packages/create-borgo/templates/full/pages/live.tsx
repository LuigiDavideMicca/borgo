import { useEffect, useRef, useState } from "react";
import { subscribe, type Channel } from "borgo-framework";

export const head = { title: "Live · {{name}}" };

// the log only ever grows, so an entry's position when it arrives is a stable
// key - the array index at render time is not, it shifts under every entry
type Entry = { id: number; text: string };

export default function Live() {
  const [log, setLog] = useState<Entry[]>([]);
  const [present, setPresent] = useState(0);
  const [text, setText] = useState("");
  const channel = useRef<Channel<"live"> | null>(null);

  useEffect(() => {
    const append = (text: string) => setLog((l) => [...l, { id: l.length, text }]);
    // typed events: "note-created" comes from borgo.Push in go via borgogen,
    // "message" from ws-events.d.ts - checking the event narrows the data
    const ch = subscribe("live", (event, data) => {
      if (event === "__count") setPresent(data);
      else if (event === "message") append(`chat · ${data}`);
      else if (event === "note-created") append(`go · note "${data}" created`);
    });
    channel.current = ch;
    return () => ch.close();
  }, []);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    channel.current?.publish("message", text.trim());
    setText("");
  };

  return (
    <main>
      <h1>Live</h1>
      <p>
        A WebSocket channel on the front server. Open this page in two tabs: messages relay between
        browsers, and adding a note on the home page arrives here from Go via{" "}
        <code>borgo.Push</code>.
      </p>
      <p>
        {present} {present === 1 ? "tab" : "tabs"} connected
      </p>
      <form onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Say something" />
        <button type="submit">Send</button>
      </form>
      <ul>
        {log.map((entry) => (
          <li key={entry.id}>{entry.text}</li>
        ))}
      </ul>
    </main>
  );
}
