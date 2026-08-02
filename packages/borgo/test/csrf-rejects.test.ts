import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CSRF_HEADER } from "../src/index";
import { apiCsrfRejects, csrfRejects, keysEqual } from "../src/util";

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
describe("apiCsrfRejects", () => {
  const call = (
    method: string,
    init: { cookie?: string; token?: string; body?: BodyInit } = {},
  ) => {
    const headers: Record<string, string> = {};
    if (init.cookie) headers.cookie = init.cookie;
    if (init.token !== undefined) headers[CSRF_HEADER] = init.token;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return new Request("http://app.test/api/login", {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  };
  const armed = `borgo_csrf=${TOKEN}`;

  test("disabled: nothing rejects", () => {
    expect(apiCsrfRejects(call("POST", { cookie: armed }), { enforced: false })).toBe(false);
  });

  describe("an unsafe method with the cookie", () => {
    test("a matching header passes", () => {
      expect(apiCsrfRejects(call("POST", { cookie: armed, token: TOKEN }), enforced)).toBe(false);
    });

    test("a wrong header rejects", () => {
      const req = call("POST", { cookie: armed, token: "beefdeadfaceb000000011112222aaaa" });
      expect(apiCsrfRejects(req, enforced)).toBe(true);
    });

    test("a missing header rejects", () => {
      expect(apiCsrfRejects(call("POST", { cookie: armed }), enforced)).toBe(true);
    });

    test("an empty header rejects", () => {
      expect(apiCsrfRejects(call("POST", { cookie: armed, token: "" }), enforced)).toBe(true);
    });

    test("a token prefix is not a token: length must match too", () => {
      expect(apiCsrfRejects(call("POST", { cookie: armed, token: TOKEN.slice(0, -1) }), enforced)).toBe(true);
      expect(apiCsrfRejects(call("POST", { cookie: armed, token: TOKEN + "0" }), enforced)).toBe(true);
    });

    test("PUT, PATCH and DELETE are checked exactly as POST is", () => {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        expect(apiCsrfRejects(call(method, { cookie: armed }), enforced)).toBe(true);
        expect(apiCsrfRejects(call(method, { cookie: armed, token: TOKEN }), enforced)).toBe(false);
      }
    });

    test("the verdict is reached without reading the body", () => {
      // the proxy buffers or streams this body to go straight after; a check
      // that consumed it would leave the request with nothing to forward
      const req = call("POST", { cookie: armed, body: JSON.stringify({ x: 1 }) });
      expect(apiCsrfRejects(req, enforced)).toBe(true);
      expect(req.bodyUsed).toBe(false);
    });
  });

  describe("who the check does not run for", () => {
    test("safe methods are untouched, token or no token", () => {
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        expect(apiCsrfRejects(call(method, { cookie: armed }), enforced)).toBe(false);
      }
    });

    test("a cookie-less client - curl, a mobile app, server-to-server", () => {
      expect(apiCsrfRejects(call("POST"), enforced)).toBe(false);
      expect(apiCsrfRejects(call("DELETE"), enforced)).toBe(false);
    });

    test("cookies that are not the token do not arm it", () => {
      // a session cookie alone is deliberately not enough: unlike a form post,
      // an api caller holding a session may well be a mobile app
      expect(apiCsrfRejects(call("POST", { cookie: "borgo_session=s; theme=dark" }), enforced)).toBe(false);
    });
  });

  // the check is a pure function and the wiring is one line: a pure function
  // nobody calls is the shape this whole defect had in the first place, and
  // `serve()` cannot be booted without a scaffolded app to boot it against
  test("the front server runs it on /api/*, before anything is proxied", () => {
    const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
    const branch = src.slice(src.indexOf('url.pathname.startsWith("/api/")'));
    const gate = branch.indexOf("apiCsrfRejects(req");
    const proxy = branch.indexOf("proxyRequest(req");
    expect(gate).toBeGreaterThan(-1);
    expect(proxy).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(proxy);
    // and the verdict is answered, not computed and dropped
    expect(branch.slice(gate, proxy)).toContain("status: 403");
  });

  describe("ambiguous cookies", () => {
    test("duplicates that disagree are no token, and the check still runs", () => {
      // the value reads as absent, exactly as everywhere else - but the cookie
      // is present, so an attacker who can toss a duplicate cannot switch the
      // check off by making the browser look token-less. that attacker is the
      // same sibling-subdomain one this check exists for.
      const cookie = `borgo_csrf=${TOKEN}; borgo_csrf=beefdeadfaceb000000011112222aaaa`;
      for (const echoed of [TOKEN, "beefdeadfaceb000000011112222aaaa", undefined]) {
        expect(apiCsrfRejects(call("POST", { cookie, token: echoed }), enforced)).toBe(true);
      }
    });

    test("a tossed empty duplicate poisons the token, not the check", () => {
      const req = call("POST", { cookie: `borgo_csrf=; borgo_csrf=${TOKEN}`, token: TOKEN });
      expect(apiCsrfRejects(req, enforced)).toBe(true);
    });

    test("identical duplicates are one token and still pass", () => {
      const req = call("POST", { cookie: `borgo_csrf=${TOKEN}; a=1; borgo_csrf=${TOKEN}`, token: TOKEN });
      expect(apiCsrfRejects(req, enforced)).toBe(false);
    });
  });
});

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
