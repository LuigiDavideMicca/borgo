import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Elysia } from "elysia";
import { HELLO, countFromQuery, itemList } from "../../shared/items.js";

const here = dirname(fileURLToPath(import.meta.url));
const payload = readFileSync(join(here, "public", "static", "payload.json"));

new Elysia()
  .get("/api/hello", () => HELLO)
  .get("/api/items", ({ query }) => itemList(countFromQuery(query.n)))
  .get(
    "/static/payload.json",
    () =>
      new Response(payload, {
        headers: { "content-type": "application/json", "content-length": String(payload.length) },
      }),
  )
  .get("/api/events", () => {
    const stream = new ReadableStream({
      start(controller) {
        // the contract's immediate first flush
        controller.enqueue(new TextEncoder().encode(": ping\n\n"));
      },
      cancel() {},
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  })
  .get("/", () => "elysia bench app")
  .listen({ port: Number(process.env.PORT || 43011), idleTimeout: 0 });

console.log(`elysia listening on ${process.env.PORT || 43011}`);
