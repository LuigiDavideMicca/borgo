import { expect, test } from "@playwright/test";

test("an oversized json body is a clean 413 through the proxy", async () => {
  // > 1 MB: borgo.Bind's MaxBytesReader trips in go, BindError answers 413
  // as json, and the front proxy must relay it untouched - not wrap it into
  // an html 500
  const body = JSON.stringify({ title: "x".repeat(1_100_000) });
  const res = await fetch("http://localhost:3400/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  expect(res.status).toBe(413);
  expect(res.headers.get("content-type")).toContain("application/json");
  const payload = (await res.json()) as { error: string };
  expect(payload.error).toContain("too large");

  // nothing was created and the api still answers
  const list = await fetch("http://localhost:3400/api/tasks");
  expect(list.status).toBe(200);
  const { tasks } = (await list.json()) as { tasks: Array<{ title: string }> };
  expect(tasks.some((t) => t.title.startsWith("xxx"))).toBe(false);
});

test("bodies without a known size stream through the api proxy", async () => {
  // a stream body goes out chunked, without content-length: it must take
  // the proxy's streaming branch and still reach the go api intact
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ title: "streamed body" })));
      controller.close();
    },
  });
  const res = await fetch("http://localhost:3400/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    // @ts-expect-error duplex is required for stream bodies but untyped
    duplex: "half",
  });
  expect(res.status).toBe(201);
  const { task } = (await res.json()) as { task: { ID: number } };
  const cleanup = await fetch(`http://localhost:3400/api/tasks/${task.ID}`, { method: "DELETE" });
  expect(cleanup.status).toBe(200);
});
