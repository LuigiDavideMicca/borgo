import { afterEach, describe, expect, test } from "bun:test";
import { makeApiClient } from "../src/api";
import { CSRF_HEADER, apiFetch, csrfCookieValue } from "../src/index";
import { registerCsrf, withCsrf } from "../src/internal";

describe("csrfCookieValue", () => {
  // the plain-reader cases the removed generic `cookieValue` used to cover:
  // csrfCookieValue is now the only cookie reader on the public surface, so
  // the ordinary paths are asserted here rather than through a second parser
  test("finds the token among several cookies", () => {
    expect(csrfCookieValue("a=1; borgo_csrf=tok3n; b=2")).toBe("tok3n");
  });

  test("exact name match only", () => {
    expect(csrfCookieValue("xborgo_csrf=nope")).toBe("");
    expect(csrfCookieValue("borgo_csrf_extra=nope")).toBe("");
  });

  test("empty and null headers", () => {
    expect(csrfCookieValue("")).toBe("");
    expect(csrfCookieValue(null)).toBe("");
  });

  test("a value may contain =", () => {
    expect(csrfCookieValue("borgo_csrf=a=b=c")).toBe("a=b=c");
  });

  test("two same-name cookies with different values are ambiguous: no token", () => {
    expect(csrfCookieValue("borgo_csrf=aaa; borgo_csrf=bbb")).toBe("");
  });

  test("junk + valid is still ambiguous: the browser cannot verify either", () => {
    expect(csrfCookieValue("borgo_csrf=!!junk!!; borgo_csrf=deadbeefcafe")).toBe("");
    expect(csrfCookieValue("borgo_csrf=deadbeefcafe; borgo_csrf=!!junk!!")).toBe("");
    expect(csrfCookieValue("borgo_csrf=; borgo_csrf=deadbeefcafe")).toBe("");
  });

  test("valid + valid with different values: no token, mirroring the go side", () => {
    expect(csrfCookieValue("borgo_csrf=deadbeefcafe; other=1; borgo_csrf=beefdeadface")).toBe("");
  });

  test("identical duplicates are one token, not a conflict", () => {
    expect(csrfCookieValue("borgo_csrf=tok; a=2; borgo_csrf=tok")).toBe("tok");
  });
});

// the browser's half: without this, the front server's /api check would 403
// every hand-written mutation a hydrated page makes - the shipped templates'
// logout and delete buttons included
describe("apiFetch", () => {
  const TOKEN = "deadbeefcafe4444aaaa000011112222";
  const realFetch = globalThis.fetch;
  const realDocument = (globalThis as { document?: unknown }).document;

  // normalised through Request, so these assert what the call carries rather
  // than how it was spelled: fetch(request) and fetch(input, init) meaning the
  // same request have to read the same here, or the suite is pinning an
  // implementation detail instead of a behaviour
  const capture = () => {
    const seen: Request[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input as RequestInfo, init));
      return new Response("{}");
    }) as unknown as typeof fetch;
    return seen;
  };
  const cookie = (value: string) => {
    (globalThis as { document?: unknown }).document = { cookie: value };
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = realDocument;
  });

  test("an unsafe method carries the token from the cookie", async () => {
    const seen = capture();
    cookie(`a=1; borgo_csrf=${TOKEN}`);
    await apiFetch("http://app.test/api/logout", { method: "POST" });
    expect(seen[0].headers.get(CSRF_HEADER)).toBe(TOKEN);
    expect(seen[0].method).toBe("POST");
  });

  test("PUT, PATCH and DELETE carry it too", async () => {
    const seen = capture();
    cookie(`borgo_csrf=${TOKEN}`);
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      await apiFetch("http://app.test/api/notes/1", { method });
    }
    expect(seen.map((r) => r.headers.get(CSRF_HEADER))).toEqual([TOKEN, TOKEN, TOKEN]);
  });

  test("safe methods carry nothing: the front server never asks", async () => {
    const seen = capture();
    cookie(`borgo_csrf=${TOKEN}`);
    await apiFetch("http://app.test/api/me");
    await apiFetch("http://app.test/api/me", { method: "HEAD" });
    expect(seen.map((r) => r.headers.get(CSRF_HEADER))).toEqual([null, null]);
  });

  test("no token cookie, no header - and the call still goes out", async () => {
    const seen = capture();
    cookie("theme=dark");
    const res = await apiFetch("http://app.test/api/logout", { method: "POST" });
    expect(res.status).toBe(200);
    expect(seen[0].headers.get(CSRF_HEADER)).toBe(null);
  });

  test("conflicting duplicates read as absent here as well, not as a guess", async () => {
    const seen = capture();
    cookie(`borgo_csrf=${TOKEN}; borgo_csrf=beefdeadfaceb000000011112222aaaa`);
    await apiFetch("http://app.test/api/logout", { method: "POST" });
    expect(seen[0].headers.get(CSRF_HEADER)).toBe(null);
  });

  test("a Request input keeps its method, its headers and its body", async () => {
    // init is empty here, so a naive merge would read the method as GET and
    // replace the caller's headers with nothing
    const seen = capture();
    cookie(`borgo_csrf=${TOKEN}`);
    const request = new Request("http://app.test/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app": "mine" },
      body: JSON.stringify({ title: "hi" }),
    });
    await apiFetch(request);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.get(CSRF_HEADER)).toBe(TOKEN);
    expect(seen[0].headers.get("x-app")).toBe("mine");
    expect(await seen[0].json()).toEqual({ title: "hi" });
  });

  test("a header the caller set themselves is left alone", async () => {
    const seen = capture();
    cookie(`borgo_csrf=${TOKEN}`);
    await apiFetch("http://app.test/api/logout", {
      method: "POST",
      headers: { [CSRF_HEADER]: "mine" },
    });
    expect(seen[0].headers.get(CSRF_HEADER)).toBe("mine");
  });

  test("no document at all (ssr, a worker) is not a crash", async () => {
    const seen = capture();
    delete (globalThis as { document?: unknown }).document;
    await apiFetch("http://app.test/api/logout", { method: "POST" });
    expect(seen[0].headers.get(CSRF_HEADER)).toBe(null);
  });
});

describe("withCsrf", () => {
  test("passes the element through when no react is registered", () => {
    // the registry is module state and another suite in this process may have
    // filled it: this test owns the empty case, so it clears it first
    registerCsrf(null);
    const element = { marker: true };
    expect(withCsrf(element as never, "token")).toBe(element as never);
  });
});

describe("api client set-cookie forwarding", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("collects every set-cookie header, including on errors", async () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "borgo_session=abc; Path=/");
    headers.append("Set-Cookie", "other=1");
    globalThis.fetch = (async () =>
      new Response("{}", { headers })) as unknown as typeof fetch;

    const seen: string[] = [];
    const api = makeApiClient("http://api:1", {}, (cookies) => seen.push(...cookies));
    await api("GET /api/tasks");
    expect(seen).toEqual(["borgo_session=abc; Path=/", "other=1"]);

    seen.length = 0;
    globalThis.fetch = (async () =>
      new Response("no", { status: 401, headers })) as unknown as typeof fetch;
    await expect(api("GET /api/tasks")).rejects.toThrow("responded 401");
    expect(seen.length).toBe(2);
  });
});
