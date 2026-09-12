// Phase 2, step 1: the session the go front verified reaches loaders and
// actions as ctx.session. Before this, go forwarded it in X-Borgo-Session and
// nothing on the render side read it - every loader called api("GET /api/me").
//
// The failure direction that matters is the other one: a render service
// started WITHOUT a front receives that header from whoever sent the request,
// and must not believe it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAction, sessionFrom, SESSION_HEADER, type ActionOptions } from "../src/util";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const withSession = (raw: string | null) => {
  const headers = new Headers();
  if (raw !== null) headers.set(SESSION_HEADER, raw);
  return new Request("http://app.example/tasks/1", { headers });
};

describe("sessionFrom", () => {
  test("in render mode, the front's fact is the session", () => {
    expect(sessionFrom(withSession(encode({ userId: 7, role: "admin" })), true)).toEqual({ userId: 7, role: "admin" });
  });

  // the exact bytes the go front puts on the wire for {"userId":7,"role":"admin"}
  // (front_test.go asserts it produces this literal): unpadded base64url of
  // the json go marshalled, keys in go's order
  test("reads the go front's wire form", () => {
    expect(sessionFrom(withSession("eyJyb2xlIjoiYWRtaW4iLCJ1c2VySWQiOjd9"), true)).toEqual({ role: "admin", userId: 7 });
  });

  test("outside render mode the header is a client's claim and is ignored", () => {
    expect(sessionFrom(withSession(encode({ userId: 1, role: "admin" })), false)).toBeNull();
  });

  test("absent or unreadable is nobody, never a partial session", () => {
    for (const raw of [null, "", "not base64url!!", encode("a string"), encode([1, 2]), encode(null), encode(42)]) {
      expect(sessionFrom(withSession(raw), true)).toBeNull();
    }
    // valid base64url that is not json
    expect(sessionFrom(withSession(Buffer.from("{not json").toString("base64url")), true)).toBeNull();
  });
});

describe("an action receives the session", () => {
  const options = (sessionFor?: ActionOptions["sessionFor"]): ActionOptions => ({
    dev: true,
    apiUrl: "http://127.0.0.1:1/api",
    serverError: null,
    csrfRejects: async () => false,
    maxBody: 1024,
    apiFor: () => (async () => ({})) as never,
    ...(sessionFor ? { sessionFor } : {}),
    runLoader: async () => ({}),
    renderPage: async () => new Response("page"),
    sendJson: (_req, value, init) => Response.json(value, init),
    renderOverlay: () => "",
    onError: () => {},
  });
  const target = (seen: Array<unknown>) =>
    ({
      route: {
        pattern: "/tasks/:id",
        file: "tasks/[id].tsx",
        layouts: [],
        module: {
          default: () => null,
          action: async (ctx: { session: unknown }) => {
            seen.push(ctx.session);
            return new Response(null, { status: 204 });
          },
        },
      },
      params: { id: "1" },
    }) as never;
  const post = () => new Request("http://app.example/tasks/1", { method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } });

  test("the session the server resolved is handed to the action", async () => {
    const seen: unknown[] = [];
    await runAction(post(), target(seen), options(() => ({ userId: 9 })));
    expect(seen).toEqual([{ userId: 9 }]);
  });

  test("without a resolver the action sees nobody", async () => {
    const seen: unknown[] = [];
    await runAction(post(), target(seen), options());
    expect(seen).toEqual([null]);
  });
});

// the wiring lives in serve()'s closure: pinned in the source, like the rest
// of the orchestration, so the loader and the action cannot be wired to
// different rules
describe("serve() wires both to the render-mode rule", () => {
  const server = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8").replaceAll("\r\n", "\n");
  test("loaders and actions read the session through sessionFrom(req, render)", () => {
    expect(server).toContain("session: sessionFrom(req, render),");
    expect(server).toContain("sessionFor: (req) => sessionFrom(req, render),");
  });
});
