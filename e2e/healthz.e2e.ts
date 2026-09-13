import { expect, test } from "@playwright/test";

// Since 0.30 the go binary answers the public port: /healthz and /metrics are
// its own, the api is in the same process, and what /healthz probes is the
// render service behind it. This spec described the 0.2x topology until the
// e2e suite was run again after the change (48a5b85 moved the endpoints; no
// gate of that phase ran e2e).

test("/healthz reports the render service reachable", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("ok");
  expect(body.render).toBe("reachable");
  expect(typeof body.uptime).toBe("number");
  expect(body.uptime).toBeGreaterThanOrEqual(0);
});

// the api's own listener is for the render service's loaders: loopback, and
// behind the key minted for this boot. A request that does not carry it -
// anything on the box that is not the render service - is refused.
test("the api's internal listener refuses a request without the boot key", async ({ request }) => {
  const res = await request.get("http://localhost:3901/api/tasks");
  expect(res.status()).toBe(403);
});

test("/metrics serves prometheus text with route series", async ({ request }) => {
  // at least one observation for a page and one for an api route
  await request.get("/about");
  await request.get("/api/tasks");

  const res = await request.get("/metrics");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/plain");

  const text = await res.text();
  expect(text).toContain("# TYPE borgo_http_requests_total counter");
  expect(text).toMatch(/borgo_http_requests_total\{route="\/about",status="200"\} \d+/);
  // an api request is counted under the route pattern the mux matched, not
  // lumped under /api/* as the bun front used to count it
  expect(text).toMatch(/borgo_http_requests_total\{route="GET \/api\/tasks",status="200"\} \d+/);
  expect(text).toContain('le="+Inf"');
  expect(text).toMatch(/borgo_process_uptime_seconds [\d.]+/);
  // the observability endpoints stay out of their own numbers
  expect(text).not.toContain('route="/healthz"');
  expect(text).not.toContain('route="/metrics"');
});
