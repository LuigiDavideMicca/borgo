import { describe, expect, test } from "bun:test";
import {
  createSecurity,
  decodeChanged,
  encodeChanged,
  envInt,
  escapeHtml,
  freshCookieHeader,
  hasCookie,
  HOP_BY_HOP,
  forwardableHeaders,
  headHtml,
  headResponse,
  metricsEnabled,
  PROXY_RETRY_MAX_BODY,
  pushAuthorized,
  readTimeout,
  READ_TIMEOUT_MAX,
  READ_TIMEOUT_SECONDS,
  createKeepWarm,
  keepWarmSeconds,
  KEEP_WARM_SECONDS,
  KEEP_WARM_INTERVAL_MS,
  WHEEL_MIN_ARMED_SECONDS,
  readTimeoutNotice,
  proxyRequest,
  requestFullyRead,
  scriptJson,
  shouldBufferBody,
  UNKNOWN_CHANGE,
  csrfEnabled,
  sessionSecure,
  cspSetting,
  devMode,
  reloadBanner,
  resolveSwitches,
  API_TIMEOUT_MS,
  MAX_BODY_BYTES,
  isForwarded,
  FORWARDING_HEADERS,
  topicRejection,
  wsOriginAllowed,
  decodeHtmlText,
  prepareShell,
  markUpstream,
  isUpstream,
} from "../src/util";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("freshCookieHeader", () => {
  const SESSION = "borgo_session";
  const valid = "eyJleHAiOjF9.realsig";
  const attacker = "eyJleHAiOjJ9.othersig";

  test("the plain case: a set-cookie replaces what the browser sent", () => {
    expect(freshCookieHeader("a=1; borgo_session=old", [`${SESSION}=new; Path=/; HttpOnly`])).toBe(
      "a=1; borgo_session=new",
    );
  });

  test("a logout clears the name instead of leaving the stale value", () => {
    expect(freshCookieHeader("a=1; borgo_session=old", [`${SESSION}=; Path=/; Max-Age=0`])).toBe("a=1");
    // go writes Max-Age=0 for ClearSession's MaxAge=-1, any attribute casing
    expect(freshCookieHeader("borgo_session=old", [`${SESSION}=; Path=/; MAX-AGE=0; HttpOnly`])).toBe("");
  });

  test("junk + valid duplicates are ambiguous: neither reaches the loader", () => {
    // last-wins used to hand go the junk alone, logging the victim out; go
    // itself skips the junk and would have kept the session, so neither
    // single winner is the answer - the pair is
    const jar = freshCookieHeader(`${SESSION}=${valid}; ${SESSION}=!!junk!!`, ["other=1"]);
    expect(jar).not.toContain(SESSION);
    expect(jar).toBe("other=1");
    const reversed = freshCookieHeader(`${SESSION}=!!junk!!; ${SESSION}=${valid}`, ["other=1"]);
    expect(reversed).toBe("other=1");
  });

  test("valid + valid is the session swap go refuses, so the jar refuses it too", () => {
    // cookie tossing: a sibling subdomain drops its own signed session in.
    // rebuilding last-wins would hand go one unambiguous cookie - the
    // attacker's - and the post-action page would render their account
    const jar = freshCookieHeader(`${SESSION}=${valid}; a=1; ${SESSION}=${attacker}`, ["a=2"]);
    expect(jar).not.toContain(valid);
    expect(jar).not.toContain(attacker);
    expect(jar).toBe("a=2");
  });

  test("identical duplicates are one cookie, not a conflict", () => {
    expect(freshCookieHeader(`${SESSION}=${valid}; ${SESSION}=${valid}`, ["a=1"])).toBe(
      `borgo_session=${valid}; a=1`,
    );
  });

  test("refreshed by the action: a set-cookie settles a name the browser made ambiguous", () => {
    // login through the tossed duplicates: go just issued this value, so it
    // is authoritative and the ambiguity is over
    expect(
      freshCookieHeader(`${SESSION}=${valid}; ${SESSION}=${attacker}`, [
        `${SESSION}=fresh.sig; Path=/; HttpOnly; SameSite=Lax`,
      ]),
    ).toBe("borgo_session=fresh.sig");
  });

  test("refreshed by the action: a logout clears an ambiguous name too", () => {
    expect(
      freshCookieHeader(`${SESSION}=${valid}; ${SESSION}=${attacker}; a=1`, [
        `${SESSION}=; Path=/; Max-Age=0`,
      ]),
    ).toBe("a=1");
  });

  test("ambiguity is per name: the rest of the jar still reaches the loader", () => {
    expect(
      freshCookieHeader(`a=1; ${SESSION}=${valid}; b=2; ${SESSION}=${attacker}; c=3`, ["d=4"]),
    ).toBe("a=1; b=2; c=3; d=4");
  });

  test("values keep their own = signs and the order of first appearance", () => {
    expect(freshCookieHeader("s=a=b=c; z=1", ["y=2"])).toBe("s=a=b=c; z=1; y=2");
  });

  test("no cookies in, only what the action set out", () => {
    expect(freshCookieHeader(null, [`${SESSION}=new; Path=/`])).toBe("borgo_session=new");
    expect(freshCookieHeader("", [`${SESSION}=new`])).toBe("borgo_session=new");
  });

  test("a set-cookie with no = is skipped rather than poisoning the jar", () => {
    expect(freshCookieHeader("a=1", ["garbage; Path=/"])).toBe("a=1");
  });

  test("everything cleared leaves an empty header, not a dangling separator", () => {
    expect(freshCookieHeader("borgo_session=old", [`${SESSION}=; Max-Age=0`])).toBe("");
  });
});

describe("hasCookie", () => {
  test("presence does not depend on the value being usable", () => {
    expect(hasCookie("borgo_csrf=tok", "borgo_csrf")).toBe(true);
    expect(hasCookie("a=1; borgo_csrf=; b=2", "borgo_csrf")).toBe(true);
    // the case the csrf gate turns on: two tossed duplicates read as no
    // token, and the browser must still be treated as one we issued to
    expect(hasCookie("borgo_csrf=aaa; borgo_csrf=bbb", "borgo_csrf")).toBe(true);
  });

  test("exact name match only", () => {
    expect(hasCookie("xborgo_csrf=1", "borgo_csrf")).toBe(false);
    expect(hasCookie("borgo_csrf_extra=1", "borgo_csrf")).toBe(false);
    expect(hasCookie("borgo_session=x", "borgo_csrf")).toBe(false);
  });

  test("missing, empty and malformed headers", () => {
    expect(hasCookie(null, "borgo_csrf")).toBe(false);
    expect(hasCookie("", "borgo_csrf")).toBe(false);
    expect(hasCookie("novalue", "novalue")).toBe(false);
  });
});

