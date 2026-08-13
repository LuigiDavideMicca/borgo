import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { jsonResponse } from "../src/compress";
import { redirect } from "../src/index";
import { matchRoute, type PageModule, type Route } from "../src/router";
import {
  carryHeaders,
  createSecurity,
  freshCookieRequest,
  headResponse,
  runAction,
  runPropsRequest,
  type ActionOptions,
  type PropsOptions,
  type RouteMatch,
} from "../src/util";

const route = (module: Partial<PageModule> = {}, extra: Partial<Route> = {}): Route => ({
  pattern: "/x",
  file: "x.tsx",
  module: { default: () => null, ...module } as PageModule,
  layouts: [],
  ...extra,
});

const match = (module: Partial<PageModule> = {}, params: Record<string, string> = {}): RouteMatch => ({
  route: route(module),
  params,
});

// the default document a renderPage stub hands back, so a full render is
// always distinguishable from an envelope by its body alone
const DOC = "<!doctype html><html>rendered</html>";

const opts = (over: Partial<ActionOptions> = {}): ActionOptions => ({
  dev: false,
  apiUrl: "http://api.test/api",
  serverError: null,
  csrfRejects: async () => false,
  apiFor: () => ({}) as never,
  runLoader: async () => ({}),
  renderPage: async () =>
    new Response(DOC, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }),
  sendJson: (_req, value, init) => Response.json(value, init),
  renderOverlay: (error) => `<!doctype html><html>overlay:${String(error)}</html>`,
  onError: () => {},
  ...over,
});

const post = (headers: Record<string, string> = {}, body?: BodyInit) =>
  new Request("http://app.test/x", { method: "POST", headers, body });
const enhanced = (headers: Record<string, string> = {}, body?: BodyInit) =>
  post({ "X-Borgo-Action": "1", ...headers }, body);

const marker = (res: Response) => res.headers.get("X-Borgo");

