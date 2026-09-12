import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CSRF_HEADER } from "../src/index";
import { csrfRejects, keysEqual } from "../src/util";

const TOKEN = "deadbeefcafe4444aaaa000011112222";

const post = (init: { cookie?: string; body?: BodyInit; type?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.type) headers["content-type"] = init.type;
  return new Request("http://app.test/login", {
    method: "POST",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
};

const form = (fields: Record<string, string>) => {
  const params = new URLSearchParams(fields);
  return {
    body: params.toString(),
    type: "application/x-www-form-urlencoded",
  };
};

const enforced = { enforced: true };

describe("csrfRejects: who the check runs for", () => {
  test("disabled: nothing rejects, not even a naked cross-site post", async () => {
    const req = post({ cookie: "borgo_session=s", ...form({}) });
    expect(await csrfRejects(req, { enforced: false })).toBe(false);
  });

  test("a cookie-less client (curl, api consumer) is unaffected", async () => {
    expect(await csrfRejects(post({ ...form({}) }), enforced)).toBe(false);
  });

  test("unrelated cookies alone do not arm the check", async () => {
    expect(await csrfRejects(post({ cookie: "theme=dark", ...form({}) }), enforced)).toBe(false);
  });

  test("a session without a token rejects, before touching the body", async () => {
    const req = post({ cookie: "borgo_session=s", ...form({}) });
    expect(await csrfRejects(req, enforced)).toBe(true);
    // the reject happened on the cookie header alone: the body is untouched
    // and the (rejected) action path never paid for a parse
    expect(req.bodyUsed).toBe(false);
  });

  test("login csrf: a token cookie without a session still arms the check", async () => {
    // no borgo_session, but the browser was issued a token: a cross-site
    // post could otherwise log the victim into the attacker's account
    const req = post({ cookie: `borgo_csrf=${TOKEN}`, ...form({}) });
    expect(await csrfRejects(req, enforced)).toBe(true);
  });

  test("a shadowed session cookie still counts as a session", async () => {
    // presence, not value: duplicates cannot switch the check off
    const req = post({ cookie: "borgo_session=a; borgo_session=b", ...form({}) });
    expect(await csrfRejects(req, enforced)).toBe(true);
  });
});

describe("csrfRejects: the double submit", () => {
  const armed = (extra: Record<string, string> = {}) =>
    post({ cookie: `borgo_session=s; borgo_csrf=${TOKEN}`, ...form(extra) });

  test("cookie and form field agreeing pass", async () => {
    expect(await csrfRejects(armed({ __borgo_csrf: TOKEN }), enforced)).toBe(false);
  });

  test("a wrong token rejects", async () => {
    expect(await csrfRejects(armed({ __borgo_csrf: "not-the-token" }), enforced)).toBe(true);
  });

  test("an empty field rejects", async () => {
    expect(await csrfRejects(armed({ __borgo_csrf: "" }), enforced)).toBe(true);
  });

  test("a missing field rejects", async () => {
    expect(await csrfRejects(armed({ other: "x" }), enforced)).toBe(true);
  });

  test("a token prefix is not a token: length must match too", async () => {
    expect(await csrfRejects(armed({ __borgo_csrf: TOKEN.slice(0, -1) }), enforced)).toBe(true);
    expect(await csrfRejects(armed({ __borgo_csrf: TOKEN + "0" }), enforced)).toBe(true);
  });

  test("the token travels in the form body, never in the query", async () => {
    const req = new Request(`http://app.test/login?__borgo_csrf=${TOKEN}`, {
      method: "POST",
      headers: {
        cookie: `borgo_session=s; borgo_csrf=${TOKEN}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "other=x",
    });
    expect(await csrfRejects(req, enforced)).toBe(true);
  });

  test("multipart forms carry the field just as well", async () => {
    const data = new FormData();
    data.set("__borgo_csrf", TOKEN);
    data.set("file", new Blob(["payload"]), "a.txt");
    const req = new Request("http://app.test/upload", {
      method: "POST",
      headers: { cookie: `borgo_session=s; borgo_csrf=${TOKEN}` },
      body: data,
    });
    expect(await csrfRejects(req, enforced)).toBe(false);
  });

  test("a percent-encoded token decodes exactly as the action will decode it", async () => {
    // one parser, one answer: the check must read what formData() reads
    const encoded = TOKEN.split("").map((ch) => `%${ch.charCodeAt(0).toString(16)}`).join("");
    const req = post({
      cookie: `borgo_session=s; borgo_csrf=${TOKEN}`,
      body: `__borgo_csrf=${encoded}`,
      type: "application/x-www-form-urlencoded",
    });
    expect(await csrfRejects(req, enforced)).toBe(false);
  });
});

describe("csrfRejects: ambiguous cookies", () => {
  test("duplicate csrf cookies that disagree are no token: reject both echoes", async () => {
    for (const echoed of [TOKEN, "beefdeadfaceb000000011112222aaaa"]) {
      const req = post({
        cookie: `borgo_session=s; borgo_csrf=${TOKEN}; borgo_csrf=beefdeadfaceb000000011112222aaaa`,
        ...form({ __borgo_csrf: echoed }),
      });
      expect(await csrfRejects(req, enforced)).toBe(true);
    }
  });

  test("identical duplicates are one token and still pass", async () => {
    const req = post({
      cookie: `borgo_csrf=${TOKEN}; a=1; borgo_csrf=${TOKEN}`,
      ...form({ __borgo_csrf: TOKEN }),
    });
    expect(await csrfRejects(req, enforced)).toBe(false);
  });

  test("a tossed empty duplicate poisons the token, not the check", async () => {
    // borgo_csrf=; borgo_csrf=TOKEN is ambiguous -> no token -> reject.
    // crucially the check still RUNS: the cookie is present, so an attacker
    // who can toss a duplicate cannot make the browser look token-less
    const req = post({
      cookie: `borgo_csrf=; borgo_csrf=${TOKEN}`,
      ...form({ __borgo_csrf: TOKEN }),
    });
    expect(await csrfRejects(req, enforced)).toBe(true);
  });
});

describe("csrfRejects: bodies that are not forms", () => {
  const cookie = `borgo_session=s; borgo_csrf=${TOKEN}`;

  test("a json body from a sessioned browser rejects instead of throwing", async () => {
    // formData() throws on json; the catch turns that into "no token given"
    const req = post({ cookie, body: JSON.stringify({ x: 1 }), type: "application/json" });
    expect(await csrfRejects(req, enforced)).toBe(true);
  });

  test("a body-less post with a session rejects", async () => {
    expect(await csrfRejects(post({ cookie }), enforced)).toBe(true);
  });

  test("garbage bytes under a form content-type read as no token", async () => {
    const req = post({ cookie, body: "\x00\x01\x02 not a form", type: "application/x-www-form-urlencoded" });
    expect(await csrfRejects(req, enforced)).toBe(true);
  });

  test("the action can still read the body after a passing check", async () => {
    const req = post({ cookie, ...form({ __borgo_csrf: TOKEN, title: "hello" }) });
    expect(await csrfRejects(req, enforced)).toBe(false);
    // the check parsed a clone; the real request's body is still there
    const parsed = await req.formData();
    expect(parsed.get("title")).toBe("hello");
  });

  test("the action can still read the body after a failing compare too", async () => {
    const req = post({ cookie, ...form({ __borgo_csrf: "wrong" }) });
    expect(await csrfRejects(req, enforced)).toBe(true);
    expect((await req.formData()).get("__borgo_csrf")).toBe("wrong");
  });

  test("a large form body neither chokes nor leaks: the clone shares the store", async () => {
    const big = "x".repeat(4 * 1024 * 1024);
    const req = post({ cookie, ...form({ __borgo_csrf: TOKEN, payload: big }) });
    expect(await csrfRejects(req, enforced)).toBe(false);
    expect(((await req.formData()).get("payload") as string).length).toBe(big.length);
  });
});

// the /api half of the same token: the echo rides in a header because an api
// body is json and has no field to put it in
describe("keysEqual", () => {
  test("equality, inequality, and length mismatch", () => {
    expect(keysEqual(TOKEN, TOKEN)).toBe(true);
    expect(keysEqual(TOKEN, TOKEN.slice(0, -1) + "f")).toBe(false);
    expect(keysEqual("short", "longer-value")).toBe(false);
    expect(keysEqual("", "")).toBe(true);
    expect(keysEqual("", "x")).toBe(false);
  });

  test("multi-byte strings compare by bytes, not by chars", () => {
    expect(keysEqual("caffè", "caffè")).toBe(true);
    expect(keysEqual("caffè", "caffè")).toBe(false);
  });
});
