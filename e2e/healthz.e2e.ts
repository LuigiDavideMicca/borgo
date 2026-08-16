import { expect, test } from "@playwright/test";

test("front /healthz reports the api reachable", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("ok");
  expect(body.api).toBe("reachable");
  expect(typeof body.uptime).toBe("number");
  expect(body.uptime).toBeGreaterThanOrEqual(0);
});

test("the go api answers its own /healthz", async ({ request }) => {
  const res = await request.get("http://localhost:3901/healthz");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("ok");
  expect(typeof body.uptime).toBe("number");
});

test("/metrics serves prometheus text with route series", async ({ request }) => {
  // guarantee at least one observation for a page and one for the api proxy
  await request.get("/about");
  await request.get("/api/tasks");

  const res = await request.get("/metrics");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/plain");

  const text = await res.text();
  expect(text).toContain("# TYPE borgo_http_requests_total counter");
  expect(text).toMatch(/borgo_http_requests_total\{route="\/about",status="200"\} \d+/);
  expect(text).toMatch(/borgo_http_requests_total\{route="\/api\/\*",status="200"\} \d+/);
  expect(text).toContain('le="+Inf"');
  expect(text).toMatch(/borgo_process_uptime_seconds [\d.]+/);
  // the observability endpoints stay out of their own numbers
  expect(text).not.toContain('route="/healthz"');
  expect(text).not.toContain('route="/metrics"');
});