describe("scriptJson", () => {
  test("a closing script tag cannot end the block", () => {
    const out = scriptJson({ bio: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<");
    expect(JSON.parse(out)).toEqual({ bio: "</script><script>alert(1)</script>" });
  });

  test("an html comment opener cannot switch the parser into escaped state", () => {
    expect(scriptJson({ x: "<!--" })).toBe('{"x":"\\u003c!--"}');
  });

  test("u+2028 and u+2029 leave as escapes, not raw separators", () => {
    const out = scriptJson({ x: "a\u2028b\u2029c" });
    expect(out).toBe('{"x":"a\\u2028b\\u2029c"}');
    expect(JSON.parse(out)).toEqual({ x: "a\u2028b\u2029c" });
  });

  test("keys are escaped like values", () => {
    expect(scriptJson({ "</script>": 1 })).toBe('{"\\u003c/script>":1}');
  });
});

// A TIGHTENING MUST NEVER BECOME A DISABLING, and every variable envInt parses
// reads 0 as "no limit at all". Flooring `BORGO_API_TIMEOUT=0.5` did not shorten
// the deadline, it removed it - at 0 no AbortController is created at all - and
// the same floor took BORGO_MAX_BODY off. The tightest thing an operator can
// spell was the one value that turned the control off.
describe("envInt", () => {
  const NAME = "BORGO_API_TIMEOUT";

  test("unset and empty are undefined, so the caller's default is never invented here", () => {
    expect(envInt(NAME, undefined, "30000ms")).toBeUndefined();
    expect(envInt(NAME, "", "30000ms")).toBeUndefined();
  });

  test("a whole number wins, and zero is a value the operator can reach", () => {
    expect(envInt(NAME, "5000", "30000ms")).toBe(5000);
    expect(envInt(NAME, "0", "30000ms")).toBe(0);
    // unset and zero are two different answers, and this is the pair that
    // proves it: one disables the limit, the other asks for the default
    expect(envInt(NAME, "0", "30000ms")).not.toBeUndefined();
  });

  // THE ONE THAT USED TO TRUNCATE
  test("a fraction is refused by name, never rounded towards off", () => {
    for (const v of ["0.5", "0.001", "1.9", "0.9999", "1e-3"]) {
      expect(() => envInt(NAME, v, "30000ms")).toThrow(/BORGO_API_TIMEOUT/);
      expect(() => envInt(NAME, v, "30000ms")).toThrow(new RegExp(JSON.stringify(v).slice(1, -1)));
    }
    // and the message says what the truncation would have done, because that
    // is the part nobody would guess
    expect(() => envInt(NAME, "0.5", "30000ms")).toThrow(/switched off/);
  });

  test("garbage and negatives are refused, not silently turned into a default", () => {
    for (const v of ["banana", "-1", "Infinity", "NaN", "1_0", "1,5", " ", "5s", "1.0.0"]) {
      expect(() => envInt(NAME, v, "30000ms")).toThrow(/BORGO_API_TIMEOUT/);
    }
    // written down rather than discovered: the grammar is Number's, so the
    // spellings Number reads as a whole number are whole numbers here too
    expect(envInt(NAME, "0x10", "30000ms")).toBe(16);
    expect(envInt(NAME, "1e3", "30000ms")).toBe(1000);
    expect(envInt(NAME, " 42 ", "30000ms")).toBe(42);
    // the same refusal envText owns, reached through the same door
    expect(() => envInt(NAME, "30\r", "30000ms")).toThrow(/control character/);
  });

  test("negative zero is zero, spelled as zero", () => {
    for (const v of ["-0", "-0.0", "-.0", "-0e5", " -0 "]) {
      const n = envInt(NAME, v, "30000ms");
      expect(Object.is(n, -0)).toBe(false);
      expect(n).toBe(0);
    }
  });

  // the two variables this is actually for, through the function that resolves
  // them - a unit that is right while the switch it feeds is wrong is the bug
  // this whole file exists about
  test("the limits resolve through it, and a refusal names the variable", () => {
    expect(resolveSwitches({}).apiTimeout).toBe(API_TIMEOUT_MS);
    expect(resolveSwitches({}).maxBody).toBe(MAX_BODY_BYTES);
    expect(resolveSwitches({ BORGO_API_TIMEOUT: "0" }).apiTimeout).toBe(0);
    expect(resolveSwitches({ BORGO_MAX_BODY: "0" }).maxBody).toBe(0);
    expect(resolveSwitches({ BORGO_API_TIMEOUT: "1500" }).apiTimeout).toBe(1500);
    expect(() => resolveSwitches({ BORGO_API_TIMEOUT: "0.5" })).toThrow(/BORGO_API_TIMEOUT/);
    expect(() => resolveSwitches({ BORGO_MAX_BODY: "0.5" })).toThrow(/BORGO_MAX_BODY/);
  });

  // AND THE REFUSAL HAPPENS ABOVE THE TRY. Both were read inside serve(), which
  // serve-entry wraps in a catch that BINDS A PORT: a refused value would have
  // been answered from a listening socket with no security headers at all -
  // exactly what resolveSwitches was written to close for the six switches
  // before them.
  test("neither limit is read inside serve()", () => {
    const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
    expect(src).not.toContain("process.env.BORGO_API_TIMEOUT");
    expect(src).not.toContain("process.env.BORGO_MAX_BODY");
    expect(src).toContain("switches.apiTimeout");
    expect(src).toContain("switches.maxBody");
  });
});

describe("shouldBufferBody", () => {
  test("buffers small bodies of known size", () => {
    expect(shouldBufferBody("POST", "512")).toBe(true);
    expect(shouldBufferBody("PUT", "0")).toBe(true);
    expect(shouldBufferBody("DELETE", String(PROXY_RETRY_MAX_BODY))).toBe(true);
  });

  test("streams large bodies instead of holding them in memory", () => {
    expect(shouldBufferBody("POST", String(PROXY_RETRY_MAX_BODY + 1))).toBe(false);
    expect(shouldBufferBody("POST", String(500 * 1024 * 1024))).toBe(false);
  });

  test("streams when the size is unknown or garbage", () => {
    expect(shouldBufferBody("POST", null)).toBe(false);
    expect(shouldBufferBody("POST", "not-a-number")).toBe(false);
    expect(shouldBufferBody("POST", "-1")).toBe(false);
  });

  test("bodyless methods never buffer", () => {
    expect(shouldBufferBody("GET", "100")).toBe(false);
    expect(shouldBufferBody("HEAD", "100")).toBe(false);
  });

  test("a repeated content-length still buffers - and still retries", () => {
    // rfc 9112 §6.3: repeating the header with the same value is legal and
    // bun.serve accepts it; Headers joins the repeats, and Number("5, 5") is
    // NaN, so a tiny body used to lose its connection-refused retry
    expect(shouldBufferBody("POST", "5, 5")).toBe(true);
    expect(shouldBufferBody("POST", "512,512, 512")).toBe(true);
  });

  test("repeats that disagree are not a length at all", () => {
    expect(shouldBufferBody("POST", "5, 9")).toBe(false);
    expect(shouldBufferBody("POST", "5,")).toBe(false);
  });

  test("only digits are a length: Number() takes far more than that", () => {
    expect(shouldBufferBody("POST", "")).toBe(false);
    expect(shouldBufferBody("POST", "0x10")).toBe(false);
    expect(shouldBufferBody("POST", "1e3")).toBe(false);
    expect(shouldBufferBody("POST", "+5")).toBe(false);
    expect(shouldBufferBody("POST", "5.5")).toBe(false);
    // whitespace around a value is the header's, not part of the number
    expect(shouldBufferBody("POST", " 512 ")).toBe(true);
  });
});

describe("headHtml", () => {
  test("escapes the title, including a closing tag", () => {
    expect(headHtml({ title: "</title><script>alert(1)</script>" })).toBe(
      "<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>",
    );
  });

  test("escapes meta values so a quote cannot open an attribute", () => {
    expect(headHtml({ meta: [{ name: "d", content: '" onload="alert(1)' }] })).toBe(
      '<meta name="d" content="&quot; onload=&quot;alert(1)" data-borgo-head>',
    );
  });

  test("drops attribute names that are not plain names", () => {
    const html = headHtml({
      meta: [{ 'x" onload="alert(1)': "y", "a b": "c", name: "ok" }],
    });
    expect(html).toBe('<meta name="ok" data-borgo-head>');
  });

  test("drops event handler attributes even when well formed", () => {
    expect(headHtml({ meta: [{ onload: "alert(1)", ONERROR: "x", content: "keep" }] })).toBe(
      '<meta content="keep" data-borgo-head>',
    );
  });

  test("non-string values are stringified, not passed through", () => {
    const meta = [{ content: 5 as unknown as string }];
    expect(headHtml({ meta })).toBe('<meta content="5" data-borgo-head>');
  });

  test("an empty head renders nothing", () => {
    expect(headHtml({})).toBe("");
    expect(escapeHtml("a&b<c>d\"e")).toBe("a&amp;b&lt;c&gt;d&quot;e");
  });
});

describe("createSecurity", () => {
  const html = (init?: ResponseInit) =>
    new Response("<p>x</p>", { headers: { "Content-Type": "text/html; charset=utf-8" }, ...init });

  test("production documents get a nonce-carrying csp", () => {
    const security = createSecurity(false)!;
    expect(security.needsNonce).toBe(true);
    const csp = security.cspFor("abc123");
    expect(csp).toContain("script-src 'self' 'nonce-abc123'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("{nonce}");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  test("dev allows inline scripts instead of minting nonces", () => {
    const security = createSecurity(true)!;
    expect(security.needsNonce).toBe(false);
    const res = security.apply(html());
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "script-src 'self' 'unsafe-inline'",
    );
  });

  test("static headers land on every response, csp only on documents and svg", () => {
    const security = createSecurity(false)!;
    const doc = security.apply(html());
    expect(doc.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(doc.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(doc.headers.get("X-Frame-Options")).toBe("DENY");
    expect(doc.headers.get("Content-Security-Policy")).toContain("script-src 'self'");

    const svg = security.apply(
      new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
    );
    expect(svg.headers.get("Content-Security-Policy")).toContain("default-src 'self'");

    const asset = security.apply(
      new Response("body{}", { headers: { "Content-Type": "text/css" } }),
    );
    expect(asset.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(asset.headers.get("Content-Security-Policy")).toBeNull();
  });

  test("a csp already set by the render survives", () => {
    const security = createSecurity(false)!;
    const res = security.apply(
      new Response("<p>x</p>", {
        headers: { "Content-Type": "text/html", "Content-Security-Policy": "mine" },
      }),
    );
    expect(res.headers.get("Content-Security-Policy")).toBe("mine");
  });

  test("BORGO_SECURITY_HEADERS=0 disables everything", () => {
    expect(createSecurity(false, { headers: "0" })).toBeNull();
  });

  test("BORGO_CSP=0 keeps the static headers and drops the policy", () => {
    const security = createSecurity(false, { csp: "0" })!;
    expect(security.needsNonce).toBe(false);
    const res = security.apply(html());
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  test("a custom policy replaces the default and can take the nonce", () => {
    const security = createSecurity(false, { csp: "default-src 'self'; script-src 'self'{nonce}" })!;
    expect(security.needsNonce).toBe(true);
    expect(security.cspFor("n1")).toBe("default-src 'self'; script-src 'self' 'nonce-n1'");
    const plain = createSecurity(false, { csp: "default-src *" })!;
    expect(plain.needsNonce).toBe(false);
    expect(plain.apply(html()).headers.get("Content-Security-Policy")).toBe("default-src *");
  });
});

describe("forwardableHeaders", () => {
  test("the rfc 9110 hop-by-hop set never reaches the api", () => {
    const out = forwardableHeaders(
      new Headers({
        "connection": "keep-alive",
        "keep-alive": "timeout=5, max=1000",
        "te": "trailers",
        "trailer": "X-Checksum",
        "transfer-encoding": "chunked",
        "upgrade": "websocket",
        "proxy-authenticate": "Basic",
        "proxy-authorization": "Basic Zm9v",
        "proxy-connection": "keep-alive",
        "cookie": "borgo_session=abc",
        "content-type": "application/json",
      }),
    );
    for (const name of HOP_BY_HOP) expect(out.has(name)).toBe(false);
    // everything the app actually needs survives
    expect(out.get("cookie")).toBe("borgo_session=abc");
    expect(out.get("content-type")).toBe("application/json");
  });

  test("Connection names further headers as hop-scoped: they go too", () => {
    // otherwise `Connection: X-Api-Key` is a way for the client to strip
    // whatever the go api trusts, on a hop the client does not own
    const out = forwardableHeaders(
      new Headers({ connection: "keep-alive, X-Api-Key, X-Trace", "x-api-key": "k", "x-trace": "t", "x-keep": "y" }),
    );
    expect(out.has("x-api-key")).toBe(false);
    expect(out.has("x-trace")).toBe(false);
    expect(out.get("x-keep")).toBe("y");
  });

  test("a single-token Connection is still parsed - there is no comma to key on", () => {
    const out = forwardableHeaders(new Headers({ connection: "X-Secret", "x-secret": "leak", "x-keep": "y" }));
    expect(out.has("x-secret")).toBe(false);
    expect(out.get("x-keep")).toBe("y");
  });

  test("content-length stays: bun reframes the body and go still wants the length", () => {
    const out = forwardableHeaders(new Headers({ "content-length": "412", "transfer-encoding": "chunked" }));
    expect(out.get("content-length")).toBe("412");
    expect(out.has("transfer-encoding")).toBe(false);
  });

  test("the request's own headers are left alone", () => {
    const req = new Headers({ connection: "keep-alive", cookie: "a=1" });
    forwardableHeaders(req);
    expect(req.get("connection")).toBe("keep-alive");
  });

  // bun hands these through verbatim: `Connection: keep-alive,` arrives as
  // "keep-alive,". Headers.delete("") throws, and it throws before the proxy's
  // own try, so /api answered a rendered 500 document instead of proxying
  test("a Connection token that is not a field name is ignored, not thrown on", () => {
    for (const connection of ["keep-alive,", ",", ", ,", '"foo"', "@bad", "a b", "()", ";", "  "]) {
      const out = forwardableHeaders(new Headers({ connection, cookie: "a=1" }));
      expect(out.has("connection")).toBe(false);
      expect(out.get("cookie")).toBe("a=1");
    }
  });

  test("a junk token cannot shield a real one from the same list", () => {
    const out = forwardableHeaders(
      new Headers({ connection: '"junk", X-Api-Key, , keep-alive', "x-api-key": "k", "x-keep": "y" }),
    );
    expect(out.has("x-api-key")).toBe(false);
    expect(out.get("x-keep")).toBe("y");
  });
});

describe("headResponse", () => {
  // what bun puts on the wire is the only judge here: a Response object holds
  // no length of its own until it is served
  const served = async (method: string, make: () => Response) => {
    const server = Bun.serve({ port: 0, fetch: (req) => headResponse(req.method, make()) });
    const res = await fetch(`http://localhost:${server.port}/`, { method, decompress: false } as RequestInit);
    const bytes = (await res.arrayBuffer()).byteLength;
    server.stop(true);
    return { status: res.status, length: res.headers.get("content-length"), bytes, headers: res.headers };
  };

  const stream = (text: string) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      }),
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );

  test("a get is handed back untouched", async () => {
    const res = headResponse("GET", new Response("body"));
    expect(await res.text()).toBe("body");
  });

  test("a head keeps the status and headers, and ships no bytes", async () => {
    const head = await served("HEAD", () => new Response("not found", { status: 404, headers: { "X-Mark": "1" } }));
    expect(head.status).toBe(404);
    expect(head.bytes).toBe(0);
    expect(head.headers.get("X-Mark")).toBe("1");
  });

  test("a measured length survives the head - that is the point of measuring it", async () => {
    // the asset paths set this explicitly so a HEAD reports what a GET returns
    const get = await served("GET", () => new Response("0123456789", { headers: { "Content-Length": "10" } }));
    const head = await served("HEAD", () => new Response("0123456789", { headers: { "Content-Length": "10" } }));
    expect(get.length).toBe("10");
    expect(head.length).toBe("10");
    expect(head.bytes).toBe(0);
  });

  test("an unmeasured length is omitted, never answered as zero", async () => {
    // a null body would have bun frame the head as Content-Length: 0, and a
    // client would read "this resource is empty" off a document that is not
    for (const make of [
      () => stream("<html>a long document</html>"),
      () => Response.json({ status: "ok", uptime: 12.5 }),
      () => new Response("method not allowed", { status: 405 }),
    ]) {
      const get = await served("GET", make);
      const head = await served("HEAD", make);
      expect(head.bytes).toBe(0);
      expect(head.length).not.toBe("0");
      expect(head.length).toBeNull();
      expect(head.status).toBe(get.status);
      expect(Number(get.length ?? get.bytes)).toBeGreaterThan(0);
    }
  });

  test("the render behind a head is cancelled, not left pumping", async () => {
    let pulls = 0;
    let cancelled = false;
    const res = headResponse(
      "HEAD",
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulls++;
            c.enqueue(new Uint8Array(8));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    await Bun.sleep(5);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(1);
    expect(res.body).not.toBeNull();
  });

  test("a body-less response (204, 304) is passed straight through", async () => {
    for (const status of [204, 304]) {
      const res = new Response(null, { status, headers: { ETag: '"x"' } });
      expect(headResponse("HEAD", res)).toBe(res);
    }
  });
});

describe("metricsEnabled", () => {
  test("the prefixed name enables it", () => {
    expect(metricsEnabled({ BORGO_METRICS: "1" })).toBe(true);
  });

  test("unset means off", () => {
    expect(metricsEnabled({})).toBe(false);
  });

  // it tested === "1", so this used to be `only 1 counts` and asserted that
  // "true" was off: the operator who spelled the switch the way go spells it
  // got a 404 on the endpoint they had just enabled, and nothing said so. The
  // spellings that are NOT boolean go on being off - by refusing, now, since
  // "yes" is an intent nobody can read either way.
  test("=true enables it, exactly as =1 does", () => {
    expect(metricsEnabled({ BORGO_METRICS: "true" })).toBe(true);
    expect(metricsEnabled({ BORGO_METRICS: "0" })).toBe(false);
    expect(metricsEnabled({ BORGO_METRICS: "false" })).toBe(false);
    for (const value of ["yes", " 1", "2"]) {
      expect(() => metricsEnabled({ BORGO_METRICS: value })).toThrow(/BORGO_METRICS/);
    }
  });

  // the rename exists so a neighbouring process can want METRICS=1 for its own
  // reasons without switching borgo's /metrics on. Honouring the old name as an
  // alias would keep alive exactly the collision the prefix was added to end.
  test("the pre-0.21 name is not honoured", () => {
    expect(metricsEnabled({ METRICS: "1" })).toBe(false);
    expect(metricsEnabled({ BORGO_METRICS: "", METRICS: "1" })).toBe(false);
  });
});

// TWO CLOCKS, NOT ONE.
//
// borgo first ran the front server with idleTimeout: 0, on the strength of a
// comment about proxied SSE responses, which left the internet-facing server
// with no read deadline at all. The fix for that fused the two clocks instead
// of separating them: it turned the deadline back on and exempted responses
// whose Content-Type matched an allowlist of text/event-stream and
// multipart/x-mixed-replace, after the handler had already resolved. Measured
// with idleTimeout=3 and a stream idle 8s mid-body, that truncated every
// long-lived response that is not SSE - application/x-ndjson was cancelled
// server-side at ~3s and the connection closed at 4.0s, and the client saw a
// TRUNCATED 200, not an error - and it granted the exemption too late for an
// upstream slower than the deadline, which closed at 4.0s having delivered
// nothing.
//
// The deadline bounds the REQUEST. The response has no bound. bun has one knob
// for both, so the knob is the request clock and the response clock is that
// knob lifted, at the one moment the request can no longer be dribbled at us.
describe("the read deadline: how long a REQUEST may take to arrive", () => {
  test("defaults to a real number of seconds, not to none", () => {
    expect(readTimeout({})).toBe(READ_TIMEOUT_SECONDS);
    expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: "" })).toBe(READ_TIMEOUT_SECONDS);
    expect(READ_TIMEOUT_SECONDS).toBeGreaterThan(0);
    // garbage must not silently disable it
    expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: "soon" })).toBe(READ_TIMEOUT_SECONDS);
    expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: "-5" })).toBe(READ_TIMEOUT_SECONDS);
  });

  test("BORGO_FRONT_READ_TIMEOUT overrides it, and bun's ceiling is respected", () => {
    expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: "5" })).toBe(5);
    // an explicit 0 is a deliberate opt-out and stays honoured
    expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: "0" })).toBe(0);
    // bun rejects anything above 255 outright, which would take the server down
    expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: "3600" })).toBe(READ_TIMEOUT_MAX);
    expect(READ_TIMEOUT_MAX).toBe(255);
  });

  // ONE NAME MUST NOT MEAN TWO THINGS.
  //
  // This started as BORGO_IDLE_TIMEOUT, which is the go api's: go parses it with
  // time.ParseDuration and PANICS on anything else. The systemd unit and the
  // compose file put both processes in one environment block, so one name meant
  // two things at once - BORGO_IDLE_TIMEOUT=2m gave go two minutes and gave this
  // side a silent 30 seconds, and BORGO_IDLE_TIMEOUT=120 panicked the go api at
  // boot.
  //
  // The first fix renamed this side's knob to BORGO_READ_TIMEOUT - which
  // newServer in borgo.go also reads, also as a duration, also panicking. The
  // rename moved the collision onto a new spelling and the test written with it
  // asserted the move was a fix ("one env block carrying both gives each side
  // what it asked for", on an env whose BORGO_READ_TIMEOUT=45 stops the go
  // binary from booting at all). It is rewritten here, because it certified the
  // bug.
  //
  // Neither old name is honoured as an alias: an alias keeps the collision alive.
  test("no name the go api parses is this side's variable", () => {
    for (const name of ["BORGO_IDLE_TIMEOUT", "BORGO_READ_TIMEOUT"]) {
      // go's own grammar; none of these is a number of seconds to this side
      expect(readTimeout({ [name]: "2m" })).toBe(READ_TIMEOUT_SECONDS);
      expect(readTimeout({ [name]: "120" })).toBe(READ_TIMEOUT_SECONDS);
      expect(readTimeout({ [name]: "0" })).toBe(READ_TIMEOUT_SECONDS);
    }
    // and one env block carrying all three gives each side what it asked for
    expect(
      readTimeout({
        BORGO_IDLE_TIMEOUT: "2m",
        BORGO_READ_TIMEOUT: "45s",
        BORGO_FRONT_READ_TIMEOUT: "45",
      }),
    ).toBe(45);
  });

  test("the front server reads the name it owns, and no other", () => {
    const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
    expect(src).toContain("readTimeout(process.env)");
    expect(src).not.toContain("BORGO_IDLE_TIMEOUT");
  });

  // The structural guard, so the next rename cannot recreate what two renames
  // already created. Go reads its timeouts through envDuration (a duration
  // string, malformed panics at boot); the front server reads its own through
  // envInt (a plain number, malformed silently falls back). A name in both sets
  // is a value that cannot mean the same thing to both halves, and `borgo start`
  // hands one environment to both children.
  test("envNamesDoNotCollide: no variable is read as a duration AND as a number", () => {
    const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");
    const names = (src: string, re: RegExp) => new Set([...src.matchAll(re)].map((m) => m[1]));

    const goDurations = names(read("../../../borgo.go"), /envDuration\("(\w+)"/g);
    const frontInts = new Set([
      ...names(read("../src/server.ts"), /envInt\("(\w+)"/g),
      ...names(read("../src/util.ts"), /envInt\("(\w+)"/g),
    ]);

    // the regexes have to be finding something, or this passes by reading nothing
    expect(goDurations.has("BORGO_IDLE_TIMEOUT")).toBe(true);
    expect(goDurations.has("BORGO_READ_TIMEOUT")).toBe(true);
    expect(frontInts.has("BORGO_FRONT_READ_TIMEOUT")).toBe(true);

    expect([...frontInts].filter((name) => goDurations.has(name))).toEqual([]);
  });
});

// THE RESPONSE CLOCK: KEEPING A SOCKET WARM WITHOUT DISARMING THE GUARD.
//
// This block replaces one that promised four properties in its comment and
// asserted three, with three independent `fetch()` calls: it never reused a
// connection and never watched one go idle, so the fourth - "the lift does not
// leak to the next request on the same keep-alive connection" - was the only
// one no assertion covered, and it was the one that was false. `fetch()` cannot
// see it: the property is about what happens when there IS no next request.
// Everything below drives raw sockets, holds them open, and reads a clock.
//
// It then replaced a ceiling, which a verifier falsified on the same axis: the
// value a connection is left with is inherited by the next UNFINISHED request
// on it, so one complete GET bought a slowloris the ceiling. Every socket case
// here therefore names the env value it ran at, and the ones that matter run at
// both 8 and 30 - never at 3, where a single-sweep deadline cannot be re-armed
// at all and every number lies.
describe("the response clock: keeping a socket warm", () => {
  // ---- the predicate, on its own ----
  // bun rewrites `req.body` to null for GET and HEAD whatever the client
  // declared, so "in hand" cannot rest on that alone. Enumerated in the
  // directions that produced the bug: absent, empty, duplicated, malformed,
  // differently cased - and a header that is simply never sent.
  const withHeaders = (h: Record<string, string>) => new Request("http://app.test/", { headers: h });

  test("no body and nothing declared is entirely in hand", () => {
    expect(requestFullyRead(new Request("http://app.test/"))).toBe(true);
    expect(requestFullyRead(new Request("http://app.test/", { method: "HEAD" }))).toBe(true);
    // a POST without one is too: nothing is coming
    expect(requestFullyRead(new Request("http://app.test/", { method: "POST" }))).toBe(true);
    // an explicit zero is a client saying the same thing out loud
    for (const v of ["0", "00", " 0 "]) expect(requestFullyRead(withHeaders({ "Content-Length": v }))).toBe(true);
  });

  test("a request still carrying a body is not, and keeps the deadline", () => {
    const post = new Request("http://app.test/", { method: "POST", body: "x=1" });
    expect(requestFullyRead(post)).toBe(false);
  });

  test("a declared body is a body, however it is spelled", () => {
    // the shape that broke it: bun hands this one a null body anyway
    expect(requestFullyRead(withHeaders({ "Content-Length": "100" }))).toBe(false);
    // duplicated - bun joins a repeated header with a comma and passes it
    // through (a pair that disagrees it rejects before fetch is called)
    expect(requestFullyRead(withHeaders({ "Content-Length": "100, 100" }))).toBe(false);
    expect(requestFullyRead(withHeaders({ "Content-Length": "0, 0" }))).toBe(false);
    // empty and malformed fail closed rather than parsing to nothing
    for (const v of ["", " ", "abc", "+100", "-1", "1e2", "0x0", "1_0"]) {
      expect(requestFullyRead(withHeaders({ "Content-Length": v }))).toBe(false);
    }
    // any transfer-encoding at all, any casing, means a body framed by
    // something other than a length this side can check
    for (const v of ["chunked", "CHUNKED", "Chunked", "identity", "gzip, chunked", ""]) {
      expect(requestFullyRead(withHeaders({ "Transfer-Encoding": v }))).toBe(false);
    }
    expect(requestFullyRead(withHeaders({ "transfer-encoding": "chunked" }))).toBe(false);
  });

  // ---- the value ----
  // A TIGHTENING MUST NEVER BECOME A DISABLING. envInt floors, so `=0.5` asked
  // for the strictest setting and got the documented "off" (measured: a dribbled
  // body at 0.5 still connected at 45s, against 8.00s at 8).
  test("a value below a whole second is one second, never off", () => {
    for (const v of ["0.001", "0.5", "0.9"]) {
      expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: v })).toBe(1);
    }
    // only a literal zero disables
    expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: "0" })).toBe(0);
    // and nothing else changed: unset, empty and unreadable still fall back
    expect(readTimeout({})).toBe(READ_TIMEOUT_SECONDS);
    expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: "" })).toBe(READ_TIMEOUT_SECONDS);
    for (const v of ["abc", "-1", "-0.5", "NaN", "Infinity"]) {
      expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: v })).toBe(READ_TIMEOUT_SECONDS);
    }
    expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: "8" })).toBe(8);
    expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: "300" })).toBe(READ_TIMEOUT_MAX);
  });

  // AND EVERY OTHER VALUE IS HONOURED EXACTLY. A revision clamped 1-4 up to 5 on
  // the theory that bun cannot re-arm below that. It can - it just cannot re-arm
  // the NUMBER 4, whoever arms it - and the clamp routed every tight setting onto
  // the configuration with the least margin against a stalled event loop.
  test("a tight slowloris bound is the operator's to set", () => {
    for (const v of ["1", "2", "3", "4", "5", "6", "7"]) {
      expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: v })).toBe(Number(v));
    }
  });

  // NEGATIVE ZERO CRASHES Bun.serve AND NO `===` ASSERTION CAN SEE IT.
  // `-0 === 0` and `Number.isInteger(-0)` are both true, so a unit guard written
  // the ordinary way reports a configuration that cannot boot as perfectly
  // consistent. Object.is is the only operator that tells the zeroes apart.
  test("negative zero never reaches Bun.serve", () => {
    for (const v of ["-0", "-0.0", "-.0", "-0e5", " -0 ", "-0.00"]) {
      const t = readTimeout({ BORGO_FRONT_READ_TIMEOUT: v });
      expect(Object.is(t, -0)).toBe(false);
      expect(Object.is(t, 0)).toBe(true);
    }
    // the assertion that actually caught it: bun's own argument check. A pure
    // unit test cannot fail on -0, so this one hands the value to the thing that
    // rejects it - `TypeError: Bun.serve expects idleTimeout to be an integer`.
    for (const v of ["-0", "-0.0", "-.0", "-0e5", " -0 ", "0", "1", "0.5", "8", "30", "255", "300", "abc", ""]) {
      const idleTimeout = readTimeout({ BORGO_FRONT_READ_TIMEOUT: v });
      const server = Bun.serve({ port: 0, idleTimeout, development: false, fetch: () => new Response("ok") });
      server.stop(true);
    }
  });

  // THE TWO CLOCKS ARE NOT THE SAME NUMBER, and coupling them is how the last
  // two revisions broke. The operator's knob bounds a client that has not
  // finished sending; the keep-warm only ever applies to a request already fully
  // received, and bounds how long the server may be quiet while answering.
  test("theTwoClocksAreNotTheSameNumber", () => {
    const settings = ["1", "2", "3", "4", "5", "6", "8", "12", "13", "30", "0.5", "255", "abc", ""];
    const warm = settings.map((v) => keepWarmSeconds({ BORGO_FRONT_READ_TIMEOUT: v }));
    // one value, whatever the operator asked for - no minimum, no maximum, no
    // funnel onto a worst case
    expect(new Set(warm)).toEqual(new Set([KEEP_WARM_SECONDS]));
    expect(keepWarmSeconds({})).toBe(KEEP_WARM_SECONDS);
    // it is above the wheel's dead zone by a real margin, not by one second: the
    // sweep is a JS timer and runs late when the loop is busy, and a connection
    // survives a stall only on the armed time it is already carrying
    expect(KEEP_WARM_SECONDS).toBeGreaterThan(WHEEL_MIN_ARMED_SECONDS * 2);
    // and never above bun's own bound on an incomplete request, or the leftover
    // would hand the next unfinished request more than a fresh socket gets
    expect(KEEP_WARM_SECONDS).toBe(12);
    // the sweep has to come round several times inside one armed window
    expect(KEEP_WARM_SECONDS * 1000).toBeGreaterThan(KEEP_WARM_INTERVAL_MS * 4);
  });

  // A value borgo moved silently is a unit file that lies to the next operator.
  test("and the operator is told, exactly when the value moved", () => {
    for (const v of ["0.5", "0.001", "0.9"]) {
      const notice = readTimeoutNotice({ BORGO_FRONT_READ_TIMEOUT: v });
      expect(notice).toContain(`BORGO_FRONT_READ_TIMEOUT=${v}`);
      // it has to say WHY, or it reads as noise and gets suppressed
      expect(notice).toMatch(/deadline|second/i);
    }
    // silent whenever the value was honoured verbatim, including every setting
    // an earlier revision used to move
    for (const v of ["1", "2", "3", "4", "5", "8", "30", "0", "", "abc", "-1", "-0"]) {
      expect(readTimeoutNotice({ BORGO_FRONT_READ_TIMEOUT: v })).toBeNull();
    }
    expect(readTimeoutNotice({})).toBeNull();
  });

  // THE INVARIANT THAT KEEPS THE KEEP-WARM REACHABLE. A revision let
  // keepWarmSeconds return 0 below a floor, so BORGO_FRONT_READ_TIMEOUT anywhere
  // in that range left it inert and every silent stream truncated - a P2
  // violation reachable from a config file, with nothing saying so. Off may only
  // ever mean "the operator asked for no deadline at all".
  test("keepWarmIsOffOnlyWhenTheDeadlineIs", () => {
    const values = [
      undefined, "", "0", "-0", "-0.0", "-.0", "-0e5", " -0 ", "0.001", "0.5",
      "0.9", "1", "2", "3", "4", "4.9", "5", "6", "7", "8", "12", "13", "29",
      "30", "31", "254", "255", "256", "1000", "abc", "-1", "NaN", "Infinity",
      " 8 ", "8.7",
    ];
    for (const v of values) {
      const env = v === undefined ? {} : { BORGO_FRONT_READ_TIMEOUT: v };
      const read = readTimeout(env);
      const warm = keepWarmSeconds(env);
      expect(warm === 0).toBe(read === 0);
      // `===` cannot tell -0 from 0, and -0 is the value that will not boot
      expect(Object.is(read, -0)).toBe(false);
      expect(Number.isInteger(read)).toBe(true);
      // whenever there IS a deadline, the keep-warm can actually re-arm it
      if (read !== 0) expect(warm).toBeGreaterThanOrEqual(WHEEL_MIN_ARMED_SECONDS);
    }
  });

  // ---- the sweep, against a counting fake ----
  test("a request that ended before its first sweep is never touched", async () => {
    const calls: Array<[string, number]> = [];
    let alive = true;
    const req = new Request("http://app.test/gone");
    const warm = createKeepWarm(
      () => ({
        timeout: (r, s) => calls.push([new URL(r.url).pathname, s]),
        requestIP: () => (alive ? { address: "127.0.0.1" } : null),
      }),
      8,
      15,
    );
    alive = false; // bun is already done with it
    warm.hold(req);
    await Bun.sleep(120);
    warm.stop();
    // evicted, and the deadline never touched: this is what makes ordinary
    // traffic identical to a server that calls nothing
    expect(calls).toEqual([]);
    expect(warm.held()).toBe(0);
  });

  test("a live exchange is re-armed every sweep, always at the same value", async () => {
    const calls: number[] = [];
    let alive = true;
    const warm = createKeepWarm(
      () => ({ timeout: (_r, s) => calls.push(s), requestIP: () => (alive ? { address: "::1" } : null) }),
      8,
      15,
    );
    warm.hold(new Request("http://app.test/stream"));
    await Bun.sleep(120);
    expect(calls.length).toBeGreaterThan(2);
    // never raised, never varied - the value is the whole of the bound
    expect(new Set(calls)).toEqual(new Set([8]));
    // and it stops the moment bun is done, leaving that value behind
    alive = false;
    const before = calls.length;
    await Bun.sleep(120);
    warm.stop();
    expect(calls.length).toBe(before);
    expect(warm.held()).toBe(0);
  });

  test("with no deadline to keep warm against it is inert", async () => {
    let touched = 0;
    for (const seconds of [0, -1]) {
      const warm = createKeepWarm(
        () => ({ timeout: () => touched++, requestIP: () => ({ address: "::1" }) }),
        seconds,
        15,
      );
      warm.hold(new Request("http://app.test/"));
      await Bun.sleep(60);
      expect(warm.held()).toBe(0);
      warm.stop();
    }
    expect(touched).toBe(0);
  });

  // ---- V1, at the unit that turns it on ----
  // onBodyRead used to fire for a BUFFERED body only, so a chunked POST - or
  // anything over PROXY_RETRY_MAX_BODY - carried clock 1 for the whole life of
  // its response, and any SSE or NDJSON answer to one was silently truncated.
  test("a streamed request body reports its end too, and only at its end", async () => {
    const fired: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(new TextEncoder().encode("first"));
        await gate;
        c.enqueue(new TextEncoder().encode("last"));
        c.close();
      },
    });
    const req = new Request("http://app.test/api/upload", { method: "POST", body });
    // no content-length: unbuffered, the path that never reported anything
    expect(shouldBufferBody("POST", req.headers.get("content-length"))).toBe(false);

    const proxied = proxyRequest(req, {
      target: "http://upstream.test/api/upload",
      deadlineMs: 0,
      retries: 0,
      maxBody: 0,
      onBodyRead: () => fired.push("body"),
      fetchImpl: async (_url, init) => {
        await new Response((init as { body?: BodyInit }).body ?? null).arrayBuffer();
        return new Response("ok");
      },
    });
    await Bun.sleep(50);
    // the first chunk is not the last one
    expect(fired).toEqual([]);
    release();
    await proxied;
    expect(fired).toEqual(["body"]);
  });

  // ---- the mutation guard ----
  test("the front server never touches the deadline itself", () => {
    const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
    // comments out: the argument for the keep-warm has to be able to quote the
    // calls it replaced without the guard reading a quote as a call
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    // AbortSignal.timeout is a different thing entirely; this is about the one
    // call that can weaken a connection's deadline
    expect(code).not.toMatch(/server\.timeout\(/);
    expect(code).toContain("keepWarm.hold(req)");
    expect(code).toContain("createKeepWarm(() => server, keepWarmSeconds(process.env))");
    // a value borgo moved has to reach the operator, so the notice is wired in
    expect(code).toContain("readTimeoutNotice(process.env)");
    // built before Bun.serve, or a request arriving in the gap hits a dead zone
    expect(code.indexOf("createKeepWarm(")).toBeLessThan(code.indexOf("Bun.serve<"));
  });

  // ================= real sockets, real servers =================
  const enc = new TextEncoder();

  type Run = { closedAt: number | null; seen: string };

  function raw(
    port: number,
    write: string,
    cap: number,
    after?: (s: { write: (d: string) => void }) => () => void,
  ): Promise<Run> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let seen = "";
      let done = false;
      let stop: (() => void) | undefined;
      let sock: { end: () => void } | undefined;
      const fin = (closedAt: number | null) => {
        if (done) return;
        done = true;
        stop?.();
        resolve({ closedAt, seen });
      };
      void Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(s) {
            sock = s;
            s.write(write);
            stop = after?.(s);
          },
          data: (_s, d) => {
            seen += new TextDecoder().decode(d);
          },
          close: () => fin(Date.now() - t0),
          error: () => fin(Date.now() - t0),
        },
      }).catch(() => fin(Date.now() - t0));
      // resolve before closing, so the verdict is the timer's and not the close
      // event the timer itself provokes
      setTimeout(() => {
        fin(null);
        try {
          sock?.end();
        } catch {}
      }, cap);
    });
  }

  const KEEPALIVE = "Host: localhost\r\nConnection: keep-alive\r\n\r\n";
  const ok200 = (r: Run) => (r.seen.match(/HTTP\/1\.1 200/g) ?? []).length;
  // a request line and headers that never reach the terminating blank line
  const dribbleHeaders = (s: { write: (d: string) => void }) => {
    s.write("GET /never HTTP/1.1\r\nHost: localhost\r\n");
    let n = 0;
    const t = setInterval(() => {
      try {
        s.write(`X-Pad-${++n}: 1\r\n`);
      } catch {
        clearInterval(t);
      }
    }, 2_000);
    return () => clearInterval(t);
  };

  // a server wired exactly as serve() wires one, at a stated env value
  function warmServer(env: string, handler?: (req: Request) => Response | Promise<Response>) {
    const seen: Record<string, boolean> = {};
    let warm!: ReturnType<typeof createKeepWarm>;
    const server = Bun.serve({
      port: 0,
      idleTimeout: readTimeout({ BORGO_FRONT_READ_TIMEOUT: env }),
      development: false,
      async fetch(req) {
        if (requestFullyRead(req)) warm.hold(req);
        seen[new URL(req.url).pathname] = req.body === null;
        if (handler) return handler(req);
        if (req.body !== null) {
          // a body borgo would read (an action, a proxied post) is read here
          // too, or bun answers a slowloris 200 before it has sent anything
          try {
            await req.text();
          } catch {
            return new Response(null, { status: 499 });
          }
        }
        return new Response("ok");
      },
    });
    warm = createKeepWarm(() => server, keepWarmSeconds({ BORGO_FRONT_READ_TIMEOUT: env }));
    return { server, warm, seen, port: server.port! };
  }

  // Everything that must be CUT or RECLAIMED, at 8 and at 30, all at once.
  // The two env values matter: at 8 bun's own 12s bound on an incomplete
  // request is the looser of the two, at 30 the knob is.
  test("nothing on the connection is loosened, at 8 and at 30", async () => {
    const a = warmServer("8");
    const b = warmServer("30");
    try {
      const [idle8, post8, declared8, afterGet8, busy8, idle30, afterGet30] = await Promise.all([
        // 1. THE ONE THE LIFT BROKE. One complete GET, the 200 read, then
        // silence on a connection the client keeps open.
        raw(a.port, `GET /idle HTTP/1.1\r\n${KEEPALIVE}`, 40_000),
        // 2. a POST that promises 1000 bytes, sends one, and stops
        raw(a.port, "POST /post HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\nx", 40_000),
        // 3. a GET declaring a length it never fills. bun discards bodies on
        // GET, so this arrives with body === null and the old predicate called
        // it entirely in hand
        raw(a.port, "GET /declared HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx", 40_000),
        // 4. THE ONE THE CEILING BROKE. One complete GET, then an unfinished
        // request dribbled forever. bun re-arms on request COMPLETION, so
        // whatever the previous exchange left on the connection is what this
        // one gets.
        raw(a.port, `GET /healthz HTTP/1.1\r\n${KEEPALIVE}`, 40_000, dribbleHeaders),
        // 5. a connection working steadily must not be penalised for it
        raw(a.port, `GET /busy0 HTTP/1.1\r\n${KEEPALIVE}`, 18_000, (s) => {
          let n = 0;
          const t = setInterval(() => {
            try {
              s.write(`GET /busy${++n} HTTP/1.1\r\n${KEEPALIVE}`);
            } catch {
              clearInterval(t);
            }
          }, 2_000);
          return () => clearInterval(t);
        }),
        raw(b.port, `GET /idle HTTP/1.1\r\n${KEEPALIVE}`, 40_000),
        raw(b.port, `GET /healthz HTTP/1.1\r\n${KEEPALIVE}`, 40_000, dribbleHeaders),
      ]);

      // BORGO_FRONT_READ_TIMEOUT=8: bun untouched closes an idle connection at
      // 8.02s and an incomplete request after a completed one at 8.02s. A
      // request that ended before its first sweep is never touched, so both
      // land where they land on a server that calls nothing.
      expect(ok200(idle8)).toBe(1);
      expect(idle8.closedAt).not.toBeNull();
      expect(idle8.closedAt!).toBeLessThan(14_000);
      expect(ok200(afterGet8)).toBe(1);
      expect(afterGet8.closedAt).not.toBeNull();
      expect(afterGet8.closedAt!).toBeLessThan(14_000);

      // BORGO_FRONT_READ_TIMEOUT=30: untouched, both close at 32.06s. The
      // ceiling this replaced made the second of these 256.4s.
      expect(idle30.closedAt).not.toBeNull();
      expect(idle30.closedAt!).toBeLessThan(38_000);
      expect(ok200(afterGet30)).toBe(1);
      expect(afterGet30.closedAt).not.toBeNull();
      expect(afterGet30.closedAt!).toBeLessThan(38_000);

      // still arriving, still cut. (A client that keeps DRIBBLING re-arms an
      // idle timer by definition - what this clock bounds is silence, and a
      // request that stopped arriving is silence.)
      expect(post8.closedAt).not.toBeNull();
      expect(post8.closedAt!).toBeLessThan(14_000);
      expect(ok200(post8)).toBe(0);
      // the forged GET IS answered - that is exactly why the old predicate
      // looked right - and the connection is cut anyway
      expect(ok200(declared8)).toBe(1);
      expect(declared8.closedAt).not.toBeNull();
      expect(declared8.closedAt!).toBeLessThan(14_000);
      // the measurement the header check exists for: bun hands this one a null
      // body, so `req.body === null` could never have told it from /idle
      expect(a.seen["/declared"]).toBe(true);
      expect(a.seen["/idle"]).toBe(true);

      // back-to-back on one connection: still serving at 18s, nine requests in
      expect(busy8.closedAt).toBeNull();
      expect(ok200(busy8)).toBeGreaterThanOrEqual(8);
    } finally {
      a.warm.stop();
      b.warm.stop();
      a.server.stop(true);
      b.server.stop(true);
    }
  }, 60_000);

  // The direction this fails in if it is wrong: a live response is cut and the
  // client sees a truncated 200, which is indistinguishable from a whole one.
  // Both cases run at BORGO_FRONT_READ_TIMEOUT=8 with a silence of 20s - more
  // than twice the deadline, and past bun's own 12s bound as well.
  test("a response silent far longer than the deadline is not truncated", async () => {
    const SILENCE_MS = 20_000;
    const slowStream = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            // NOT text/event-stream: the Content-Type allowlist that used to
            // grant the exemption would truncate this one at the deadline
            c.enqueue(enc.encode('{"n":1}\n'));
            setTimeout(() => {
              try {
                c.enqueue(enc.encode('{"n":2}\n'));
                c.close();
              } catch {}
            }, SILENCE_MS);
          },
        }),
        { headers: { "Content-Type": "application/x-ndjson" } },
      );

    // the plain case, and V1: the same stream answering a CHUNKED post, whose
    // body the proxy streams through rather than buffering. onBodyRead used to
    // stay silent for that shape and the answer was cut at the deadline.
    const a = warmServer("8", (req) => {
      if (req.method !== "POST") return slowStream();
      return proxyRequest(req, {
        target: "http://upstream.test/api/feed",
        deadlineMs: 0,
        retries: 0,
        maxBody: 0,
        onBodyRead: () => a.warm.hold(req),
        fetchImpl: async (_url, init) => {
          await new Response((init as { body?: BodyInit }).body ?? null).arrayBuffer();
          return slowStream();
        },
      });
    });
    // AND AT THE TIGHT SETTINGS, which is where both previous revisions broke.
    // At 5 the first left the keep-warm inert and truncated this stream behind a
    // 200 that had already shipped; the second clamped everything below 5 onto
    // 5, the setting with the least margin. Both values are now honoured
    // verbatim and both streams survive, because the keep-warm arms its own
    // number - 3 is inside the wheel's dead zone and the stream lives anyway.
    const five = warmServer("5", () => slowStream());
    const three = warmServer("3", () => slowStream());
    expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: "5" })).toBe(5);
    expect(readTimeout({ BORGO_FRONT_READ_TIMEOUT: "3" })).toBe(3);
    expect(WHEEL_MIN_ARMED_SECONDS).toBeGreaterThan(3);
    try {
      const [plain, chunked, atFive, atThree] = await Promise.all([
        raw(a.port, `GET /ndjson HTTP/1.1\r\n${KEEPALIVE}`, 32_000),
        raw(
          a.port,
          "POST /api/feed HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n" +
            "5\r\nhello\r\n0\r\n\r\n",
          32_000,
        ),
        raw(five.port, `GET /sse HTTP/1.1\r\n${KEEPALIVE}`, 32_000),
        raw(three.port, `GET /sse HTTP/1.1\r\n${KEEPALIVE}`, 32_000),
      ]);
      // both records - a truncated 200 would carry only the first
      expect(plain.seen).toContain('{"n":1}');
      expect(plain.seen).toContain('{"n":2}');
      expect(chunked.seen).toContain('{"n":1}');
      expect(chunked.seen).toContain('{"n":2}');
      // the 200 arriving is exactly what made the old failure invisible, so the
      // assertion is on the terminator, not on the status line
      expect(atFive.seen).toContain("200 OK");
      expect(atFive.seen).toContain('{"n":1}');
      expect(atFive.seen).toContain('{"n":2}');
      expect(atThree.seen).toContain("200 OK");
      expect(atThree.seen).toContain('{"n":1}');
      expect(atThree.seen).toContain('{"n":2}');
    } finally {
      for (const s of [a, five, three]) {
        s.warm.stop();
        s.server.stop(true);
      }
    }
  }, 60_000);
});