describe("runAction: which envelope a post gets", () => {
  test("classic post, data back: a full render carrying actionData and the cookies", async () => {
    const seen: unknown[] = [];
    const res = await runAction(
      post(),
      match({ action: async () => ({ saved: 1 }) }),
      opts({
        renderPage: async (...args) => {
          seen.push(args);
          return new Response(DOC, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        },
      }),
    );
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe(DOC);
    // never marked: a native submit reads the document, not the envelope
    expect(marker(res!)).toBeNull();
    const [, r, params, status, extraProps, extraCookies] = seen[0] as [
      Request,
      Route,
      Record<string, string>,
      number,
      Record<string, unknown>,
      string[],
    ];
    expect(r.pattern).toBe("/x");
    expect(params).toEqual({});
    expect(status).toBe(200);
    expect(extraProps).toEqual({ actionData: { saved: 1 } });
    expect(extraCookies).toEqual([]);
  });

  test("enhanced post, data back: props + actionData under X-Borgo: action, no-store", async () => {
    const res = await runAction(
      enhanced(),
      match({ action: async () => ({ saved: 1 }), loader: async () => ({ list: [2] }) }),
      opts({ runLoader: async () => ({ list: [2] }) }),
    );
    expect(res!.status).toBe(200);
    expect(marker(res!)).toBe("action");
    expect(res!.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res!.json()).toEqual({ props: { list: [2] }, actionData: { saved: 1 } });
  });

  test("enhanced post, redirect back: the location becomes data, status 200", async () => {
    const res = await runAction(
      enhanced(),
      match({ action: async () => redirect("/done") }),
      opts(),
    );
    expect(res!.status).toBe(200);
    expect(marker(res!)).toBe("action");
    // the location must not ride out, or fetch() would follow it itself
    expect(res!.headers.get("Location")).toBeNull();
    expect(await res!.json()).toEqual({ redirect: "/done" });
  });

  test("classic post, redirect back: the redirect itself, untouched", async () => {
    const res = await runAction(post(), match({ action: async () => redirect("/done") }), opts());
    expect(res!.status).toBe(303);
    expect(res!.headers.get("Location")).toBe("/done");
    expect(marker(res!)).toBeNull();
  });

  test("enhanced post, an html response back: X-Borgo: raw, status and body kept", async () => {
    const res = await runAction(
      enhanced(),
      match({
        action: async () =>
          new Response("<html>custom</html>", {
            status: 422,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      }),
      opts(),
    );
    expect(res!.status).toBe(422);
    expect(marker(res!)).toBe("raw");
    expect(await res!.text()).toBe("<html>custom</html>");
  });

  test("enhanced post, a non-html non-redirect response: passed through unmarked", async () => {
    // the documented escape hatch - the runtime reloads on anything it
    // cannot read, so an unmarked answer must stay exactly as the action
    // built it
    const res = await runAction(
      enhanced(),
      match({ action: async () => Response.json({ id: 5 }, { status: 201 }) }),
      opts(),
    );
    expect(res!.status).toBe(201);
    expect(marker(res!)).toBeNull();
    expect(await res!.json()).toEqual({ id: 5 });
  });

  test("classic post, an html response back: verbatim, never marked raw", async () => {
    const res = await runAction(
      post(),
      match({
        action: async () =>
          new Response("<html>custom</html>", {
            status: 422,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      }),
      opts(),
    );
    expect(res!.status).toBe(422);
    expect(marker(res!)).toBeNull();
  });

  test("a location wins over an html body: the envelope redirects, the body is dropped", async () => {
    const res = await runAction(
      enhanced(),
      match({
        action: async () =>
          new Response("<html>ignored</html>", {
            status: 303,
            headers: { Location: "/done", "Content-Type": "text/html; charset=utf-8" },
          }),
      }),
      opts(),
    );
    expect(marker(res!)).toBe("action");
    expect(await res!.json()).toEqual({ redirect: "/done" });
  });

  test("any content-type naming text/html is raw, whatever case the action typed it in", async () => {
    for (const type of ["text/html", "text/html;charset=utf-8", "Text/Html", "TEXT/HTML"]) {
      const res = await runAction(
        enhanced(),
        match({ action: async () => new Response("<p>x</p>", { headers: { "Content-Type": type } }) }),
        opts(),
      );
      expect(marker(res!)).toBe("raw");
    }
  });

  test("a location at any status is a redirect to the enhanced path, and to it alone", async () => {
    // recorded, not endorsed: 201 Created + Location is not a redirect, but
    // the envelope reads any Location as one, so the two flows part ways -
    // the native form stays put on a body the browser will not show. borgo's
    // own redirect() is a 303, which both flows agree on.
    const created = () => new Response(null, { status: 201, headers: { Location: "/tasks/5" } });
    const enh = await runAction(enhanced(), match({ action: async () => created() }), opts());
    expect(await enh!.json()).toEqual({ redirect: "/tasks/5" });
    const cls = await runAction(post(), match({ action: async () => created() }), opts());
    expect(cls!.status).toBe(201);
    expect(cls!.headers.get("Location")).toBe("/tasks/5");
  });

  test("a custom document keeps the csp the security layer puts on documents", async () => {
    // the action path is the only place a content-type borgo did not write
    // reaches secure(): the /api proxy skips it, and the assets are typed
    // from their own extension
    const security = createSecurity(false, {})!;
    for (const type of ["text/html; charset=utf-8", "TEXT/HTML; charset=utf-8", "IMAGE/SVG+XML"]) {
      const res = await runAction(
        enhanced(),
        match({ action: async () => new Response("<p>x</p>", { headers: { "Content-Type": type } }) }),
        opts(),
      );
      expect(security.apply(res!).headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    }
  });
});

describe("runAction: the csrf gate", () => {
  test("enhanced: a 403 envelope the runtime can read", async () => {
    const res = await runAction(
      enhanced(),
      match({ action: async () => ({}) }),
      opts({ csrfRejects: async () => true }),
    );
    expect(res!.status).toBe(403);
    expect(marker(res!)).toBe("action");
    expect(res!.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res!.json()).toEqual({ csrf: true });
  });

  test("classic: plain text, no envelope, no marker", async () => {
    const res = await runAction(
      post(),
      match({ action: async () => ({}) }),
      opts({ csrfRejects: async () => true }),
    );
    expect(res!.status).toBe(403);
    expect(marker(res!)).toBeNull();
    expect(await res!.text()).toBe("invalid csrf token");
  });

  test("the gate runs before the action, not after", async () => {
    let ran = false;
    await runAction(
      post(),
      match({
        action: async () => {
          ran = true;
          return {};
        },
      }),
      opts({ csrfRejects: async () => true }),
    );
    expect(ran).toBe(false);
  });

  test("the gate is handed the real request, body included", async () => {
    let given: Request | null = null;
    await runAction(
      post({ "Content-Type": "text/plain" }, "body-bytes"),
      match({ action: async () => ({}) }),
      opts({
        csrfRejects: async (req) => {
          given = req;
          return false;
        },
      }),
    );
    expect(given).not.toBeNull();
    expect(await given!.clone().text()).toBe("body-bytes");
  });
});

describe("runAction: what is not an action", () => {
  test("enhanced post to a page without one: 405 unsupported, Allow set", async () => {
    const res = await runAction(enhanced(), match({}), opts());
    expect(res!.status).toBe(405);
    expect(marker(res!)).toBe("action");
    expect(res!.headers.get("Allow")).toBe("GET, HEAD");
    expect(await res!.json()).toEqual({ unsupported: true });
  });

  test("classic post to a page without one: not mine, the caller answers 405", async () => {
    expect(await runAction(post(), match({}), opts())).toBeNull();
  });

  test("enhanced post to no page at all: not mine either", async () => {
    expect(await runAction(enhanced(), null, opts())).toBeNull();
  });

  test("a non-function action export names the file it came from", async () => {
    const target = match({});
    (target.route.module as { action?: unknown }).action = "nope";
    await expect(runAction(post(), target, opts())).rejects.toThrow("pages/x.tsx must be a function");
  });

  test("the header must be exactly 1 to mean enhanced", async () => {
    for (const value of ["0", "true", "", "01"]) {
      const res = await runAction(
        post({ "X-Borgo-Action": value }),
        match({ action: async () => ({}) }),
        opts(),
      );
      expect(marker(res!)).toBeNull();
    }
  });
});

describe("runAction: the cookies the api issued", () => {
  // an api client that hands the collector one Set-Cookie per call
  const apiSetting = (...cookies: string[]) =>
    ((_req: Request, onSetCookie?: (c: string[]) => void) => {
      onSetCookie?.(cookies);
      return {} as never;
    }) as ActionOptions["apiFor"];

  test("they ride out on the json envelope", async () => {
    const res = await runAction(
      enhanced(),
      match({ action: async () => ({ ok: 1 }) }),
      opts({ apiFor: apiSetting("borgo_session=new; Path=/", "flash=hi; Path=/") }),
    );
    expect(res!.headers.getSetCookie()).toEqual(["borgo_session=new; Path=/", "flash=hi; Path=/"]);
  });

  test("they ride out on a response the action built itself", async () => {
    const res = await runAction(
      post(),
      match({ action: async () => redirect("/done") }),
      opts({ apiFor: apiSetting("borgo_session=new; Path=/") }),
    );
    expect(res!.status).toBe(303);
    expect(res!.headers.getSetCookie()).toEqual(["borgo_session=new; Path=/"]);
  });

  test("an action response's own cookies and the api's both survive the envelope", async () => {
    const res = await runAction(
      enhanced(),
      match({
        action: async () => {
          const r = new Response(null, { status: 303, headers: { Location: "/done" } });
          r.headers.append("Set-Cookie", "theirs=1; Path=/");
          r.headers.append("Set-Cookie", "second=2; Path=/");
          return r;
        },
      }),
      opts({ apiFor: apiSetting("borgo_session=new; Path=/") }),
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ redirect: "/done" });
    expect(res!.headers.getSetCookie()).toEqual([
      "theirs=1; Path=/",
      "second=2; Path=/",
      "borgo_session=new; Path=/",
    ]);
  });

  test("they reach the classic render as extraCookies, not as headers to merge later", async () => {
    let extra: string[] | undefined;
    await runAction(
      post(),
      match({ action: async () => ({}) }),
      opts({
        apiFor: apiSetting("borgo_session=new; Path=/"),
        renderPage: async (_r, _rt, _p, _s, _ep, extraCookies) => {
          extra = extraCookies;
          return new Response(DOC);
        },
      }),
    );
    expect(extra).toEqual(["borgo_session=new; Path=/"]);
  });

  test("a response with none passes through as the very object the action built", async () => {
    const built = redirect("/done");
    const res = await runAction(post(), match({ action: async () => built }), opts());
    expect(res).toBe(built);
  });

  // On the native path a render that threw after a successful action used to
  // go straight out to the server's own handler, which renders the 500 page
  // from the ORIGINAL request and knows nothing about the cookies this action
  // collected. An action that logged the user in through go and then threw
  // during render answered 500 with the session cookie dropped: go created the
  // session, the browser never got it, and the login silently did not stick.
  describe("a render that throws after the action must not drop them", () => {
    const login = { apiFor: apiSetting("borgo_session=new; Path=/; HttpOnly") };
    const boom = { renderPage: async () => { throw new Error("render exploded"); } };

    test("production: the 500 page is rendered here, with the cookies", async () => {
      let sawCookies: string[] | undefined;
      const errorPage = route({ default: () => null }, { file: "_500.tsx" });
      const res = await runAction(
        post(),
        match({ action: async () => ({ loggedIn: true }) }),
        opts({
          ...login,
          serverError: errorPage,
          renderPage: async (_r, rt, _p, status, _ep, extraCookies) => {
            if (rt.file !== "_500.tsx") throw new Error("render exploded");
            sawCookies = extraCookies;
            expect(status).toBe(500);
            return new Response(DOC, { status: 500 });
          },
        }),
      );
      expect(res!.status).toBe(500);
      expect(sawCookies).toEqual(["borgo_session=new; Path=/; HttpOnly"]);
    });

    test("production without a _500 page: a bare 500 still carries them", async () => {
      const res = await runAction(
        post(),
        match({ action: async () => ({}) }),
        opts({ ...login, ...boom, serverError: null }),
      );
      expect(res!.status).toBe(500);
      expect(res!.headers.getSetCookie()).toEqual(["borgo_session=new; Path=/; HttpOnly"]);
    });

    test("even when the _500 page throws in its turn", async () => {
      const res = await runAction(
        post(),
        match({ action: async () => ({}) }),
        opts({ ...login, ...boom, serverError: route({ default: () => null }, { file: "_500.tsx" }) }),
      );
      expect(res!.status).toBe(500);
      expect(res!.headers.getSetCookie()).toEqual(["borgo_session=new; Path=/; HttpOnly"]);
    });

    test("dev: the overlay carries them too", async () => {
      const res = await runAction(
        post(),
        match({ action: async () => ({}) }),
        opts({ ...login, ...boom, dev: true }),
      );
      expect(res!.status).toBe(500);
      expect(await res!.text()).toContain("overlay:");
      expect(res!.headers.getSetCookie()).toEqual(["borgo_session=new; Path=/; HttpOnly"]);
    });

    test("with no cookies to save, the error is still the server's to render", async () => {
      // nothing is lost by letting it out, and the server's handler is where
      // the dev overlay, the _500 page and the abort -> 499 rule all live
      await expect(
        runAction(post(), match({ action: async () => ({}) }), opts(boom)),
      ).rejects.toThrow("render exploded");
    });

    test("a client that hung up mid-action is still the server's 499 to make", async () => {
      const controller = new AbortController();
      const req = new Request("http://app.test/x", { method: "POST", signal: controller.signal });
      // the hangup lands while the action is in flight, which is when it really
      // happens: aborting before the call cannot tell a live read of the signal
      // from one hoisted to entry
      await expect(
        runAction(
          req,
          match({
            action: async () => {
              controller.abort();
              return {};
            },
          }),
          opts({ ...login, ...boom }),
        ),
      ).rejects.toThrow("render exploded");
    });

    // ...and it is the SAME 499 whichever way the form was posted. The abort
    // check used to sit inside the native branch alone, so an enhanced submit
    // (X-Borgo-Action: 1) from a client that was already gone still bought a
    // full _500 ssr render and its go round trip, written to a socket nobody
    // was reading - the exact waste the 499 in serve() says it closed. And it
    // is reachable with no credentials at all: csrfRejects returns false
    // immediately for a cookie-less client, so anyone able to open a connection
    // and hang up could buy one render per request.
    test("the enhanced path hands the abort back too, instead of rendering for nobody", async () => {
      // two axes. cookie-less is the DoS the comment above names; mid-action is
      // the hangup that actually happens, and the only timing that tells a live
      // read of the signal from one hoisted to entry
      for (const [who, credentials] of [["cookies", login], ["none", {}]] as const) {
        for (const when of ["before entry", "mid-action"] as const) {
          const controller = new AbortController();
          const req = new Request("http://app.test/x", {
            method: "POST",
            headers: { "X-Borgo-Action": "1" },
            signal: controller.signal,
          });
          if (when === "before entry") controller.abort();

          let rendered = 0;
          const errorPage = route({ default: () => null }, { file: "_500.tsx" });
          await expect(
            runAction(
              req,
              match({
                action: async () => {
                  if (when === "mid-action") controller.abort();
                  throw new Error("action exploded");
                },
              }),
              opts({
                ...credentials,
                serverError: errorPage,
                renderPage: async () => {
                  rendered++;
                  return new Response(DOC, { status: 500 });
                },
              }),
            ),
          ).rejects.toThrow("action exploded");
          // no _500 page, no loader, no go round trip
          expect(`${who}/${when}: ${rendered}`).toBe(`${who}/${when}: 0`);
        }
      }
    });

    // the guard is the abort, not the marker: an enhanced submit from a live
    // client still gets its document, and the cookies the action collected
    // before it threw ride along with it
    test("a live enhanced client still gets the error document, cookies attached", async () => {
      let rendered = 0;
      const errorPage = route({ default: () => null }, { file: "_500.tsx" });
      const res = await runAction(
        enhanced(),
        match({
          action: async () => {
            throw new Error("action exploded");
          },
        }),
        opts({
          ...login,
          serverError: errorPage,
          renderPage: async () => {
            rendered++;
            return new Response(DOC, { status: 500 });
          },
        }),
      );
      expect(rendered).toBe(1);
      expect(marker(res!)).toBe("raw");
      expect(res!.status).toBe(500);
      expect(res!.headers.getSetCookie()).toEqual(["borgo_session=new; Path=/; HttpOnly"]);
    });

    test("the enhanced path is unchanged: a marked document, not a thrown error", async () => {
      const res = await runAction(
        enhanced(),
        match({
          action: async () => {
            throw new Error("action exploded");
          },
        }),
        opts({ ...login, dev: true }),
      );
      expect(marker(res!)).toBe("raw");
      expect(res!.status).toBe(500);
    });

    // the happy native path still returns the rendered document, and the
    // `return await` that makes the catch reachable must not have changed it
    test("a render that succeeds is still handed back untouched", async () => {
      const res = await runAction(
        post(),
        match({ action: async () => ({ ok: 1 }) }),
        opts(login),
      );
      expect(res!.status).toBe(200);
      expect(await res!.text()).toBe(DOC);
      expect(marker(res!)).toBeNull();
    });
  });
});

describe("runAction: the post-action loader sees the new jar", () => {
  const apiSetting = (...cookies: string[]) =>
    ((_req: Request, onSetCookie?: (c: string[]) => void) => {
      onSetCookie?.(cookies);
      return {} as never;
    }) as ActionOptions["apiFor"];

  const cookieSeenBy = async (
    jar: string | undefined,
    setCookies: string[],
    wants: "enhanced" | "classic" = "enhanced",
  ) => {
    let seen: string | null | undefined;
    const req = (wants === "enhanced" ? enhanced : post)(jar ? { Cookie: jar } : {});
    await runAction(
      req,
      match({ action: async () => ({}) }),
      opts({
        apiFor: apiSetting(...setCookies),
        runLoader: async (r) => {
          seen = r.headers.get("cookie");
          return {};
        },
        renderPage: async (r) => {
          seen = r.headers.get("cookie");
          return new Response(DOC);
        },
      }),
    );
    return seen;
  };

  test("a login replaces the value the browser sent", async () => {
    expect(await cookieSeenBy("borgo_session=old", ["borgo_session=new; Path=/; HttpOnly"])).toBe(
      "borgo_session=new",
    );
  });

  test("a logout (Max-Age=0) removes it entirely", async () => {
    expect(await cookieSeenBy("borgo_session=old; theme=dark", ["borgo_session=; Max-Age=0"])).toBe(
      "theme=dark",
    );
  });

  test("a jar of only the cleared cookie leaves the header absent, not empty", async () => {
    expect(await cookieSeenBy("borgo_session=old", ["borgo_session=; Max-Age=0"])).toBeNull();
  });

  test("an ambiguous pair is dropped, exactly as go would refuse it", async () => {
    expect(await cookieSeenBy("a=1; a=2; b=ok", ["z=9"])).toBe("b=ok; z=9");
  });

  test("a Set-Cookie settles a name the browser sent ambiguously", async () => {
    expect(await cookieSeenBy("borgo_session=x; borgo_session=y", ["borgo_session=real"])).toBe(
      "borgo_session=real",
    );
  });

  test("the classic render is fed the same fresh jar", async () => {
    expect(await cookieSeenBy("borgo_session=old", ["borgo_session=new"], "classic")).toBe(
      "borgo_session=new",
    );
  });

  test("no api cookie at all: the loader is handed the original request object", async () => {
    const seen: Request[] = [];
    const req = enhanced({ Cookie: "borgo_session=old" });
    await runAction(
      req,
      match({ action: async () => ({}) }),
      opts({
        runLoader: async (r) => {
          seen.push(r);
          return {};
        },
      }),
    );
    expect(seen[0]).toBe(req);
  });

  test("cookies the post-action loader's own api issues are appended after the action's", async () => {
    const res = await runAction(
      enhanced(),
      match({ action: async () => ({}) }),
      opts({
        apiFor: apiSetting("from_action=1"),
        runLoader: async (_r, _rt, _p, onSetCookie) => {
          onSetCookie?.(["from_loader=2"]);
          return {};
        },
      }),
    );
    expect(res!.headers.getSetCookie()).toEqual(["from_action=1", "from_loader=2"]);
  });
});

describe("runAction: a loader that answers instead of loading", () => {
  test("its redirect becomes the envelope's redirect", async () => {
    const res = await runAction(
      enhanced(),
      match({ action: async () => ({ ok: 1 }) }),
      opts({ runLoader: async () => redirect("/login") }),
    );
    expect(res!.status).toBe(200);
    expect(marker(res!)).toBe("action");
    expect(await res!.json()).toEqual({ redirect: "/login" });
    // actionData is gone: the page it belonged to is not the page being shown
    expect(res!.headers.get("Location")).toBeNull();
  });

  test("its non-redirect response is handed back unmarked, cookies attached", async () => {
    const res = await runAction(
      enhanced(),
      match({ action: async () => ({}) }),
      opts({
        apiFor: ((_r: Request, on?: (c: string[]) => void) => {
          on?.(["a=1"]);
          return {} as never;
        }) as ActionOptions["apiFor"],
        runLoader: async () => new Response("forbidden", { status: 403 }),
      }),
    );
    expect(res!.status).toBe(403);
    expect(marker(res!)).toBeNull();
    expect(res!.headers.getSetCookie()).toEqual(["a=1"]);
  });

  test("its own headers survive the translation to a redirect envelope", async () => {
    const guard = new Response(null, { status: 303, headers: { Location: "/login" } });
    guard.headers.set("X-Guard", "session");
    guard.headers.set("Content-Length", "0");
    const res = await runAction(
      enhanced(),
      match({ action: async () => ({}) }),
      opts({ runLoader: async () => guard }),
    );
    expect(res!.headers.get("X-Guard")).toBe("session");
    // the source's content-* described a body this response does not carry
    expect(res!.headers.get("Content-Type")).toBe("application/json;charset=utf-8");
    expect(await res!.json()).toEqual({ redirect: "/login" });
  });

  test("the loader runs only on the enhanced path", async () => {
    let ran = 0;
    await runAction(
      post(),
      match({ action: async () => ({}) }),
      opts({
        runLoader: async () => {
          ran++;
          return {};
        },
      }),
    );
    // the classic path leaves the loader to renderPage, which runs it once
    expect(ran).toBe(0);
  });
});

describe("runAction: an action that throws", () => {
  const boom = { action: async () => { throw new Error("action exploded"); } };

  test("classic: the throw propagates, the caller owns the 500", async () => {
    await expect(runAction(post(), match(boom), opts())).rejects.toThrow("action exploded");
  });

  test("enhanced in dev: the overlay, wrapped as raw", async () => {
    const res = await runAction(enhanced(), match(boom), opts({ dev: true }));
    expect(res!.status).toBe(500);
    expect(marker(res!)).toBe("raw");
    expect(res!.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res!.text()).toContain("overlay:Error: action exploded");
  });

  test("enhanced in production: the _500 page, wrapped as raw", async () => {
    const res = await runAction(
      enhanced(),
      match(boom),
      opts({
        serverError: route({}, { pattern: "/_500", file: "_500.tsx" }),
        renderPage: async (_r, rt, _p, status) =>
          new Response(`500 page for ${rt.file}`, {
            status,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      }),
    );
    expect(res!.status).toBe(500);
    expect(marker(res!)).toBe("raw");
    expect(await res!.text()).toBe("500 page for _500.tsx");
  });

  test("enhanced in production with no _500 page: the bare text, still raw", async () => {
    const res = await runAction(enhanced(), match(boom), opts());
    expect(res!.status).toBe(500);
    expect(marker(res!)).toBe("raw");
    expect(await res!.text()).toBe("internal server error");
  });

  test("a _500 page whose own props will not serialize falls back to the bare text", async () => {
    const res = await runAction(
      enhanced(),
      match(boom),
      opts({
        serverError: route({}, { file: "_500.tsx" }),
        renderPage: async () => {
          throw new TypeError("Do not know how to serialize a BigInt");
        },
      }),
    );
    expect(res!.status).toBe(500);
    expect(marker(res!)).toBe("raw");
    expect(await res!.text()).toBe("internal server error");
  });

  test("the failure is reported exactly once, with the error itself", async () => {
    const seen: unknown[] = [];
    await runAction(enhanced(), match(boom), opts({ onError: (e) => seen.push(e) }));
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe("action exploded");
  });

  test("a _500 render that throws is not reported a second time", async () => {
    const seen: unknown[] = [];
    await runAction(
      enhanced(),
      match(boom),
      opts({
        serverError: route({}, { file: "_500.tsx" }),
        renderPage: async () => {
          throw new Error("render exploded");
        },
        onError: (e) => seen.push(e),
      }),
    );
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe("action exploded");
  });

  test("a loader that throws after the action succeeded takes the same path", async () => {
    const res = await runAction(
      enhanced(),
      match({ action: async () => ({ ok: 1 }) }),
      opts({
        runLoader: async () => {
          throw new Error("loader exploded");
        },
      }),
    );
    expect(res!.status).toBe(500);
    expect(marker(res!)).toBe("raw");
  });

  test("the cookies the api issued before the throw still reach the browser", async () => {
    // an action that logs in through go and then throws during the render left
    // go holding a session the browser was never told about: the user sees a
    // 500, retries, and logs in against a session that already exists. Both
    // flows carry them now - the native path was fixed first and this one had
    // the same shape, which is why the test above it asserts the same thing
    const res = await runAction(
      enhanced(),
      match({
        action: async () => {
          throw new Error("after the login");
        },
      }),
      opts({
        apiFor: ((_r: Request, on?: (c: string[]) => void) => {
          on?.(["borgo_session=new; Path=/"]);
          return {} as never;
        }) as ActionOptions["apiFor"],
      }),
    );
    expect(res!.headers.getSetCookie()).toEqual(["borgo_session=new; Path=/"]);
  });
});

describe("runAction: the envelope over the production json path", () => {
  const prod = (over: Partial<ActionOptions> = {}) =>
    opts({ sendJson: (req, value, init) => jsonResponse(req, value, init), ...over });

  test("a compressible envelope keeps its encoding and its markers", async () => {
    const res = await runAction(
      enhanced({ "Accept-Encoding": "gzip" }),
      match({ action: async () => ({ note: "x".repeat(4000) }) }),
      prod({ runLoader: async () => ({ list: "y".repeat(4000) }) }),
    );
    expect(res!.headers.get("Content-Encoding")).toBe("gzip");
    expect(marker(res!)).toBe("action");
    expect(res!.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res!.headers.get("Vary")).toBe("Accept-Encoding");
  });

  test("a gzipped redirect envelope survives carrying the source's headers", async () => {
    const from = new Response(null, {
      status: 303,
      headers: { Location: "/done", "Content-Encoding": "br", "Content-Type": "text/html" },
    });
    const res = await runAction(
      enhanced({ "Accept-Encoding": "gzip" }),
      match({ action: async () => from }),
      prod(),
    );
    // small payload: no gzip, and above all not the source's stale br claim
    expect(res!.headers.get("Content-Encoding")).toBeNull();
    expect(res!.headers.get("Content-Type")).toBe("application/json");
    expect(await res!.json()).toEqual({ redirect: "/done" });
  });

  test("the 405 envelope keeps Allow through the json builder", async () => {
    const res = await runAction(enhanced(), match({}), prod());
    expect(res!.status).toBe(405);
    expect(res!.headers.get("Allow")).toBe("GET, HEAD");
    expect(res!.headers.get("Content-Type")).toBe("application/json");
    expect(marker(res!)).toBe("action");
  });
});

describe("carryHeaders", () => {
  const src = (headers: Record<string, string>) => new Response("source body", { status: 303, headers });

  test("the envelope's own status and body win", async () => {
    const res = carryHeaders(src({ Location: "/a" }), Response.json({ redirect: "/a" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/a" });
  });

  test("location never rides along", () => {
    expect(carryHeaders(src({ Location: "/a" }), Response.json({})).headers.get("Location")).toBeNull();
  });

  test("the content-* family of the source is left behind", () => {
    const res = carryHeaders(
      src({ "Content-Type": "text/html", "Content-Length": "11", "Content-Encoding": "br" }),
      Response.json({}),
    );
    expect(res.headers.get("Content-Type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("Content-Length")).toBeNull();
    expect(res.headers.get("Content-Encoding")).toBeNull();
  });

  test("anything else is copied, case-insensitively excluded or not", () => {
    const res = carryHeaders(src({ "X-Guard": "session", "CONTENT-TYPE": "text/html", LOCATION: "/a" }), Response.json({}));
    expect(res.headers.get("X-Guard")).toBe("session");
    expect(res.headers.get("Location")).toBeNull();
  });

  test("set-cookie is appended, never collapsed onto the envelope's own", () => {
    const from = new Response(null, { status: 303 });
    from.headers.append("Set-Cookie", "a=1");
    from.headers.append("Set-Cookie", "b=2");
    const json = Response.json({});
    json.headers.append("Set-Cookie", "own=0");
    expect(carryHeaders(from, json).headers.getSetCookie()).toEqual(["own=0", "a=1", "b=2"]);
  });

  // only the headers of the source survive: its body is going nowhere, and
  // nobody else holds a reference to cancel it. Whatever is behind that stream
  // - an upstream socket for a Response the action proxied, a file handle -
  // stayed open for the life of the tab, one leak per redirect-with-a-body.
  // `redirect()` builds none, but a hand-written
  // `new Response(html, { status: 302, headers: { Location } })` does.
  test("the source's body is cancelled, not abandoned", async () => {
    let cancelled: unknown = "not cancelled";
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a fallback page nobody will read"));
      },
      cancel(reason) {
        cancelled = reason ?? null;
      },
    });
    const from = new Response(body, { status: 302, headers: { Location: "/done" } });
    const res = carryHeaders(from, Response.json({ redirect: "/done" }));

    expect(await res.json()).toEqual({ redirect: "/done" });
    // a microtask for the cancel() promise to run
    await Promise.resolve();
    expect(cancelled).not.toBe("not cancelled");
    expect(from.bodyUsed || from.body?.locked).toBeTruthy();
  });

  test("a bodyless source is no harder to carry than before", async () => {
    const res = carryHeaders(new Response(null, { status: 303, headers: { Location: "/a", "X-Guard": "1" } }), Response.json({ redirect: "/a" }));
    expect(res.headers.get("X-Guard")).toBe("1");
    expect(await res.json()).toEqual({ redirect: "/a" });
  });
});

describe("freshCookieRequest", () => {
  const req = (cookie?: string) =>
    new Request("http://app.test/x", {
      method: "POST",
      headers: cookie ? { Cookie: cookie, "X-Keep": "me" } : { "X-Keep": "me" },
    });

  test("no set-cookie: the same object, not a copy", () => {
    const r = req("a=1");
    expect(freshCookieRequest(r, [])).toBe(r);
  });

  test("the method and the other headers travel with it", () => {
    const fresh = freshCookieRequest(req("a=1"), ["b=2"]);
    expect(fresh.method).toBe("POST");
    expect(fresh.headers.get("X-Keep")).toBe("me");
    expect(fresh.url).toBe("http://app.test/x");
  });

  test("a jar emptied by the set-cookie loses the header rather than sending an empty one", () => {
    expect(freshCookieRequest(req("a=1"), ["a=; Max-Age=0"]).headers.get("cookie")).toBeNull();
  });

  test("a browser with no jar at all gains the freshly set cookie", () => {
    expect(freshCookieRequest(req(), ["a=1; Path=/"]).headers.get("cookie")).toBe("a=1");
  });
});

describe("runPropsRequest", () => {
  const propsOpts = (over: Partial<PropsOptions> = {}): PropsOptions => ({
    runLoader: async () => ({}),
    sendJson: (_req, value, init) => Response.json(value, init),
    ...over,
  });
  const get = (headers: Record<string, string> = {}, method = "GET") =>
    new Request("http://app.test/x?__borgo=props", { method, headers });

  test("the loader's data under props, never stored", async () => {
    const res = await runPropsRequest(get(), route(), {}, propsOpts({ runLoader: async () => ({ n: 1 }) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ props: { n: 1 } });
  });

  test("a loader redirect is surfaced as data, not as a location", async () => {
    const res = await runPropsRequest(get(), route(), {}, propsOpts({ runLoader: async () => redirect("/login") }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ redirect: "/login" });
  });

  test("a loader response that is not a redirect goes back as it is", async () => {
    const guard = new Response("forbidden", { status: 403 });
    const res = await runPropsRequest(get(), route(), {}, propsOpts({ runLoader: async () => guard }));
    expect(res).toBe(guard);
  });

  test("the cookies the loader's api issued ride out on all three shapes", async () => {
    const setting =
      (result: () => Promise<Record<string, unknown> | Response>): PropsOptions["runLoader"] =>
      async (_r, _rt, _p, on) => {
        on?.(["a=1"]);
        return result();
      };
    for (const result of [
      async () => ({ n: 1 }),
      async () => redirect("/login"),
      async () => new Response("forbidden", { status: 403 }),
    ]) {
      const res = await runPropsRequest(get(), route(), {}, propsOpts({ runLoader: setting(result) }));
      expect(res.headers.getSetCookie()).toEqual(["a=1"]);
    }
  });

  test("the route and its params reach the loader untouched", async () => {
    let seen: [Route, Record<string, string>] | null = null;
    const r = route({}, { pattern: "/tasks/:id", file: "tasks/[id].tsx" });
    await runPropsRequest(get(), r, { id: "7" }, propsOpts({
      runLoader: async (_req, rt, params) => {
        seen = [rt, params];
        return {};
      },
    }));
    expect(seen![0].pattern).toBe("/tasks/:id");
    expect(seen![1]).toEqual({ id: "7" });
  });

  test("a head on the props url still runs the loader and answers honestly", async () => {
    let ran = 0;
    const res = await runPropsRequest(get({}, "HEAD"), route(), {}, propsOpts({
      runLoader: async () => {
        ran++;
        return { n: 1 };
      },
    }));
    const headless = headResponse("HEAD", res);
    expect(ran).toBe(1);
    expect(headless.status).toBe(200);
    expect(headless.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await headless.text()).toBe("");
  });

  test("props over the production json path compress and vary", async () => {
    const res = await runPropsRequest(
      get({ "Accept-Encoding": "gzip" }),
      route(),
      {},
      propsOpts({ runLoader: async () => ({ n: "x".repeat(4000) }), sendJson: jsonResponse }),
    );
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("a redirect chain across the two units", () => {
  // a submit whose loader redirects, to a page whose loader redirects again:
  // the client follows the first envelope with a props fetch, and must find
  // the same shape there or the chain (and the hop cap guarding it) breaks
  const shapeOf = async (res: Response) => ({
    status: res.status,
    marker: res.headers.get("X-Borgo"),
    cache: res.headers.get("Cache-Control"),
    location: res.headers.get("Location"),
    body: await res.json(),
  });

  test("the action's redirect and the loader's redirect answer alike", async () => {
    const fromAction = await runAction(
      enhanced(),
      match({ action: async () => ({ ok: 1 }) }),
      opts({ runLoader: async () => redirect("/step-2") }),
    );
    const fromProps = await runPropsRequest(
      new Request("http://app.test/step-2?__borgo=props"),
      route(),
      {},
      { runLoader: async () => redirect("/step-3"), sendJson: (_r, v, i) => Response.json(v, i) },
    );
    const a = await shapeOf(fromAction!);
    const b = await shapeOf(fromProps);
    expect(a).toEqual({
      status: 200,
      marker: "action",
      cache: "private, no-store",
      location: null,
      body: { redirect: "/step-2" },
    });
    // the props answer carries no marker - it was never an action - but is
    // otherwise the same envelope the runtime already knows how to follow
    expect(b).toEqual({
      status: 200,
      marker: null,
      cache: "private, no-store",
      location: null,
      body: { redirect: "/step-3" },
    });
  });
});

// handle()'s ordering is what decides *whether* runAction is reached at all:
// a public/ file must never shadow a post, a get on the same path must never
// reach the action, and the metrics label must be stamped once. this mirrors
// that ordering over a socket, against the real units.
describe("the routing around the action, over a socket", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  const observed: Array<[string, number]> = [];
  const routes: Route[] = [
    route({ action: async () => ({ saved: 1 }), loader: async () => ({ list: [] }) }, { pattern: "/logo.png", file: "logo.png.tsx" }),
    route({ action: async () => ({ saved: 1 }) }, { pattern: "/x", file: "x.tsx" }),
    route({}, { pattern: "/plain", file: "plain.tsx" }),
  ];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      maxRequestBodySize: 64,
      async fetch(req) {
        const url = new URL(req.url);
        const label = { route: "*" };
        let res: Response;
        if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/logo.png") {
          // the asset branch, which runs before the post branch and only for
          // get/head
          res = new Response("PNG", { headers: { "Content-Type": "image/png" } });
        } else if (req.method === "POST") {
          const target = matchRoute(url.pathname, routes);
          if (target) label.route = target.route.pattern;
          res =
            (await runAction(req, target, opts())) ??
            new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
        } else if (req.method === "GET" || req.method === "HEAD") {
          const matched = matchRoute(url.pathname, routes);
          if (matched) label.route = matched.route.pattern;
          res = matched
            ? new Response(DOC, { headers: { "Content-Type": "text/html; charset=utf-8" } })
            : new Response("not found", { status: 404 });
        } else {
          res = new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
        }
        res = headResponse(req.method, res);
        observed.push([label.route, res.status]);
        return res;
      },
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  test("a public/ file does not shadow the action posted to the same path", async () => {
    const asset = await fetch(`${base}/logo.png`);
    expect(asset.headers.get("Content-Type")).toBe("image/png");
    const acted = await fetch(`${base}/logo.png`, {
      method: "POST",
      headers: { "X-Borgo-Action": "1" },
    });
    expect(acted.headers.get("X-Borgo")).toBe("action");
    expect(await acted.json()).toEqual({ props: {}, actionData: { saved: 1 } });
  });

  test("a get on an action url renders the page, the action never runs", async () => {
    const res = await fetch(`${base}/x`, { headers: { "X-Borgo-Action": "1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Borgo")).toBeNull();
    expect(await res.text()).toBe(DOC);
  });

  test("a head on an action url is the same answer without the body", async () => {
    const res = await fetch(`${base}/x`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("");
  });

  test("a classic post to a page without an action falls through to 405", async () => {
    const res = await fetch(`${base}/plain`, { method: "POST", body: "x=1" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
    expect(await res.text()).toBe("method not allowed");
  });

  test("the metrics label is the matched pattern, stamped once per request", async () => {
    observed.length = 0;
    await fetch(`${base}/x`, { method: "POST", headers: { "X-Borgo-Action": "1" } });
    expect(observed).toEqual([["/x", 200]]);
    observed.length = 0;
    await fetch(`${base}/plain`, { method: "POST" });
    // the fall-through 405 still carries the route it matched
    expect(observed).toEqual([["/plain", 405]]);
    observed.length = 0;
    await fetch(`${base}/nowhere`, { method: "POST" });
    expect(observed).toEqual([["*", 405]]);
  });

  test("a body at exactly the cap is accepted; one byte more is refused", async () => {
    const at = await fetch(`${base}/x`, {
      method: "POST",
      headers: { "X-Borgo-Action": "1", "Content-Type": "text/plain" },
      body: "b".repeat(64),
    });
    expect(at.status).toBe(200);
    expect(at.headers.get("X-Borgo")).toBe("action");
    const over = await fetch(`${base}/x`, {
      method: "POST",
      headers: { "X-Borgo-Action": "1", "Content-Type": "text/plain" },
      body: "b".repeat(65),
    });
    expect(over.status).toBe(413);
  });
});
