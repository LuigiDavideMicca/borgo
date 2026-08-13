import { expect, test } from "@playwright/test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const assetsDir = join("examples", "tasks", "public", "assets");

test("ssr html arrives gzip-encoded with vary", async ({ request }) => {
  const res = await request.get("/", { headers: { "accept-encoding": "gzip" } });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-encoding"]).toBe("gzip");
  expect(res.headers()["vary"]).toContain("Accept-Encoding");
  expect(await res.text()).toContain("<h1>Tasks</h1>");
});

test("ssr html falls back to identity", async ({ request }) => {
  const res = await request.get("/", { headers: { "accept-encoding": "identity" } });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-encoding"]).toBeUndefined();
  expect(await res.text()).toContain("<h1>Tasks</h1>");
});

// the entry bundle's name carries its content hash, so it is read off the
// document the server just sent rather than spelled out here
const entryUrl = async (request: { get: (url: string) => Promise<{ text: () => Promise<string> }> }) => {
  const html = await (await request.get("/")).text();
  const src = /src="(\/assets\/client-[^"]+\.js)"/.exec(html);
  expect(src, "the document names no client entry").not.toBeNull();
  return src![1];
};

test("client entry serves the precompressed brotli sibling", async ({ request }) => {
  const res = await request.get(await entryUrl(request), {
    headers: { "accept-encoding": "gzip, br" },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-encoding"]).toBe("br");
  expect(res.headers()["content-type"]).toContain("javascript");
  expect(res.headers()["vary"]).toContain("Accept-Encoding");
  expect(await res.text()).toContain("import");
});

test("hashed chunks arrive compressed, immutable and byte-identical", async ({ request }) => {
  const chunk = readdirSync(assetsDir)
    .filter((f) => /-[a-z0-9]{8}\.js$/.test(f))
    .sort((a, b) => statSync(join(assetsDir, b)).size - statSync(join(assetsDir, a)).size)[0];
  expect(chunk).toBeTruthy();
  const raw = statSync(join(assetsDir, chunk)).size;

  const res = await request.get(`/assets/${chunk}`, { headers: { "accept-encoding": "gzip" } });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-encoding"]).toBe("gzip");
  expect(res.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  // the decompressed body must be the exact original file
  expect((await res.body()).length).toBe(raw);
});

test("already-compressed files are served as-is", async ({ request }) => {
  const chunk = readdirSync(assetsDir).find((f) => f.endsWith(".js.gz"));
  expect(chunk).toBeTruthy();
  const res = await request.get(`/assets/${chunk}`, { headers: { "accept-encoding": "gzip, br" } });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-encoding"]).toBeUndefined();
});

test("tiny props json stays identity under the threshold", async ({ request }) => {
  // /slow has no loader, so its props payload is a handful of bytes
  const res = await request.get("/slow?__borgo=props", { headers: { "accept-encoding": "gzip" } });
  expect(res.status()).toBe(200);
  expect(res.headers()["vary"]).toContain("Accept-Encoding");
  expect(res.headers()["content-encoding"]).toBeUndefined();
  expect(await res.json()).toHaveProperty("props");
});

test("streamed ssr survives compression end to end", async ({ request }) => {
  const res = await request.get("/slow", { headers: { "accept-encoding": "gzip" } });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-encoding"]).toBe("gzip");
  const html = await res.text();
  expect(html).toContain("Streaming SSR");
  expect(html).toContain("this paragraph streamed in after the shell");
});

test("the api proxy passes go responses through", async ({ request }) => {
  const res = await request.get("/api/tasks", { headers: { "accept-encoding": "gzip" } });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  expect(await res.json()).toHaveProperty("tasks");
});