// two saves inside one 100 ms debounce window are one rebuild, and the browser
// has to be told about both files: it ignores an update naming a page other
// than the one on screen, so a single-file message could silently apply
// nothing at all.
describe("the changed-file list a rebuild carries", () => {
  test("survives the round trip through the environment", () => {
    const files = ["pages/index.tsx", "pages/about.tsx", "components/Nav.tsx"];
    expect(decodeChanged(encodeChanged(files))).toEqual(files);
  });

  test("a newline separates them, because a path may hold anything else", () => {
    // a comma or a space in a filename is legal on every platform borgo runs on
    const files = ["pages/my page, v2.tsx", "pages/a b.tsx"];
    expect(decodeChanged(encodeChanged(files))).toEqual(files);
  });

  test("no rebuild, no files", () => {
    expect(decodeChanged(undefined)).toEqual([]);
    expect(decodeChanged("")).toEqual([]);
    expect(encodeChanged([])).toBe("");
    expect(decodeChanged(encodeChanged([]))).toEqual([]);
  });

  test("the lost-events sentinel travels like any other entry", () => {
    expect(decodeChanged(encodeChanged([UNKNOWN_CHANGE]))).toEqual([UNKNOWN_CHANGE]);
    // and is not a module, so the client reloads rather than trying to refresh
    expect(UNKNOWN_CHANGE).not.toMatch(/\.tsx?$/);
  });
});

