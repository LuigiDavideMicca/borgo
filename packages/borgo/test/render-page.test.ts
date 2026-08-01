import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { registerCsrf } from "../src/internal";
import type { PageModule, Route } from "../src/router";
import {
  DEV_INLINE_CLIENT,
  createSecurity,
  prepareShell,
  renderPage,
  withCookies,
  type RenderPageOptions,
} from "../src/util";

const SHELL =
  "<!doctype html><html><head><title>Shell</title>" +
  '<link rel="stylesheet" href="/assets/app.css"></head>' +
  '<body><div id="root"><!--app--></div><!--props-->' +
  '<script type="module" src="/assets/client.js"></script></body></html>';

const encoder = new TextEncoder();
const chunks = (...parts: string[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (const part of parts) yield encoder.encode(part);
  },
});

const route = (module: Partial<PageModule> = {}, extra: Partial<Route> = {}): Route => ({
  pattern: "/x",
  file: "x.tsx",
  module: { default: () => null, ...module } as PageModule,
  layouts: [],
  ...extra,
});

// tokens are deterministic and distinct: the first mint is t0, the next t1
const opts = (over: Partial<RenderPageOptions> = {}, dev = false): RenderPageOptions => {
  let n = 0;
  return {
    dev,
    shell: prepareShell(SHELL, dev),
    security: createSecurity(dev, {}),
    csrfCookieAttrs: "Path=/; SameSite=Lax",
    runLoader: async () => ({}),
    compose: (_route, props) => ({ marker: "composed", props }) as never,
    renderToStream: async () => chunks("<h1>page</h1>"),
    randomToken: () => `t${n++}`,
    onError: () => {},
    ...over,
  };
};

const get = (headers: Record<string, string> = {}) =>
  new Request("http://app.test/x", { headers });

const render = (
  o: RenderPageOptions,
  init: {
    req?: Request;
    route?: Route;
    params?: Record<string, string>;
    status?: number;
    extraProps?: Record<string, unknown>;
    extraCookies?: string[];
  } = {},
) =>
  renderPage(
    init.req ?? get(),
    init.route ?? route(),
    init.params ?? {},
    init.status ?? 200,
    o,
    init.extraProps,
    init.extraCookies ?? [],
  );

