import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { HELLO, countFromQuery, itemList } from "../../shared/items.js";

const here = dirname(fileURLToPath(import.meta.url));
const payload = readFileSync(join(here, "public", "static", "payload.json"));

const app = new Hono();

app.get("/api/hello", (c) => c.json(HELLO));

app.get("/api/items", (c) => c.json(itemList(countFromQuery(c.req.query("n")))));

// read from disk once at boot, like a production static handler with a warm
// page cache; the contract only asks that the same bytes are served
app.get("/static/payload.json", (c) =>
  c.body(payload, 200, { "content-type": "application/json", "content-length": String(payload.length) }),
);

app.get("/api/events", (c) => {
  const stream = new ReadableStream({
    start(controller) {
      // the contract's immediate first flush
      controller.enqueue(new TextEncoder().encode(": ping\n\n"));
    },
    cancel() {},
  });
  return c.body(stream, 200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
});

app.get("/", (c) => c.text("hono bench app"));

export default { port: Number(process.env.PORT || 43010), fetch: app.fetch, idleTimeout: 0 };