// SESSION_SECURE decides Secure on both the session cookie (go) and the csrf
// cookie (here). One variable, one intent: if the two halves disagree about
// what it says, one cookie downgrades in silence. Go parses it with
// strconv.ParseBool, so this grammar has to be the same one.
describe("sessionSecure", () => {
  test("accepts everything go's ParseBool accepts, both ways", () => {
    for (const v of ["1", "t", "T", "true", "TRUE", "True"]) {
      expect(sessionSecure({ SESSION_SECURE: v })).toBe(true);
    }
    for (const v of ["0", "f", "F", "false", "FALSE", "False"]) {
      expect(sessionSecure({ SESSION_SECURE: v })).toBe(false);
    }
  });

  test("unset and empty mean not secure", () => {
    expect(sessionSecure({})).toBe(false);
    expect(sessionSecure({ SESSION_SECURE: "" })).toBe(false);
  });

  // the whole point: refusing is what keeps a typo from silently downgrading
  // a cookie, exactly as the go half panics rather than reading it as false
  test("refuses what it cannot read rather than defaulting to insecure", () => {
    for (const v of ["yes", "on", "2", " 1", "true ", "secure"]) {
      expect(() => sessionSecure({ SESSION_SECURE: v })).toThrow(/SESSION_SECURE/);
    }
  });
});