describe("renderPage: document assembly", () => {
  test("shell head, rendered chunks, props tail - in that order", async () => {
    const res = await render(opts({ runLoader: async () => ({ greeting: "hi" }) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    const body = await res.text();
    const root = body.indexOf('<div id="root"><h1>page</h1></div>');
    const props = body.indexOf('window.__PROPS__={"greeting":"hi"}');
    const title = body.indexOf(';window.__BORGO_TITLE__="Shell"</script>');
    expect(root).toBeGreaterThan(-1);
    expect(props).toBeGreaterThan(root);
    expect(title).toBeGreaterThan(props);
    expect(body.startsWith("<!doctype html>")).toBe(true);
    expect(body.endsWith("</body></html>")).toBe(true);
  });

  test("the loader's props reach the component and the wire", async () => {
    let composed: Record<string, unknown> | undefined;
    const res = await render(
      opts({
        runLoader: async (_req, _route, params) => ({ id: params.id, n: 7 }),
        compose: (_route, props) => {
          composed = props;
          return { props } as never;
        },
      }),
      { params: { id: "42" } },
    );
    expect(composed).toEqual({ id: "42", n: 7 });
    expect(await res.text()).toContain('window.__PROPS__={"id":"42","n":7}');
  });

  test("extraProps (actionData) merge over the loader's", async () => {
    const res = await render(opts({ runLoader: async () => ({ a: 1, b: 1 }) }), {
      extraProps: { b: 2 },
    });
    expect(await res.text()).toContain('window.__PROPS__={"a":1,"b":2}');
  });

  test("props that could close the script tag travel escaped", async () => {
    const res = await render(
      opts({ runLoader: async () => ({ x: "</script><script>alert(1)</script>" }) }),
    );
    const body = await res.text();
    expect(body).not.toContain("</script><script>alert(1)");
    // escaping "<" alone is what neutralizes a premature close
    expect(body).toContain('\\u003c/script>\\u003cscript>alert(1)');
  });

  test("the status is the caller's: error pages render with their own", async () => {
    expect((await render(opts(), { status: 404 })).status).toBe(404);
    expect((await render(opts(), { status: 500 })).status).toBe(500);
  });

  test("a loader that yields unserializable props fails before the render starts", async () => {
    let renderCalled = false;
    const o = opts({
      runLoader: async () => ({ big: 1n }) as never,
      renderToStream: async () => {
        renderCalled = true;
        return chunks("never");
      },
    });
    expect(render(o)).rejects.toThrow();
    await Bun.sleep(1);
    expect(renderCalled).toBe(false);
  });

  test("a rejecting render rejects the page: the caller owns the 500", async () => {
    const o = opts({
      renderToStream: async () => {
        throw new Error("react gave up");
      },
    });
    expect(render(o)).rejects.toThrow("react gave up");
  });
});

describe("renderPage: loader short-circuits", () => {
  test("a Response from the loader ships as-is, cookies attached", async () => {
    const res = await render(
      opts({
        runLoader: async (_req, _route, _params, onSetCookie) => {
          onSetCookie(["borgo_session=fresh; HttpOnly"]);
          return new Response(null, { status: 302, headers: { Location: "/login" } });
        },
      }),
      { extraCookies: ["from_action=1"] },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    // action cookies first, then what the loader's api calls collected
    expect(res.headers.getSetCookie()).toEqual(["from_action=1", "borgo_session=fresh; HttpOnly"]);
  });

  test("a short-circuit renders nothing and mints no csrf cookie", async () => {
    let renderCalled = false;
    const res = await render(
      opts({
        runLoader: async () => new Response("guarded", { status: 403 }),
        renderToStream: async () => {
          renderCalled = true;
          return chunks("never");
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(renderCalled).toBe(false);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("renderPage: csrf token and cookies", () => {
  test("a browser without a token gets one minted, with the given attributes", async () => {
    const res = await render(opts());
    const cookies = res.headers.getSetCookie();
    expect(cookies).toEqual(["borgo_csrf=t0; Path=/; SameSite=Lax"]);
  });

  test("an existing token is reused: nothing is re-minted", async () => {
    const res = await render(opts(), { req: get({ cookie: "borgo_csrf=existing" }) });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("ambiguous duplicate tokens read as none: a fresh one is minted", async () => {
    const res = await render(opts(), { req: get({ cookie: "borgo_csrf=a; borgo_csrf=b" }) });
    expect(res.headers.getSetCookie()).toEqual(["borgo_csrf=t0; Path=/; SameSite=Lax"]);
  });

  test("the token in the tree is the token in the cookie", async () => {
    // a fake react captures what withCsrf wraps the tree with
    registerCsrf({
      createElement: ((type: unknown, props: unknown, ...children: unknown[]) => ({
        type,
        props,
        children,
      })) as never,
      createContext: ((value: unknown) => ({ Provider: { ctx: true }, value })) as never,
      useContext: (() => "") as never,
    });
    let wrapped: { props?: { value?: string } } | undefined;
    const res = await render(
      opts({
        renderToStream: async (element) => {
          wrapped = element as never;
          return chunks("<h1>page</h1>");
        },
      }),
    );
    expect(wrapped?.props?.value).toBe("t0");
    expect(res.headers.getSetCookie()).toEqual(["borgo_csrf=t0; Path=/; SameSite=Lax"]);

    // and a cookie-held token is the one handed to the tree, not a fresh one
    await render(
      opts({
        renderToStream: async (element) => {
          wrapped = element as never;
          return chunks("x");
        },
      }),
      { req: get({ cookie: "borgo_csrf=held" }) },
    );
    expect(wrapped?.props?.value).toBe("held");
  });

  test("api cookies collected during the loader ride out with the mint", async () => {
    const res = await render(
      opts({
        runLoader: async (_req, _route, _params, onSetCookie) => {
          onSetCookie(["borgo_session=s1; HttpOnly"]);
          return {};
        },
      }),
      { extraCookies: ["seen_banner=1"] },
    );
    expect(res.headers.getSetCookie()).toEqual([
      "seen_banner=1",
      "borgo_session=s1; HttpOnly",
      "borgo_csrf=t0; Path=/; SameSite=Lax",
    ]);
  });
});

describe("renderPage: nonce and csp", () => {
  test("production: the props script and the csp share one nonce", async () => {
    const res = await render(opts());
    const body = await res.text();
    // t0 went to the csrf mint; the nonce is the second token
    expect(body).toContain('<script nonce="t1">window.__PROPS__=');
    expect(res.headers.get("Content-Security-Policy")).toContain("'nonce-t1'");
  });

  test("the same nonce is handed to react for its own inline scripts", async () => {
    let given: string | undefined;
    await render(
      opts({
        renderToStream: async (_element, init) => {
          given = init.nonce;
          return chunks("x");
        },
      }),
      { req: get({ cookie: "borgo_csrf=held" }) },
    );
    expect(given).toBe("t0");
  });

  test("dev swaps the nonce for 'unsafe-inline': no nonce anywhere", async () => {
    const res = await render(opts({}, true));
    const body = await res.text();
    expect(body).toContain("<script>window.__PROPS__=");
    expect(body).not.toContain("nonce=");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  test("security off entirely: no nonce, no csp, but the page still renders", async () => {
    const res = await render(opts({ security: null }));
    expect(await res.text()).toContain("<script>window.__PROPS__=");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  test("react render errors are reported, not swallowed", async () => {
    const seen: unknown[] = [];
    await render(
      opts({
        onError: (v) => void seen.push(v),
        renderToStream: async (_element, init) => {
          init.onError(new Error("boundary blew up"));
          return chunks("fallback");
        },
      }),
    );
    expect((seen[0] as Error).message).toBe("boundary blew up");
  });
});

describe("renderPage: head injection", () => {
  test("a page title replaces the shell's, and only in the document", async () => {
    const res = await render(opts(), { route: route({ head: { title: "Page Title" } }) });
    const body = await res.text();
    expect(body).toContain("<title>Page Title</title>");
    expect(body).not.toContain("<title>Shell</title>");
    // the shell's own title still reaches the client runtime as the base
    expect(body).toContain(';window.__BORGO_TITLE__="Shell"');
    // injected before </head>, not anywhere else
    expect(body.indexOf("<title>Page Title</title>")).toBeLessThan(body.indexOf("</head>"));
  });

  test("meta without a title keeps the shell title and adds the tags", async () => {
    const res = await render(opts(), {
      route: route({ head: { meta: [{ name: "description", content: "hello" }] } }),
    });
    const body = await res.text();
    expect(body).toContain("<title>Shell</title>");
    expect(body).toContain('<meta name="description" content="hello" data-borgo-head>');
  });

  test("a head computed from loader props sees them", async () => {
    const res = await render(
      opts({ runLoader: async () => ({ name: "Task 7" }) }),
      { route: route({ head: (props) => ({ title: `${props.name} - app` }) }) },
    );
    expect(await res.text()).toContain("<title>Task 7 - app</title>");
  });

  test("no head export leaves the shell start byte-identical", async () => {
    const res = await render(opts());
    const body = await res.text();
    expect(body.startsWith(SHELL.split("<!--app-->")[0])).toBe(true);
  });
});

describe("renderPage: hydrate=false and islands", () => {
  test("a zero-js page ships neither props nor the client script", async () => {
    const res = await render(opts(), { route: route({ hydrate: false }) });
    const body = await res.text();
    expect(body).toContain("<h1>page</h1>");
    expect(body).not.toContain("window.__PROPS__");
    expect(body).not.toContain("/assets/client.js");
    expect(body).not.toContain("islands-client");
  });

  test("islands swap the client entry for the islands entry", async () => {
    const res = await render(opts(), { route: route({ hydrate: false }, { islands: true }) });
    const body = await res.text();
    expect(body).toContain('<script type="module" src="/assets/islands-client.js"></script>');
    expect(body).not.toContain('src="/assets/client.js"');
    expect(body).not.toContain("window.__PROPS__");
  });

  test("in dev a zero-js page still carries the tiny reload client", async () => {
    const res = await render(opts({}, true), { route: route({ hydrate: false }) });
    const body = await res.text();
    expect(body).toContain(DEV_INLINE_CLIENT);
    expect(body).not.toContain("window.__PROPS__");
  });

  test("in production the zero-js tail has no per-request script at all", async () => {
    const res = await render(opts(), { route: route({ hydrate: false }) });
    expect(await res.text()).not.toContain("__borgo/dev");
  });

  test("hydrate: 'visible' still ships props - only false opts out", async () => {
    const res = await render(opts(), { route: route({ hydrate: "visible" }) });
    expect(await res.text()).toContain("window.__PROPS__=");
  });
});

describe("renderPage: dev vs prod compression", () => {
  test("production gzips for a client that accepts it, progressively", async () => {
    const res = await render(opts({ renderToStream: async () => chunks("<h1>a</h1>", "<p>b</p>") }), {
      req: get({ "accept-encoding": "gzip, br" }),
    });
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    const body = gunzipSync(Buffer.from(await res.arrayBuffer())).toString();
    expect(body).toContain("<h1>a</h1><p>b</p>");
    expect(body).toContain("window.__PROPS__=");
  });

  test("brotli is never negotiated for a rendered document", async () => {
    const res = await render(opts(), { req: get({ "accept-encoding": "br" }) });
    expect(res.headers.get("Content-Encoding")).toBeNull();
  });

  test("dev serves identity even to a gzip-accepting client", async () => {
    const res = await render(opts({}, true), { req: get({ "accept-encoding": "gzip" }) });
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.text()).toContain("<h1>page</h1>");
  });

  test("no accept-encoding, no compression", async () => {
    const res = await render(opts());
    expect(res.headers.get("Content-Encoding")).toBeNull();
  });
});

describe("prepareShell", () => {
  test("splits the shell once into head, tail and zero-js variants", () => {
    const s = prepareShell(SHELL, false);
    expect(s.start.endsWith('<div id="root">')).toBe(true);
    expect(s.head[0].endsWith('href="/assets/app.css">')).toBe(true);
    expect(s.head[1].startsWith("</head>")).toBe(true);
    expect(s.headNoTitle[0]).not.toContain("<title>");
    expect(s.endProps[0]).toBe("</div>");
    expect(s.endProps[1].startsWith('<script type="module" src="/assets/client.js">')).toBe(true);
    expect(s.stateTail).toBe(';window.__BORGO_TITLE__="Shell"</script>');
  });

  test("zero-js tails drop the client script; islands swap it", () => {
    const s = prepareShell(SHELL, false);
    expect(s.zeroJsEnd.plain).toBe("</div></body></html>");
    expect(s.zeroJsEnd.islands).toBe(
      '</div><script type="module" src="/assets/islands-client.js"></script></body></html>',
    );
  });

  test("the client script tag is found regardless of attribute order", () => {
    const shuffled = SHELL.replace(
      '<script type="module" src="/assets/client.js"></script>',
      '<script defer src="/assets/client.js" type="module" data-x="1"></script>',
    );
    const s = prepareShell(shuffled, false);
    expect(s.zeroJsEnd.plain).not.toContain("client.js");
  });

  test("dev wires the reload client into zero-js tails and flags the state", () => {
    const s = prepareShell(SHELL, true);
    expect(s.zeroJsEnd.plain).toContain(DEV_INLINE_CLIENT);
    expect(s.zeroJsEnd.islands).toContain(DEV_INLINE_CLIENT);
    expect(s.stateTail).toBe(';window.__BORGO_TITLE__="Shell";window.__BORGO_DEV__=1</script>');
  });

  // THE DEV FLAG HAS TO REACH EVERY PAGE THAT CAN RUN JS.
  //
  // __BORGO_DEV__ was written by the props script alone - and a hydrate=false
  // page emits no props script. Such a page is not inert: islands hydrate on it
  // through their own entry, so it runs client js with the flag absent, and
  // every guard reading it silently took the production branch. The one that
  // matters is registerServiceWorker, which index.ts advertises calling from an
  // island: it installed a caching service worker over a development session,
  // which then serves stale assets from cache and is the single most confusing
  // state to debug out of. The signal has to cover the pages that can execute
  // js, not the pages that hydrate.
  test("a zero-js dev page carries the dev flag, with or without islands", () => {
    const s = prepareShell(SHELL, true);
    for (const tail of [s.zeroJsEnd.plain, s.zeroJsEnd.islands]) {
      expect(tail).toContain("window.__BORGO_DEV__=1");
    }
    // the islands tail really is the zero-js page that still runs js
    expect(s.zeroJsEnd.islands).toContain("islands-client.js");
    expect(s.zeroJsEnd.islands).not.toContain("__PROPS__");
    // and it is set before the reload client opens its socket, so anything the
    // page runs afterwards sees it
    const tail = s.zeroJsEnd.plain;
    expect(tail.indexOf("__BORGO_DEV__")).toBeLessThan(tail.indexOf("WebSocket"));
  });

  test("production zero-js tails carry no dev flag and no reload client", () => {
    const s = prepareShell(SHELL, false);
    for (const tail of [s.zeroJsEnd.plain, s.zeroJsEnd.islands]) {
      expect(tail).not.toContain("__BORGO_DEV__");
      expect(tail).not.toContain("WebSocket");
    }
    expect(s.stateTail).not.toContain("__BORGO_DEV__");
  });

  test("a shell missing optional markers degrades instead of throwing", () => {
    const bare = "<html><body><!--app--></body></html>";
    const s = prepareShell(bare, false);
    expect(s.head).toEqual(["<html><body>", ""]);
    expect(s.headNoTitle).toEqual(["<html><body>", ""]);
    expect(s.endProps).toEqual(["</body></html>", ""]);
    expect(s.stateTail).toBe(';window.__BORGO_TITLE__=""</script>');
  });

  test("a shell title with script-breaking content is escaped into the state", () => {
    const s = prepareShell(SHELL.replace("<title>Shell</title>", "<title></script></title>"), false);
    expect(s.stateTail).toContain('"\\u003c/script>"');
    expect(s.stateTail.indexOf("</script>")).toBe(s.stateTail.length - "</script>".length);
  });
});

describe("withCookies", () => {
  test("appends without disturbing status, body or existing headers", async () => {
    const base = new Response("hello", { status: 201, headers: { "X-Keep": "1", "Set-Cookie": "a=1" } });
    const res = withCookies(base, ["b=2; HttpOnly", "c=3"]);
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("X-Keep")).toBe("1");
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2; HttpOnly", "c=3"]);
  });

  test("no cookies hands the very same response back", () => {
    const base = new Response("x");
    expect(withCookies(base, [])).toBe(base);
  });
});
