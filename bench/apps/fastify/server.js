import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { HELLO, countFromQuery, itemList } from "../../shared/items.js";

const here = dirname(fileURLToPath(import.meta.url));
const payload = readFileSync(join(here, "public", "static", "payload.json"));

// logging off: none of the other implementations log per request, and Fastify's
// logger is fast but not free
const app = Fastify({ logger: false });

app.get("/api/hello", async () => HELLO);

app.get("/api/items", async (request) => itemList(countFromQuery(request.query.n)));

app.get("/static/payload.json", async (_request, reply) => {
  reply.header("content-type", "application/json").header("content-length", String(payload.length));
  return reply.send(payload);
});

app.get("/api/events", (request, reply) => {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // the contract's immediate first flush
  reply.raw.write(": ping\n\n");
  request.raw.on("close", () => reply.raw.end());
});

app.get("/", async (_request, reply) => reply.type("text/plain").send("fastify bench app"));

const port = Number(process.env.PORT || 43013);
await app.listen({ port, host: "127.0.0.1" });
// SSE streams must not be cut by the default header/keep-alive timeouts
app.server.headersTimeout = 0;
app.server.requestTimeout = 0;
app.server.keepAliveTimeout = 0;
console.log(`fastify listening on ${port}`);
