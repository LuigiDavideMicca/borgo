import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { matchRoute, type PageModule, type Route } from "../src/router";
import { actionOutcome, tooLargeDetail } from "../src/runtime";
import { runAction, type ActionOptions, type RouteMatch } from "../src/util";

// AN OVERSIZED ENHANCED SUBMIT RELOADED THE PAGE.
//
// The body limit refuses before the action runs, so its 413 carries no X-Borgo
// marker - and the runtime read "no marker" as "a custom response", whose
// documented handling is location.reload(). The form emptied, nothing was
// saved, and the one sentence the server had written (which limit, and its
// value) went out with the document.
//
// Everything below runs against a real bun server answering with util.ts's own
// runAction over real http: the 413 asserted on is the one the server writes,
// and the Response handed to actionOutcome is the one fetch returns, not a
// hand-built stand-in. A `new Response(null, {status: 413})` would pass these
// tests against a server that never answers that way.

const CAP = 64;

const route = (module: Partial<PageModule>): Route => ({
  pattern: "/form",
  file: "form.tsx",
  module: { default: () => null, ...module } as PageModule,
  layouts: [],
});

const actionOptions = (maxBody: number): ActionOptions => ({
  dev: false,
  apiUrl: "http://api.test/api",
  serverError: null,
  csrfRejects: async () => false,
  maxBody,
  apiFor: () => ({}) as never,
  runLoader: async () => ({ loaded: true }),
  renderPage: async () => new Response("doc", { headers: { "Content-Type": "text/html" } }),
  sendJson: (_req, value, init) => Response.json(value, init),
  renderOverlay: () => "overlay",
  onError: () => {},
});

let front: ReturnType<typeof Bun.serve>;

const routes = [
  route({ action: async () => ({ saved: true }) }),
  {
    ...route({
      action: async () => new Response("<h1>a document</h1>", { headers: { "Content-Type": "text/html" } }),
    }),
    pattern: "/document",
  },
];

beforeAll(() => {
  front = Bun.serve({
    port: 0,
    // what server.ts does: bun's own ceiling is out of the way and borgo counts
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    development: false,
    async fetch(req) {
      const url = new URL(req.url);
      // a reverse proxy in front of borgo (nginx client_max_body_size) writes
      // its own 413, as a whole html page and with no marker of any kind
      if (url.pathname === "/proxy") {
        return new Response("<html><body><h1>413 Request Entity Too Large</h1></body></html>", {
          status: 413,
          headers: { "Content-Type": "text/html" },
        });
      }
      // the escape hatch: an action answering with something of its own
      if (url.pathname === "/custom") return new Response("mine", { status: 200 });
      const target: RouteMatch | null = matchRoute(url.pathname, routes);
      const answered = await runAction(req, target, actionOptions(CAP));
      return answered ?? new Response("no action", { status: 405 });
    },
  });
});

afterAll(() => front?.stop(true));

