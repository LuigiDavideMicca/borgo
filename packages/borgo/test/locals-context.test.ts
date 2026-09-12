// Phase 2, step 2b: what api/middleware.go forwards with borgo.Forward reaches
// loaders and actions as ctx.locals - under the session's rule, and for the
// same reason: a render service without a front receives the header from
// whoever sent the request.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALS_HEADER, localsFrom, runAction, type ActionOptions } from "../src/util";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const withLocals = (raw: string | null) => {
  const headers = new Headers();
  if (raw !== null) headers.set(LOCALS_HEADER, raw);
  return new Request("http://app.example/dashboard", { headers });
};

describe("localsFrom", () => {
  // the bytes the go front writes for borgo.Forward(r, "role", "admin");
  // locals_test.go asserts it produces this literal
  test("reads the go front's wire form", () => {
    expect(localsFrom(withLocals("eyJyb2xlIjoiYWRtaW4ifQ"), true)).toEqual({ role: "admin" });
  });

  test("outside render mode the header is a client's claim and is ignored", () => {
    expect(localsFrom(withLocals(encode({ role: "admin" })), false)).toEqual({});
  });

  test("absent or unreadable is nothing forwarded", () => {
    for (const raw of [null, "", "not base64url!!", encode("a string"), encode([1]), encode(null)]) {
      expect(localsFrom(withLocals(raw), true)).toEqual({});
    }
  });
});

describe("an action receives the locals", () => {
  const options = (localsFor?: ActionOptions["localsFor"]): ActionOptions => ({
    dev: true,
    apiUrl: "http://127.0.0.1:1/api",
    serverError: null,
    csrfRejects: async () => false,
    maxBody: 1024,
    apiFor: () => (async () => ({})) as never,
    ...(localsFor ? { localsFor } : {}),
    runLoader: async () => ({}),
    renderPage: async () => new Response("page"),
    sendJson: (_req, value, init) => Response.json(value, init),
    renderOverlay: () => "",
    onError: () => {},
  });
  const target = (seen: unknown[]) =>
    ({
      route: {
        pattern: "/dashboard",
        file: "dashboard.tsx",
        layouts: [],
        module: {
          default: () => null,
          action: async (ctx: { locals: unknown }) => {
            seen.push(ctx.locals);
            return new Response(null, { status: 204 });
          },
        },
      },
      params: {},
    }) as never;
  const post = () =>
    new Request("http://app.example/dashboard", {
      method: "POST",
      body: "a=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

  test("the locals the server resolved are handed to the action", async () => {
    const seen: unknown[] = [];
    await runAction(post(), target(seen), options(() => ({ role: "admin" })));
    expect(seen).toEqual([{ role: "admin" }]);
  });

  test("without a resolver the action sees nothing forwarded", async () => {
    const seen: unknown[] = [];
    await runAction(post(), target(seen), options());
    expect(seen).toEqual([{}]);
  });
});

describe("serve() wires both to the render-mode rule", () => {
  const server = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8").replaceAll("\r\n", "\n");
  test("loaders and actions read the locals through localsFrom(req, render)", () => {
    expect(server).toContain("locals: localsFrom(req, render),");
    expect(server).toContain("localsFor: (req) => localsFrom(req, render),");
  });
});