// BORGO_CSRF governs the check on both unsafe paths. It tested === "1", so
// every spelling but that one read as "not 1" - and in dev that meant the
// operator who wrote BORGO_CSRF=true to switch the check on switched it off.
// The direction that matters is a value nobody can parse: it must refuse, not
// fall through to whichever side the ternary happened to leave.
describe("csrfEnabled", () => {
  test("accepts everything go's ParseBool accepts, both ways, in both modes", () => {
    for (const dev of [true, false]) {
      for (const v of ["1", "t", "T", "true", "TRUE", "True"]) {
        expect(csrfEnabled(dev, { BORGO_CSRF: v })).toBe(true);
      }
      for (const v of ["0", "f", "F", "false", "FALSE", "False"]) {
        expect(csrfEnabled(dev, { BORGO_CSRF: v })).toBe(false);
      }
    }
  });

  // the defect itself: on in dev, this used to be false
  test("BORGO_CSRF=true enforces the check in dev", () => {
    expect(csrfEnabled(true, { BORGO_CSRF: "true" })).toBe(true);
  });

  test("unset and empty leave the mode's default: on in production, off in dev", () => {
    expect(csrfEnabled(false, {})).toBe(true);
    expect(csrfEnabled(false, { BORGO_CSRF: "" })).toBe(true);
    expect(csrfEnabled(true, {})).toBe(false);
    expect(csrfEnabled(true, { BORGO_CSRF: "" })).toBe(false);
  });

  test("refuses what it cannot read rather than picking a side", () => {
    for (const v of ["yes", "on", "off", "2", " 1", "true ", "enabled"]) {
      expect(() => csrfEnabled(false, { BORGO_CSRF: v })).toThrow(/BORGO_CSRF/);
      expect(() => csrfEnabled(true, { BORGO_CSRF: v })).toThrow(/BORGO_CSRF/);
    }
  });

  // the message has to name the default it is refusing to guess, or an
  // operator reading it cannot tell what happens if they unset the variable
  test("the refusal names what unset would have meant", () => {
    expect(() => csrfEnabled(false, { BORGO_CSRF: "yes" })).toThrow(/unset means on/);
    expect(() => csrfEnabled(true, { BORGO_CSRF: "yes" })).toThrow(/unset means off in dev/);
  });
});

