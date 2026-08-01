import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { HELLO, countFromQuery, itemList } from "../../shared/items.js";

const here = dirname(fileURLToPath(import.meta.url));
const payload = readFileSync(join(here, "public", "static", "payload.json"));

const app = express();
app.disable("x-powered-by");
// express's etag default costs a hash of every body; leaving it on would be
// measuring a feature the other implementations do not have
app.disable("etag");

app.get("/api/hello", (_req, res) => res.json(HELLO));

app.get("/api/items", (req, res) => res.json(itemList(countFromQuery(req.query.n))));

app.get("/static/payload.json", (_req, res) => {
  res.set("content-type", "application/json");
  res.set("content-length", String(payload.length));
  res.end(payload);
});

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // the contract's immediate first flush
  res.write(": ping\n\n");
  req.on("close", () => res.end());
});

app.get("/", (_req, res) => res.type("text/plain").send("express bench app"));

const port = Number(process.env.PORT || 43012);
const server = app.listen(port, () => console.log(`express listening on ${port}`));
// SSE streams must not be cut by the default header/keep-alive timeouts
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 0;
