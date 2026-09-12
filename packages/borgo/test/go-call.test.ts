// Phase 2, step 3: the render service's side of //borgo:export. The go side
// is pinned in export_test.go; this is what the generated .borgo/go.ts calls.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { callExport, GoError } from "../src/go-call";

const key = "0123456789abcdef0123456789abcdef";
let server: ReturnType<typeof Bun.serve>;
const seen: Array<{ path: string; key: string | null; body: unknown }> = [];
const saved = { port: process.env.API_PORT, key: process.env.BORGO_INTERNAL_KEY };

beforeAll(() => {
  // a stand-in for go's internal listener, answering the shapes export.go writes
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => undefined);
      seen.push({ path: url.pathname, key: req.headers.get("X-Borgo-Internal"), body });
      const name = url.pathname.split("/").pop();
      switch (name) {
        case "Membership":
          return Response.json({ result: { userId: 7, role: "admin" } });
        case "Forget":
          return Response.json({});
        case "Missing":
          return Response.json({ error: "no such workspace" });
        case "Boom":
          return Response.json({ error: "Boom panicked; the stack is in the go log" }, { status: 500 });
        case "Html":
          return new Response("<html>not json</html>", { status: 502 });
      }
      return Response.json({ error: `no export named "${name}"` }, { status: 404 });
    },
  });
  process.env.API_PORT = String(server.port);
  process.env.BORGO_INTERNAL_KEY = key;
});

afterAll(() => {
  server.stop(true);
  if (saved.port === undefined) delete process.env.API_PORT;
  else process.env.API_PORT = saved.port;
  if (saved.key === undefined) delete process.env.BORGO_INTERNAL_KEY;
  else process.env.BORGO_INTERNAL_KEY = saved.key;
});

describe("callExport", () => {
  test("posts positional arguments with the boot key and returns the result", async () => {
    const result = await callExport<{ userId: number; role: string }>("Membership", [7, "acme"]);
    expect(result).toEqual({ userId: 7, role: "admin" });
    expect(seen.at(-1)).toEqual({ path: "/__borgo/export/Membership", key, body: [7, "acme"] });
  });

  test("an export returning only an error resolves to null when it returned nil", async () => {
    expect(await callExport<null>("Forget", [7])).toBeNull();
  });

  test("the Go function's own error is a GoError with its message", async () => {
    const error = await callExport<never>("Missing", []).catch((e) => e as GoError);
    expect(error).toBeInstanceOf(GoError);
    expect(error.message).toBe("no such workspace");
    expect(error.exportName).toBe("Missing");
    expect(error.status).toBe(200);
  });

  test("a contained panic is a GoError too, with its status", async () => {
    const error = await callExport<never>("Boom", []).catch((e) => e as GoError);
    expect(error).toBeInstanceOf(GoError);
    expect(error.status).toBe(500);
  });

  test("an answer that is not the export protocol is a plain error naming the export", async () => {
    const error = await callExport<never>("Html", []).catch((e) => e as GoError);
    expect(error).not.toBeInstanceOf(GoError);
    expect(String(error.message)).toContain("Html");
  });

  test("outside a render service it refuses and says where exports are called from", async () => {
    const port = process.env.API_PORT;
    delete process.env.API_PORT;
    try {
      const error = await callExport<never>("Membership", []).catch((e) => e as GoError);
      expect(String(error.message)).toContain("never from the browser");
    } finally {
      process.env.API_PORT = port;
    }
  });
});