// EVERY BOOLEAN SWITCH, PUT THROUGH THE SAME ALPHABET.
//
// BORGO_CSRF was repaired one switch at a time and the repair did not hold,
// because the disease was never in that variable: five more switches read their
// own private grammar, and one of them - BORGO_DEV - decided the very default
// BORGO_CSRF was being repaired to respect. Fixing them one at a time is how a
// sixth arrives. So the alphabet is written once, every switch is run through
// all of it, and a switch added later without an entry here is a switch whose
// author has to come and read this.
//
// The list is not a sample. Each entry is a spelling somebody actually writes:
// go's own ParseBool set both ways; the english words a person reaches for
// (`yes`, `on`, `off`); numbers that look boolean and are not (`2`, `-1`); a
// value with whitespace either side, which is what a shell heredoc or a padded
// compose file yields; a trailing \r, which is what EVERY line of a .env file
// authored on windows carries; and mixed case, which ParseBool refuses and a
// case-insensitive reader would silently accept.
const TRUE_SPELLINGS = ["1", "t", "T", "true", "TRUE", "True"];
const FALSE_SPELLINGS = ["0", "f", "F", "false", "FALSE", "False"];
const UNREADABLE = ["yes", "on", "off", "2", "-1", " 1", "1 ", "1\r", "0\r", "TrUe", "FaLsE"];

// each switch as one question - "is the thing this variable governs on?" - so
// the table can ask all of them the same way. `undefined` is the variable unset.
const SWITCHES: Array<{
  name: string;
  read: (value: string | undefined) => boolean;
  unset: boolean;
}> = [
  { name: "BORGO_DEV", read: (v) => devMode({ BORGO_DEV: v }), unset: false },
  {
    name: "BORGO_SECURITY_HEADERS",
    read: (v) => createSecurity(false, { headers: v }) !== null,
    unset: true,
  },
  { name: "BORGO_CSP", read: (v) => cspSetting(v) !== false, unset: true },
  { name: "BORGO_METRICS", read: (v) => metricsEnabled({ BORGO_METRICS: v }), unset: false },
  { name: "BORGO_RELOAD", read: (v) => reloadBanner({ BORGO_RELOAD: v }), unset: false },
  { name: "BORGO_CSRF", read: (v) => csrfEnabled(false, { BORGO_CSRF: v }), unset: true },
  { name: "SESSION_SECURE", read: (v) => sessionSecure({ SESSION_SECURE: v }), unset: false },
];

describe("every boolean env switch reads one grammar", () => {
  for (const { name, read, unset } of SWITCHES) {
    test(`${name}: unset and empty both mean ${unset}`, () => {
      expect(read(undefined)).toBe(unset);
      expect(read("")).toBe(unset);
    });

    test(`${name}: every spelling go's ParseBool takes, both ways`, () => {
      for (const v of TRUE_SPELLINGS) expect(read(v)).toBe(true);
      for (const v of FALSE_SPELLINGS) expect(read(v)).toBe(false);
    });

    // the direction that produced all of this: an unreadable value must not
    // fall through to a side. Named in the message, or an operator staring at
    // a boot failure cannot tell which of their variables it is about.
    test(`${name}: refuses what it cannot read, and says which variable`, () => {
      for (const v of UNREADABLE) {
        expect(() => read(v)).toThrow(new RegExp(name));
      }
    });

    // \r and a leading space are invisible in a terminal. The refusal has to
    // show the bytes, or the operator reads their own value back and sees
    // nothing wrong with it - and a CR would otherwise return the cursor and
    // overwrite the half of the line naming the variable.
    test(`${name}: the refusal shows an invisible character rather than printing it`, () => {
      expect(() => read("1\r")).toThrow(/\\r/);
      expect(() => read(" 1")).toThrow(/" 1"/);
    });
  }
});