const submit = (path: string, bytes: number) =>
  fetch(`http://127.0.0.1:${front.port}${path}`, {
    method: "POST",
    headers: { "X-Borgo-Action": "1", Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: "t=" + "x".repeat(Math.max(0, bytes - 2)),
  });

describe("a 413 an enhanced submit receives", () => {
  test("the server writes it unmarked - which is why the runtime had to reload", async () => {
    const res = await submit("/form", CAP * 4);
    expect(res.status).toBe(413);
    // the fact this defect was made of: no envelope exists yet, so there is no
    // X-Borgo to set. If util.ts ever marks it, this line is the one that says
    // so - and actionOutcome reads the status first, ahead of any marker
    expect(res.headers.get("X-Borgo")).toBeNull();
    expect(actionOutcome(res.clone())).toBe("too-large");
  });

  test("what the person at the form is shown names the limit that refused them", async () => {
    const detail = await tooLargeDetail(await submit("/form", CAP * 4));
    expect(detail).toContain(`BORGO_MAX_BODY=${CAP}`);
    expect(detail).toContain("nothing was saved");
    // and never the word the old path acted on
    expect(detail.toLowerCase()).not.toContain("reload");
  });

  test("a proxy's html 413 is still a refusal, and its page is not dumped on screen", async () => {
    const res = await fetch(`http://127.0.0.1:${front.port}/proxy`, { method: "POST" });
    expect(res.status).toBe(413);
    expect(actionOutcome(res.clone())).toBe("too-large");
    const detail = await tooLargeDetail(res);
    expect(detail).not.toContain("<html>");
    expect(detail).toContain("over the size limit");
  });

  test("the same submit under the limit is a normal action answer, marked", async () => {
    const res = await submit("/form", CAP - 8);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Borgo")).toBe("action");
    expect(actionOutcome(res.clone())).toBe("action");
    expect(await res.json()).toEqual({ props: { loaded: true }, actionData: { saved: true } });
  });

  test("the marked paths and the escape hatch are untouched by the new branch", async () => {
    const doc = await submit("/document", 8);
    expect(doc.headers.get("X-Borgo")).toBe("raw");
    expect(actionOutcome(doc.clone())).toBe("raw");
    await doc.text();

    // an unmarked response that is NOT a refusal still reloads: recognising a
    // 413 must not turn every custom answer into an overlay
    const custom = await submit("/custom", 8);
    expect(custom.status).toBe(200);
    expect(custom.headers.get("X-Borgo")).toBeNull();
    expect(actionOutcome(custom.clone())).toBe("unknown");
    await custom.text();
  });

  // the one assertion here that cannot come off the wire: no server writes a
  // marked 413 today, so reading the marker first is indistinguishable from
  // reading the status first - both classify every real response identically,
  // and swapping them leaves this file and the dom file green. What the order
  // is for is the day util.ts gains an envelope for the refusal, and only a
  // response built by hand can ask about that day
  test("a 413 that ever gains a marker is still a refusal, not an action answer", () => {
    expect(actionOutcome(new Response("too big", { status: 413, headers: { "X-Borgo": "action" } }))).toBe("too-large");
    expect(actionOutcome(new Response("too big", { status: 413, headers: { "X-Borgo": "raw" } }))).toBe("too-large");
  });

  // the branch itself lives inside mount(), which needs a document, a form and
  // a react root: action-413-dom.test.ts runs it against one and asserts what
  // the person at the form sees. This stays because it is cheap and it pins the
  // shape - but on its own it is not evidence: drop the `return;` ending the
  // branch and every line below still holds while the page reloads and the form
  // empties. Measured, not assumed.
  test("the too-large answer is wired to the overlay, ahead of the reload", () => {
    const src = readFileSync(join(import.meta.dir, "../src/runtime.ts"), "utf8");
    const submit = src.slice(src.indexOf("const outcome = actionOutcome(res)"));
    const tooLarge = submit.indexOf('if (outcome === "too-large")');
    const raw = submit.indexOf('if (outcome === "raw")');
    const unknown = submit.indexOf('if (outcome === "unknown")');
    expect(tooLarge).toBeGreaterThanOrEqual(0);
    expect(raw).toBeGreaterThan(tooLarge);
    expect(unknown).toBeGreaterThan(raw);
    const branch = submit.slice(tooLarge, raw);
    expect(branch).toContain("showOverlay(");
    expect(branch).toContain("tooLargeDetail(res)");
    expect(branch).not.toContain("location.reload()");
    expect(branch).not.toContain("nativeResubmit(");
  });

  test("a 403 and a 405 keep their own path, which is neither a reload nor an overlay", async () => {
    // 405 comes back unmarked from the server above (no route, no action), and
    // the runtime's 403/405 branch only runs for a marked action answer - so
    // what is pinned here is the classification, not the branch
    const res = await submit("/nowhere", 8);
    expect(res.status).toBe(405);
    expect(actionOutcome(res.clone())).toBe("unknown");
    await res.text();
  });
});
