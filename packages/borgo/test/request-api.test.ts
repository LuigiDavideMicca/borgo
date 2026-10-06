import { afterEach, expect, test } from "bun:test";
import { requestApiClient } from "../src/util";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// what go sets during one page request is carried by that request's next
// call: an action that registers and then uploads is one session, not a
// signed-in call followed by an anonymous one (found by the verifier of
// phase 5). The browser is still told, through onSetCookie
test("a cookie go sets is sent on the next call of the same request", async () => {
  const sent: (string | undefined)[] = [];
  const answers = [
    () => Response.json({}, { status: 201, headers: [["Set-Cookie", "borgo_session=new; Path=/; HttpOnly"]] }),
    () => new Response(null, { status: 204 }),
    () => new Response(null, { status: 204, headers: [["Set-Cookie", "borgo_session=; Path=/; Max-Age=0"]] }),
    () => new Response(null, { status: 204 }),
  ];
  globalThis.fetch = (async (_url: URL | string, init: RequestInit = {}) => {
    sent.push((init.headers as Record<string, string>).cookie);
    return answers[sent.length - 1]();
  }) as typeof fetch;
  const forwarded: string[] = [];
  const defaults = { "X-Borgo-Internal": "k" };
  const api = requestApiClient("http://api:1", defaults, "borgo_csrf=t", (c) => forwarded.push(...c), 0) as unknown as (route: string) => Promise<unknown>;
  await api("POST /api/register");
  await api("POST /api/attachments");
  await api("POST /api/logout");
  await api("GET /api/me");
  expect(sent).toEqual(["borgo_csrf=t", "borgo_csrf=t; borgo_session=new", "borgo_csrf=t; borgo_session=new", "borgo_csrf=t"]);
  expect(forwarded).toEqual(["borgo_session=new; Path=/; HttpOnly", "borgo_session=; Path=/; Max-Age=0"]);
  // the server's own defaults are the server's: one request's jar never
  // reaches the next request
  expect(defaults).toEqual({ "X-Borgo-Internal": "k" });
});

test("a request with no cookie gains them call by call, and loses one with no header left", async () => {
  const sent: (string | undefined)[] = [];
  const answers = [
    () => new Response(null, { status: 204, headers: [["Set-Cookie", "borgo_session=s; Path=/"]] }),
    () => new Response(null, { status: 204, headers: [["Set-Cookie", "theme=dark; Path=/"]] }),
    () => new Response(null, { status: 204, headers: [["Set-Cookie", "borgo_session=; Max-Age=0"]] }),
    () => new Response(null, { status: 204, headers: [["Set-Cookie", "theme=; Max-Age=0"]] }),
    () => new Response(null, { status: 204 }),
  ];
  globalThis.fetch = (async (_url: URL | string, init: RequestInit = {}) => {
    sent.push((init.headers as Record<string, string>).cookie);
    return answers[sent.length - 1]();
  }) as typeof fetch;
  const defaults = {};
  const api = requestApiClient("http://api:1", defaults, null, undefined, 0) as unknown as (route: string) => Promise<unknown>;
  for (let i = 0; i < answers.length; i++) await api("POST /api/x");
  expect(sent).toEqual([undefined, "borgo_session=s", "borgo_session=s; theme=dark", "theme=dark", undefined]);
  expect(defaults).toEqual({});
});