// BORGO_DEV: THE ONE THAT WAS WORSE THAN THE DEFECT IT SURVIVED.
//
// Read as `!!process.env.BORGO_DEV`, so it answered the presence of the
// variable and never its value. `BORGO_DEV=0` on a production build therefore
// bought: csrf off by default, the csp relaxed to 'unsafe-inline', the dev
// websocket channel open, and __BORGO_DEV__ injected into the page. It is also
// the switch that decides the default BORGO_CSRF was just repaired to honour,
// which is why repairing that variable alone repaired nothing.
describe("devMode", () => {
  test("=0 is production, which is the whole defect", () => {
    expect(devMode({ BORGO_DEV: "0" })).toBe(false);
    expect(devMode({ BORGO_DEV: "false" })).toBe(false);
    expect(devMode({ BORGO_DEV: "1" })).toBe(true);
  });

  // the boolean is not the finding: what it BUYS is. Asserted through the two
  // things serve() derives from it, in the composition serve-entry performs -
  // a boolean that is right on its own and wrong once composed is the shape of
  // every bug in this file.
  test("what =0 used to buy: the csp and the csrf default it decides", () => {
    const dev = devMode({ BORGO_DEV: "0" });
    const security = createSecurity(dev, {})!;
    expect(security.needsNonce).toBe(true);
    expect(security.cspFor("n1")).toContain("'nonce-n1'");
    expect(security.cspFor("n1")).not.toContain("script-src 'self' 'unsafe-inline'");
    // and the switch the BORGO_CSRF fix was about, which this one overrides
    expect(csrfEnabled(dev, {})).toBe(true);
    // the same three, the other way round, so the assertions above are known
    // to be discriminating rather than true of both modes
    const on = devMode({ BORGO_DEV: "1" });
    expect(createSecurity(on, {})!.needsNonce).toBe(false);
    expect(csrfEnabled(on, {})).toBe(false);
  });

  // the enumeration above proves devMode is one honest answer. This proves the
  // entry point asks it ONCE - the boot and the catch that decides whether a
  // build error kills the process or is served as a page used to read
  // process.env separately, and two readings of one intent is the next defect
  // waiting. It is also asserted to sit ABOVE the try: a refusal re-thrown from
  // inside the handler meant to serve failures would be handled as a build
  // failure, and answered on a port it never bound.
  // the catch below binds a port, so a value borgo refuses has to fail the boot
  // rather than be re-read from inside the handler that exists to serve
  // failures - which answered from a listening socket with fewer security
  // headers than a server that had accepted it
  test("serve-entry resolves every switch once, above the try", () => {
    const src = readFileSync(join(import.meta.dir, "../src/serve-entry.ts"), "utf8");
    const calls = [...src.matchAll(/resolveSwitches\(/g)];
    expect(calls).toHaveLength(1);
    expect(src.indexOf("resolveSwitches(")).toBeLessThan(src.indexOf("try {"));
    // no switch is read a second time here, under any name
    for (const name of [
      "BORGO_DEV",
      "BORGO_CSP",
      "BORGO_CSRF",
      "BORGO_METRICS",
      "BORGO_RELOAD",
      "BORGO_SECURITY_HEADERS",
      "SESSION_SECURE",
    ]) {
      expect(src).not.toContain(`process.env.${name}`);
    }
    // and the one answer is what both the boot and the catch read
    expect(src).toContain("await serve({ dev, switches })");
    expect(src).toContain("if (!dev) throw error");
  });

  // the guard is worth nothing if the reader silently finds nothing: a rename
  // would leave every assertion above vacuously true
  test("the switch names this test looks for are the ones resolveSwitches reads", () => {
    const src = readFileSync(join(import.meta.dir, "../src/util.ts"), "utf8");
    for (const name of ["BORGO_DEV", "BORGO_CSP", "BORGO_CSRF", "BORGO_METRICS"]) {
      expect(src).toContain(name);
    }
  });
});

// BORGO_CSP IS A SWITCH AND A VALUE IN ONE VARIABLE.
//
// `env.csp !== "0"` meant every other spelling of "off" was taken for the text
// of the policy: `BORGO_CSP=false` served `Content-Security-Policy: false`. No
// browser knows a directive called `false`, so the policy enforces nothing -
// while a csp header sits in the response, in the logs, and in every scanner's
// report saying the opposite. That is worse than no header at all.
describe("cspSetting", () => {
  const html = () =>
    new Response("<p>x</p>", { headers: { "Content-Type": "text/html; charset=utf-8" } });

  test("every spelling of off drops the header instead of becoming one", () => {
    for (const v of FALSE_SPELLINGS) {
      expect(cspSetting(v)).toBe(false);
      const res = createSecurity(false, { csp: v })!.apply(html());
      expect(res.headers.get("Content-Security-Policy")).toBeNull();
      // the static headers are BORGO_SECURITY_HEADERS' business, not this one
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    }
  });

  test("every spelling of on asks for borgo's own policy", () => {
    for (const v of TRUE_SPELLINGS) {
      expect(cspSetting(v)).toBeNull();
      expect(createSecurity(false, { csp: v })!.cspFor("n1")).toContain("'nonce-n1'");
    }
  });

  // the two cases where the switch and the value nearly touch
  test("a real policy that merely contains the word false stays a policy", () => {
    const policy = "default-src 'self'; report-uri /csp/false; script-src 'self' {nonce}";
    expect(cspSetting(policy)).toBe(policy);
    expect(createSecurity(false, { csp: policy })!.needsNonce).toBe(true);
  });

  test("a policy of exactly 0 is the documented way to drop it, not a policy", () => {
    expect(cspSetting("0")).toBe(false);
  });

  // the rule that separates them: a header a browser will not act on must never
  // be installed as though it were protection
  // a single bare word is the one shape a mistyped switch and a valueless
  // directive share, so borgo cannot tell them apart and refuses rather than
  // guessing. Guessing "policy" is how `BORGO_CSP=false` came to be served as
  // one; guessing "switch" would silently drop a policy the operator wrote
  test("a bare word is refused, naming both readings", () => {
    for (const v of ["yes", "on", "off", "nonsense", "'self'", "0\r"]) {
      expect(() => cspSetting(v)).toThrow(/BORGO_CSP/);
    }
    // and the refusal has to be usable: it must offer the two ways out
    expect(() => cspSetting("upgrade-insecure-requests")).toThrow(/upgrade-insecure-requests;/);
    expect(() => cspSetting("upgrade-insecure-requests")).toThrow(/"0"/);
    // the boolean spellings are the switch, not a policy
    for (const v of ["false", "FALSE", "f", "0", "true", "1"]) {
      expect(() => cspSetting(v)).not.toThrow();
    }
  });

  // shape, not a list of names: a directive borgo has never heard of has to
  // work, or every future csp directive is a server that will not start
  test("anything shaped like a policy is served exactly as written", () => {
    expect(cspSetting("Frame-Ancestors 'none'")).toBe("Frame-Ancestors 'none'");
    expect(cspSetting("upgrade-insecure-requests;")).toBe("upgrade-insecure-requests;");
    expect(cspSetting("weird-src 'self'; frame-ancestors 'none'")).toBe(
      "weird-src 'self'; frame-ancestors 'none'",
    );
    // directives that did not exist when this was written
    expect(cspSetting("fenced-frame-src 'none'")).toBe("fenced-frame-src 'none'");
    expect(cspSetting("webrtc 'block'")).toBe("webrtc 'block'");
    // a misspelt directive is still a policy: borgo cannot know, and a header
    // the browser ignores is the operator's mistake to see, not ours to hide
    expect(cspSetting("default_src 'self'")).toBe("default_src 'self'");
  });
});

// BORGO_RELOAD only shapes the banner, so the cost of getting it wrong is a
// line of output - but a variable that ignores what the operator wrote is a
// variable they stop believing. Read for presence, `=0` meant "yes".
describe("reloadBanner", () => {
  test("=0 prints the full banner", () => {
    expect(reloadBanner({ BORGO_RELOAD: "0" })).toBe(false);
    expect(reloadBanner({ BORGO_RELOAD: "1" })).toBe(true);
  });

  // resolved with the other env at the top of serve(), not at its one use after
  // Bun.serve has already bound the port: a refusal arriving from a server that
  // is already answering requests is not a refusal
  test("server.ts reads it through this function, before the listen", () => {
    const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
    expect(src).not.toContain("process.env.BORGO_RELOAD");
    expect(src.indexOf("reloadBanner(")).toBeLessThan(src.indexOf("Bun.serve"));
  });
});

// BORGO_PUSH_KEY HAS TO HOLD ON BOTH HALVES.
//
// /__borgo/publish relays whatever it is handed to every browser subscribed to
// the topic, so who may call it is the whole of its security. Two ways to say
// "you may": a shared key, or - with no key configured anywhere - the request
// having come from loopback and not through a proxy.
//
// The two misconfigurations were not symmetric. Key on the front server only:
// the api sends none, every push is refused, the operator sees it. Key on the
// API ONLY: this side never read the header at all and fell straight through to
// the loopback rule, so every push was accepted. The operator had a setting that
// reads as authentication and authenticated nothing - and loopback is not that
// rule's equal, because `borgo start` puts both halves on one host, so it admits
// every other local process and every other tenant of a shared box.
describe("pushAuthorized: the two halves must agree that key auth is on", () => {
  const local = "127.0.0.1";

  test("both halves configured: the key decides, and nothing else has to", () => {
    expect(pushAuthorized({ key: "s3cret", presented: "s3cret", address: local, forwarded: false })).toBe("ok");
    // cross-host push is the entire reason the key exists, so a key holder is
    // not additionally required to be on loopback or unproxied
    expect(pushAuthorized({ key: "s3cret", presented: "s3cret", address: "10.0.0.9", forwarded: true })).toBe("ok");
  });

  test("a wrong or missing key is refused when one is configured here", () => {
    expect(pushAuthorized({ key: "s3cret", presented: "wrong", address: local, forwarded: false })).toBe("bad-key");
    // the front-server-only asymmetry: the api sends nothing, and this closes
    expect(pushAuthorized({ key: "s3cret", presented: null, address: local, forwarded: false })).toBe("bad-key");
    expect(pushAuthorized({ key: "s3cret", presented: "", address: local, forwarded: false })).toBe("bad-key");
    // a prefix of the key is not the key
    expect(pushAuthorized({ key: "s3cret", presented: "s3cre", address: local, forwarded: false })).toBe("bad-key");
  });

  // THE ONE THAT USED TO FAIL OPEN
  test("a key presented to a front server that has none is refused, not downgraded", () => {
    expect(pushAuthorized({ key: undefined, presented: "s3cret", address: local, forwarded: false })).toBe(
      "half-configured",
    );
    // and it stays refused however loopback-ish the caller looks - the whole
    // defect was that this fell back to exactly that test
    for (const address of [local, "::1", "::ffff:127.0.0.1"]) {
      expect(pushAuthorized({ key: undefined, presented: "anything", address, forwarded: false })).toBe(
        "half-configured",
      );
    }
    // an empty key env is not a configured key
    expect(pushAuthorized({ key: "", presented: "s3cret", address: local, forwarded: false })).toBe(
      "half-configured",
    );
  });

  test("with no key anywhere, loopback and only loopback may push", () => {
    for (const address of [local, "::1", "::ffff:127.0.0.1"]) {
      expect(pushAuthorized({ key: undefined, presented: null, address, forwarded: false })).toBe("ok");
    }
    for (const address of [undefined, "10.0.0.9", "192.168.1.4", "1.2.3.4"]) {
      expect(pushAuthorized({ key: undefined, presented: null, address, forwarded: false })).toBe("not-local");
    }
  });

  // behind a local reverse proxy every external request arrives from 127.0.0.1,
  // so the forwarding headers the proxy stamps are what tells the two apart
  test("a forwarded request is not local, whatever address it arrived from", () => {
    expect(pushAuthorized({ key: undefined, presented: null, address: local, forwarded: true })).toBe(
      "not-local",
    );
    expect(pushAuthorized({ key: undefined, presented: null, address: "::1", forwarded: true })).toBe(
      "not-local",
    );
  });

  // the wiring: server.ts must refuse on anything but "ok", and must say so
  test("the front server refuses every verdict that is not ok", () => {
    const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
    expect(src).toContain("pushAuthorized({");
    expect(src).toContain('if (verdict !== "ok") return secure(new Response("forbidden", { status: 403 }));');
    // and the half-configured case is not silent: an operator who set the key on
    // one side has to be told the other side is refusing because of it
    expect(src).toContain('if (verdict === "half-configured") warnHalfConfiguredPushKey();');
    // the old shape read the key and fell through to the loopback test
    expect(src).not.toContain("isLoopback(server.requestIP(req)?.address) && !forwarded");
  });
});

// THE GUARD STOPPED APPLYING FOR A VALUE THE CALLER WRITES.
//
// `req.headers.get("x-forwarded-for") ?? req.headers.get("forwarded")` reads
// "did a proxy touch this" out of a header's CONTENT. An empty X-Forwarded-For
// is a string, so `??` was satisfied by it and never looked at `Forwarded` -
// and `!forwarded` then called the empty string "nothing forwarded this".
// Measured on the socket against the running front server: empty, spaces, and
// empty-plus-a-real-Forwarded all took /__borgo/publish from 403 to 204.
describe("isForwarded: presence, never content", () => {
  const h = (init: Array<[string, string]>) => {
    const headers = new Headers();
    for (const [k, v] of init) headers.append(k, v);
    return headers;
  };

  test("absent is the only shape that is not forwarded", () => {
    expect(isForwarded(h([]))).toBe(false);
    expect(isForwarded(h([["content-type", "application/json"]]))).toBe(false);
  });

  // the four spellings the wire produced, each of which used to disarm it
  test("empty, spaces and duplicates are all a proxy having been here", () => {
    expect(isForwarded(h([["x-forwarded-for", "1.2.3.4"]]))).toBe(true);
    expect(isForwarded(h([["x-forwarded-for", ""]]))).toBe(true);
    expect(isForwarded(h([["x-forwarded-for", "   "]]))).toBe(true);
    // a repeated header: Headers joins them, and either half being empty
    // changes nothing about the fact that it was sent
    expect(isForwarded(h([["x-forwarded-for", ""], ["x-forwarded-for", "1.2.3.4"]]))).toBe(true);
    expect(isForwarded(h([["x-forwarded-for", "1.2.3.4"], ["x-forwarded-for", ""]]))).toBe(true);
  });

  // THE MASKING. An empty first header satisfied the coalesce, so the second
  // one - carrying a real chain - was never read at all.
  test("an empty header cannot hide a real one behind it", () => {
    expect(isForwarded(h([["x-forwarded-for", ""], ["forwarded", "for=1.2.3.4"]]))).toBe(true);
    expect(isForwarded(h([["x-forwarded-for", "   "], ["forwarded", "for=1.2.3.4"]]))).toBe(true);
    // and the coalesce this replaces, spelled out, so the difference is visible
    const headers = h([["x-forwarded-for", ""], ["forwarded", "for=1.2.3.4"]]);
    const old = headers.get("x-forwarded-for") ?? headers.get("forwarded");
    expect(old).toBe("");
    expect(Boolean(old)).toBe(false); // what the guard used to conclude
    expect(isForwarded(headers)).toBe(true); // what is true
  });

  // borgo's own generated nginx sets X-Forwarded-Proto, and a hop the guard
  // does not look at is a hop it cannot see
  test("every header a proxy stamps counts, not the two that were checked", () => {
    for (const name of FORWARDING_HEADERS) {
      expect(isForwarded(h([[name, ""]]))).toBe(true);
    }
    expect(FORWARDING_HEADERS).toContain("x-forwarded-proto");
    expect(FORWARDING_HEADERS).toContain("x-real-ip");
  });

  test("and the two ends meet: a forwarded request is not local", () => {
    const local = "127.0.0.1";
    const push = (headers: Headers) =>
      pushAuthorized({ key: undefined, presented: null, address: local, forwarded: isForwarded(headers) });
    expect(push(h([]))).toBe("ok");
    for (const headers of [
      h([["x-forwarded-for", ""]]),
      h([["x-forwarded-for", "   "]]),
      h([["x-forwarded-for", ""], ["forwarded", "for=1.2.3.4"]]),
      h([["x-forwarded-proto", "https"]]),
    ]) {
      expect(push(headers)).toBe("not-local");
    }
  });

  test("the front server asks presence, not a header value", () => {
    const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
    expect(src).toContain("forwarded: isForwarded(req.headers)");
    expect(src).not.toContain('req.headers.get("x-forwarded-for") ?? req.headers.get("forwarded")');
  });
});

// A COMMA IS THE SEPARATOR, SO IT CANNOT ALSO BE A CHARACTER.
//
// Measured against the running front server: /ws?topics=a%2Cb upgraded (101),
// the browser was subscribed to "a" and "b", the __count frames for both
// arrived, and a push naming "a,b" was answered 204 having reached nobody. Every
// signal a person debugging would look at said the channel was working.
describe("topicRejection", () => {
  test("a plain topic passes", () => {
    for (const t of ["chat", "room:1", "tasks/7", "a b", "a;b", "a.b"]) {
      expect(topicRejection(t)).toBeNull();
    }
  });

  test("a comma anywhere is refused, and the message names the topic", () => {
    for (const t of ["a,b", ",lead", "trail,", "a,,b"]) {
      const why = topicRejection(t);
      expect(why).not.toBeNull();
      expect(why).toContain(JSON.stringify(t));
    }
    // and it says what to do, because the refusal is the first the author hears
    expect(topicRejection("a,b")).toContain("rename");
  });

  test("both doors are shut in the front server, and both say the topic", () => {
    const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
    // the subscription: read off the RAW query, or searchParams decodes the
    // %2C back into the separator before anything can see it
    expect(src).toContain("topicRejection(topic)");
    expect(src).toContain("url.search.slice(1)");
    expect(src).not.toContain('url.searchParams.get("topics")');
    // the push
    expect(src).toContain("topicRejection(msg.topic)");
  });
});

// THE ORIGIN CHECK IGNORED THE SCHEME, AND NO ORIGIN AT ALL WAS A PASS.
// Measured on the socket: `Origin: https://localhost:3111` upgraded (101)
// against a server listening on http, and a handshake with no Origin header
// upgraded too - while `Origin: http://evil.test` was refused. The guard applied
// exactly when the caller chose to make it apply.
describe("wsOriginAllowed", () => {
  const ask = (over: Partial<Parameters<typeof wsOriginAllowed>[0]>) =>
    wsOriginAllowed({
      origin: null,
      host: "app.test",
      proto: "http",
      forwardedProto: null,
      allowNoOrigin: false,
      ...over,
    });

  test("the same scheme and host is the app's own page", () => {
    expect(ask({ origin: "http://app.test" })).toBe(true);
    expect(ask({ origin: "http://app.test/some/page?q=1" })).toBe(true);
  });

  test("another host is refused, port included", () => {
    expect(ask({ origin: "http://evil.test" })).toBe(false);
    expect(ask({ origin: "http://app.test:8080" })).toBe(false);
    expect(ask({ origin: "http://sub.app.test" })).toBe(false);
    // "null" is a sandboxed iframe or a cross-origin redirect, not this origin
    expect(ask({ origin: "null" })).toBe(false);
    expect(ask({ origin: "" })).toBe(false);
    expect(ask({ origin: "not a url" })).toBe(false);
  });

  // THE ONE THE HOST COMPARISON LET THROUGH
  test("the scheme is part of the origin", () => {
    expect(ask({ origin: "https://app.test" })).toBe(false);
    expect(ask({ origin: "http://app.test", proto: "https" })).toBe(false);
    expect(ask({ origin: "ws://app.test" })).toBe(false);
    expect(ask({ origin: "https://app.test", proto: "https" })).toBe(true);
  });

  // borgo behind nginx reads http and the browser sent https; the generated
  // config sets this header for exactly that
  test("a terminating proxy's scheme is the one compared", () => {
    expect(ask({ origin: "https://app.test", forwardedProto: "https" })).toBe(true);
    expect(ask({ origin: "http://app.test", forwardedProto: "https" })).toBe(false);
    // a chain: the client's hop is the first
    expect(ask({ origin: "https://app.test", forwardedProto: "https, http" })).toBe(true);
    expect(ask({ origin: "https://app.test", forwardedProto: " HTTPS " })).toBe(true);
    // an empty one is not a claim, so the scheme borgo read stands
    expect(ask({ origin: "http://app.test", forwardedProto: "" })).toBe(true);
    expect(ask({ origin: "https://app.test", forwardedProto: "" })).toBe(false);
  });

  // THE OTHER ONE: absent meant admitted, and absent is every non-browser caller
  test("no Origin is a refusal unless the operator said otherwise", () => {
    expect(ask({ origin: null })).toBe(false);
    expect(ask({ origin: null, allowNoOrigin: true })).toBe(true);
    // and the exemption is only about the absent case: it does not re-admit a
    // cross-origin browser
    expect(ask({ origin: "http://evil.test", allowNoOrigin: true })).toBe(false);
    expect(ask({ origin: "https://app.test", allowNoOrigin: true })).toBe(false);
  });

  test("the switch is resolved with every other switch, above the try", () => {
    expect(resolveSwitches({}).wsAllowNoOrigin).toBe(false);
    expect(resolveSwitches({ BORGO_WS_ALLOW_NO_ORIGIN: "1" }).wsAllowNoOrigin).toBe(true);
    expect(resolveSwitches({ BORGO_WS_ALLOW_NO_ORIGIN: "false" }).wsAllowNoOrigin).toBe(false);
    // the same grammar as every other boolean switch, refusal included
    expect(() => resolveSwitches({ BORGO_WS_ALLOW_NO_ORIGIN: "yes" })).toThrow(/BORGO_WS_ALLOW_NO_ORIGIN/);
    const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
    expect(src).toContain("allowNoOrigin: switches.wsAllowNoOrigin");
    expect(src).not.toContain("new URL(origin).host === url.host");
  });
});

// THE EXEMPTION WAS WRITTEN ON THE PATH AND MEANT TO BE ABOUT THE AUTHOR.
// Measured on the socket: borgo's own 502 (api down) and 403 (bad csrf token) on
// /api left with no nosniff, no Referrer-Policy, no X-Frame-Options and no CSP,
// while a 404 from the same server carried all four.
describe("isUpstream: the headers follow the author, not the url", () => {
  test("a response borgo built is unmarked, which is the safe direction", () => {
    expect(isUpstream(new Response("invalid csrf token", { status: 403 }))).toBe(false);
    expect(isUpstream(new Response("api timeout", { status: 504 }))).toBe(false);
    expect(isUpstream(new Response("api unreachable", { status: 502 }))).toBe(false);
  });

  test("only what came back from go carries the mark, and it is the same object", () => {
    const upstream = new Response("{}", { status: 200 });
    expect(markUpstream(upstream)).toBe(upstream);
    expect(isUpstream(upstream)).toBe(true);
    // and the mark does not travel to a copy: a rebuilt response is a response
    // borgo built
    expect(isUpstream(new Response(null, { status: 200, headers: upstream.headers }))).toBe(false);
  });

  test("the proxy marks the upstream answer and nothing else it returns", () => {
    const src = readFileSync(join(import.meta.dir, "../src/util.ts"), "utf8");
    expect(src).toContain("return markUpstream(upstream);");
    for (const own of ['new Response("api timeout", { status: 504 })', 'new Response("api unreachable", { status: 502 })']) {
      expect(src).toContain(`return ${own}`);
      expect(src).not.toContain(`return markUpstream(${own})`);
    }
  });

  test("the front server asks the author, not the path", () => {
    const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
    expect(src).toContain("const fromApi = isUpstream(response);");
    expect(src).toContain("return fromApi ? response : secure(response);");
    // the path test that let borgo's own answers out bare
    expect(src).not.toContain('url.pathname.startsWith("/api/") ? response : secure(response)');
    // and it is read BEFORE dropBody, which builds a new object for a HEAD
    expect(src.indexOf("const fromApi = isUpstream(response);")).toBeLessThan(
      src.indexOf("response = dropBody(response);"),
    );
  });
});

// THE TITLE TRAVELLED AS MARKUP AND WAS ASSIGNED AS TEXT.
// Measured on the wire with `<title>Tom &amp; Jerry</title>` in index.html: the
// server-rendered tab read `Tom & Jerry` and the document carried
// `window.__BORGO_TITLE__="Tom &amp; Jerry"`, so the first client navigation back
// to the shell default put the literal entity in the tab. One title, two
// spellings, and only the second one is ever seen.
describe("the shell title is data, not markup", () => {
  const shell = (title: string) =>
    prepareShell(`<html><head><title>${title}</title></head><body><!--app--><!--props--></body></html>`, false);

  test("the four references escapeHtml emits come back as themselves", () => {
    expect(decodeHtmlText("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeHtmlText("&lt;b&gt;")).toBe("<b>");
    expect(decodeHtmlText("say &quot;hi&quot;")).toBe('say "hi"');
    expect(decodeHtmlText("it&apos;s")).toBe("it's");
    expect(decodeHtmlText("it&#39;s")).toBe("it's");
    expect(decodeHtmlText("&#x2713; done")).toBe("\u2713 done");
    // a round trip through the escaper this file already owns
    for (const s of ['a & b < c > d "e"', "&&&", "<script>", "plain"]) {
      expect(decodeHtmlText(escapeHtml(s))).toBe(s);
    }
  });

  test("a reference borgo does not know is left exactly as written", () => {
    // decoding a value is not repairing one: a half-decoded & would be a new
    // way to disagree with the browser about the same bytes
    expect(decodeHtmlText("&nosuchref; &amp")).toBe("&nosuchref; &amp");
    expect(decodeHtmlText("100% &#x110000; &#0;")).toBe("100% &#x110000; &#0;");
    expect(decodeHtmlText("&#xD800;")).toBe("&#xD800;");
    expect(decodeHtmlText("")).toBe("");
  });

  test("the value the browser assigns to document.title is the text", () => {
    expect(shell("Tom &amp; Jerry").title).toBe("Tom & Jerry");
    expect(shell("Tom &amp; Jerry").stateTail).toBe(
      ';window.__BORGO_TITLE__="Tom & Jerry"</script>',
    );
    // and it is still json, so a title carrying a quote or a </script> cannot
    // end the script it rides in
    expect(shell("a &quot;b&quot; c").stateTail).toBe(
      ';window.__BORGO_TITLE__="a \\"b\\" c"</script>',
    );
    expect(shell("&lt;/script&gt;").stateTail).toBe(
      ';window.__BORGO_TITLE__="\\u003c/script>"</script>',
    );
  });

  test("a shell with no title still has none, and a plain one is untouched", () => {
    expect(prepareShell("<html><head></head><body><!--app--></body></html>", false).title).toBe("");
    expect(shell("borgo tasks").title).toBe("borgo tasks");
  });
});

// The refusal for a bare word suggests adding a semicolon to make it a policy.
// Measured on the socket before this: `BORGO_CSP=false;` was then served as
// `Content-Security-Policy: false;` - the original fail-open, reached by
// following our own advice. No csp directive is named after a switch.
describe("cspSetting punctuation is not a way back into the defect", () => {
  // refused, not quietly read as "off": one rule, and the message already says
  // how to spell off. What must never happen is serving it as a policy
  test("a switch word is never a policy, however it is punctuated", () => {
    for (const v of ["false;", "0;", "off;", "no;", "disabled;", " false ; ", "FALSE;"]) {
      expect(() => cspSetting(v)).toThrow(/BORGO_CSP/);
    }
    // the plain spellings still work, so the way out the message names is real
    expect(cspSetting("false")).toBe(false);
    expect(cspSetting("0")).toBe(false);
  });

  test("and a real single directive still gets through with its semicolon", () => {
    expect(cspSetting("upgrade-insecure-requests;")).toBe("upgrade-insecure-requests;");
    expect(cspSetting("block-all-mixed-content;")).toBe("block-all-mixed-content;");
  });
});
