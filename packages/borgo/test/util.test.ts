import { describe, expect, test } from "bun:test";
import {
  createSecurity,
  decodeChanged,
  encodeChanged,
  envInt,
  escapeHtml,
  freshCookieHeader,
  hasCookie,
  headHtml,
  headResponse,
  scriptJson,
  UNKNOWN_CHANGE,
  csrfEnabled,
  sessionSecure,
  cspSetting,
  devMode,
  reloadBanner,
  resolveSwitches,
  MAX_BODY_BYTES,
  decodeHtmlText,
  prepareShell,
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

  // the variable this is actually for, through the function that resolves
  // it - a unit that is right while the switch it feeds is wrong is the bug
  // this whole file exists about
  test("the limit resolves through it, and a refusal names the variable", () => {
    expect(resolveSwitches({}).maxBody).toBe(MAX_BODY_BYTES);
    expect(resolveSwitches({ BORGO_MAX_BODY: "0" }).maxBody).toBe(0);
    expect(resolveSwitches({ BORGO_MAX_BODY: "4096" }).maxBody).toBe(4096);
    expect(() => resolveSwitches({ BORGO_MAX_BODY: "0.5" })).toThrow(/BORGO_MAX_BODY/);
  });

  // AND THE REFUSAL HAPPENS ABOVE THE TRY. It was read inside serve(), which
  // serve-entry wraps in a catch that BINDS A PORT: a refused value would have
  // been answered from a listening socket with no security headers at all -
  // exactly what resolveSwitches was written to close for the switches before
  // it. (BORGO_API_TIMEOUT went with the /api proxy; the go front holds the
  // public port and its own deadlines.)
  test("the limit is not read inside serve()", () => {
    const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
    expect(src).not.toContain("process.env.BORGO_MAX_BODY");
    expect(src).toContain("switches.maxBody");
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
    // six real servers: 18ms idle, but past bun's default 5s budget under load
    // (measured: 5/5 failures at 16 burners on 8 cores, all "timed out")
  }, 30_000);

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

  // the go half returns an error rather than reading a typo as false
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
    // BORGO_METRICS is the go front's now, read in metrics.go
    for (const name of ["BORGO_DEV", "BORGO_CSP", "BORGO_CSRF"]) {
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


// THE EXEMPTION WAS WRITTEN ON THE PATH AND MEANT TO BE ABOUT THE AUTHOR.
// Measured on the socket: borgo's own 502 (api down) and 403 (bad csrf token) on
// /api left with no nosniff, no Referrer-Policy, no X-Frame-Options and no CSP,
// while a 404 from the same server carried all four.
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

// The first sweep is 2s away and the wheel ticks every 4s on a phase the
// process fixed long before this request: inside the dead zone the value the
// first byte leaves expires at the next tick, which half the time is before the
// keep-warm has ever run. Measured at T=3 and T=4: closed at 4000ms minus the
// phase, zero re-arms. So a server and its stream are started at three offsets
// spanning the whole tick period, and at least one lands in the window.