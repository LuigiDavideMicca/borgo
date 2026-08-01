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
  idleTimeout,
  IDLE_TIMEOUT_MAX,
  IDLE_TIMEOUT_SECONDS,
  isLongLivedStream,
  metricsEnabled,
  PROXY_RETRY_MAX_BODY,
  scriptJson,
  shouldBufferBody,
  UNKNOWN_CHANGE,
} from "../src/util";

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

describe("envInt", () => {
  test("unset and empty fall back", () => {
    expect(envInt(undefined, 30_000)).toBe(30_000);
    expect(envInt("", 30_000)).toBe(30_000);
  });

  test("valid values win, zero is a valid value", () => {
    expect(envInt("5000", 30_000)).toBe(5000);
    expect(envInt("0", 30_000)).toBe(0);
    expect(envInt("1.9", 30_000)).toBe(1);
  });

  test("garbage and negatives fall back instead of disabling the limit", () => {
    expect(envInt("banana", 30_000)).toBe(30_000);
    expect(envInt("-1", 30_000)).toBe(30_000);
    expect(envInt("Infinity", 30_000)).toBe(30_000);
    expect(envInt("NaN", 30_000)).toBe(30_000);
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

  test("only 1 counts", () => {
    for (const value of ["0", "true", "yes", "", " 1"]) {
      expect(metricsEnabled({ BORGO_METRICS: value })).toBe(false);
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

// borgo used to run the front server with idleTimeout: 0, on the strength of a
// comment about proxied SSE responses. But bun's idleTimeout is not a
// response-side setting: the same number bounds how long the server waits for
// an inbound request's headers and body. Disabling it left the internet-facing
// server with no read deadline at all, while README and docs/security.md
// advertised "a slowloris-resistant timeout matrix" that belongs to the GO
// server. The deadline is back, and the exemption is per response.
describe("the read deadline", () => {
  test("defaults to a real number of seconds, not to none", () => {
    expect(idleTimeout(undefined)).toBe(IDLE_TIMEOUT_SECONDS);
    expect(idleTimeout("")).toBe(IDLE_TIMEOUT_SECONDS);
    expect(IDLE_TIMEOUT_SECONDS).toBeGreaterThan(0);
    // garbage must not silently disable it
    expect(idleTimeout("soon")).toBe(IDLE_TIMEOUT_SECONDS);
    expect(idleTimeout("-5")).toBe(IDLE_TIMEOUT_SECONDS);
  });

  test("BORGO_IDLE_TIMEOUT overrides it, and bun's ceiling is respected", () => {
    expect(idleTimeout("5")).toBe(5);
    // an explicit 0 is a deliberate opt-out and stays honoured
    expect(idleTimeout("0")).toBe(0);
    // bun rejects anything above 255 outright, which would take the server down
    expect(idleTimeout("3600")).toBe(IDLE_TIMEOUT_MAX);
    expect(IDLE_TIMEOUT_MAX).toBe(255);
  });

  test("a stream that lives on purpose is recognised by its content type", () => {
    const res = (type?: string) => new Response(null, type ? { headers: { "Content-Type": type } } : {});
    expect(isLongLivedStream(res("text/event-stream"))).toBe(true);
    expect(isLongLivedStream(res("text/event-stream; charset=utf-8"))).toBe(true);
    expect(isLongLivedStream(res("Text/Event-Stream"))).toBe(true);
    expect(isLongLivedStream(res("multipart/x-mixed-replace; boundary=x"))).toBe(true);
    // and everything else is bounded work that the deadline should apply to
    expect(isLongLivedStream(res("text/html; charset=utf-8"))).toBe(false);
    expect(isLongLivedStream(res("application/json"))).toBe(false);
    expect(isLongLivedStream(res("text/event-streamish"))).toBe(false);
    expect(isLongLivedStream(res())).toBe(false);
  });

  // the two halves against a real bun server: the deadline has to actually cut
  // a dribbling body, and the exemption has to actually save a silent stream
  test("bun enforces it on an inbound body, and server.timeout(req, 0) lifts it", async () => {
    // measured against bun 1.3.14: an unexempted response-side stream is cut
    // at ~4s no matter how small idleTimeout is (1, 2 and 3 all cut at ~4.0s),
    // so the silence has to clear that floor for the exemption to be the thing
    // under test rather than the clock
    const SILENCE_MS = 6_000;
    const server = Bun.serve({
      port: 0,
      idleTimeout: idleTimeout("1"),
      async fetch(req, srv) {
        if (new URL(req.url).pathname === "/sse") {
          if (isLongLivedStream(SSE_HEADERS)) srv.timeout(req, 0);
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
                // then sit silent well past the deadline, like a real feed
                setTimeout(() => {
                  try {
                    controller.enqueue(new TextEncoder().encode("data: late\n\n"));
                    controller.close();
                  } catch {}
                }, SILENCE_MS);
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return new Response(`got ${(await req.text()).length}`);
      },
    });

    const port = server.port!;

    // a POST that promises 1000 bytes, sends one, and then says nothing
    const slowloris = new Promise<string>((resolve) => {
      const t0 = Date.now();
      void Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(socket) {
            socket.write(
              "POST /slow HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n" +
                "Content-Type: text/plain\r\n\r\nx",
            );
          },
          close: () => resolve("dropped"),
          error: () => resolve("dropped"),
          data() {},
        },
      }).catch(() => resolve("dropped"));
      setTimeout(() => resolve(`held for ${Date.now() - t0}ms`), SILENCE_MS);
    });

    // and, on the same server, an event stream that survives the same silence
    const stream = (async () => {
      const res = await fetch(`http://127.0.0.1:${port}/sse`);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      let body = "";
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) body += new TextDecoder().decode(value);
      }
      return body;
    })();

    try {
      expect(await slowloris).toBe("dropped");
      const body = await stream;
      expect(body).toContain("data: hi");
      expect(body).toContain("data: late");
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

// the response the handler is about to return decides the exemption, so the
// check runs against a real Response and not against a path or a guess
const SSE_HEADERS = new Response(null, { headers: { "Content-Type": "text/event-stream" } });

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
