import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { matchRoute, type PageModule, type Route } from "../src/router";
import { runAction, type ActionOptions, type RouteMatch } from "../src/util";
import type { ClientRoute, MountOptions } from "../src/runtime";

// action-413.test.ts reads runtime.ts's source for the wiring, which passes on
// code that does not work: drop the `return;` ending the too-large branch and
// execution falls through to `res.json()` on a drained body, into the catch,
// `location.reload()`. this runs mount() against a dom and asserts what the
// person at the form sees; the 413 is still the server's own, over real http

const CAP = 64;

// register() swaps the http primitives too, so `new Response(...)` inside
// util.ts would hand Bun.serve a happy-dom object it refuses. The dom is what
// is wanted here, not the network: bun's own are put back over it
const native = {
  fetch: globalThis.fetch,
  Response: globalThis.Response,
  Request: globalThis.Request,
  Headers: globalThis.Headers,
  URLSearchParams: globalThis.URLSearchParams,
};

GlobalRegistrator.register({ url: "https://app.test/form" });
Object.assign(globalThis, {
  Response: native.Response,
  Request: native.Request,
  Headers: native.Headers,
  URLSearchParams: native.URLSearchParams,
});
const { mount } = await import("../src/runtime");

const route = (pattern: string, module: Partial<PageModule>): Route => ({
  pattern,
  file: pattern.slice(1) + ".tsx",
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

const serverRoutes = [route("/form", { action: async () => ({ saved: true }) })];

const clientRoutes: ClientRoute[] = [
  { pattern: "/form", file: "form.tsx", hydrate: true, load: async () => ({ default: () => null }), layouts: [] },
  { pattern: "/custom", file: "custom.tsx", hydrate: true, load: async () => ({ default: () => null }), layouts: [] },
];

let front: ReturnType<typeof Bun.serve>;
let reloads = 0;
let writes = 0;

const tick = () => new Promise((r) => setTimeout(r, 0));

const waitFor = async (what: string, done: () => boolean) => {
  for (let i = 0; i < 400; i++) {
    if (done()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
};

const shell = () => {
  document.body.innerHTML = '<div id="root"></div><div id="forms"></div>';
};

const putForm = (action: string, typed: string) => {
  document.getElementById("forms")!.innerHTML =
    `<form method="post" action="${action}">` +
    `<input name="title" value="${typed}"><button type="submit">save</button></form>`;
  return {
    form: document.querySelector("form") as HTMLFormElement,
    input: document.querySelector("input") as HTMLInputElement,
    button: document.querySelector("button") as HTMLButtonElement,
  };
};

beforeAll(async () => {
  front = Bun.serve({
    port: 0,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    development: false,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/custom") return new Response("mine", { status: 200 });
      const target: RouteMatch | null = matchRoute(url.pathname, serverRoutes);
      const answered = await runAction(req, target, actionOptions(CAP));
      return answered ?? new Response("no action", { status: 405 });
    },
  });

  // the runtime's fetch is relative; send it to the real server over bun's own
  // fetch, not happy-dom's, so the 413 asserted on is the one util.ts writes
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    native.fetch(new URL(String(input), `http://127.0.0.1:${front.port}`), init)) as typeof fetch;

  (location as unknown as { reload: () => void }).reload = () => {
    reloads++;
  };
  const write = document.write.bind(document);
  document.write = (html: string) => {
    writes++;
    write(html);
  };

  shell();
  const hydrated = Promise.withResolvers<void>();
  const options: MountOptions = {
    createElement: ((type: unknown, props: unknown) => ({ type, props })) as MountOptions["createElement"],
    hydrateRoot: (() => {
      hydrated.resolve();
      return { render: () => {}, unmount: () => {} };
    }) as unknown as MountOptions["hydrateRoot"],
    routes: clientRoutes,
    notFound: null,
  };
  mount(options);
  await hydrated.promise;
  await tick();
});

afterAll(async () => {
  front?.stop(true);
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  reloads = 0;
  writes = 0;
  document.getElementById("borgo-overlay")?.remove();
});

const overlay = () => document.getElementById("borgo-overlay");

describe("what an oversized enhanced submit puts on screen", () => {
  test("the overlay appears and names the limit that refused the submit", async () => {
    const { button } = putForm("/form", "x".repeat(CAP * 4));
    button.click();

    await waitFor("the overlay", () => overlay() !== null);
    const text = overlay()!.textContent ?? "";
    expect(text).toContain("submission too large");
    expect(text).toContain("over the size limit");
    expect(text).toContain("nothing was saved");
    expect(text).toContain(`BORGO_MAX_BODY=${CAP}`);
  });

  test("the page does not reload and the form still holds what was typed", async () => {
    const typed = "the report I spent an hour on " + "y".repeat(CAP * 4);
    const { form, input } = putForm("/form", typed);
    (document.querySelector("button") as HTMLButtonElement).click();

    await waitFor("the overlay", () => overlay() !== null);
    await tick();
    expect(reloads).toBe(0);
    expect(writes).toBe(0);
    expect(input.value).toBe(typed);
    expect(input.isConnected).toBe(true);
    expect(form.isConnected).toBe(true);
    expect((document.querySelector('input[name="title"]') as HTMLInputElement).value).toBe(typed);
  });

  // without this the two above prove nothing: `reloads === 0` also holds when
  // the spy is never reached. an unmarked non-refusal still reloads
  test("an unmarked custom answer still reloads, and shows no overlay", async () => {
    const { button } = putForm("/custom", "small");
    button.click();

    await waitFor("the reload", () => reloads > 0);
    expect(reloads).toBe(1);
    expect(overlay()).toBeNull();
  });
});
