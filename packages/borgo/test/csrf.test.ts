import { afterEach, describe, expect, test } from "bun:test";
import { makeApiClient } from "../src/api";
import { csrfCookieValue } from "../src/index";
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
