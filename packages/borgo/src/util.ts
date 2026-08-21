import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { c, g } from "./colors";
import { documentStream, gzipStream, pickEncoding } from "./compress";
import { CSRF_COOKIE, CSRF_FIELD, CSRF_HEADER, csrfCookieValue } from "./index";
import { unsafeMethod, withCsrf } from "./internal";
import { resolveHead, safeHeadAttrs, type ActionContext, type Head, type Route } from "./router";

// constant-time on the value, honest about the length: a comparison that
// leaks how many prefix bytes matched is a comparison an attacker can walk
export const keysEqual = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// attribute values are always double-quoted, so this is the complete set
export const escapeHtml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// safeHeadAttrs lives in router.ts because the browser runtime applies the
// very same head and has to refuse the very same names
export function headHtml(head: Head): string {
  let html = "";
  if (head.title) html += `<title>${escapeHtml(String(head.title))}</title>`;
  for (const meta of head.meta ?? []) {
    let attrs = "";
    for (const [name, value] of safeHeadAttrs(meta)) {
      attrs += ` ${name}="${escapeHtml(value)}"`;
    }
    html += `<meta${attrs} data-borgo-head>`;
  }
  return html;
}

// security headers, applied to every response borgo builds itself (the /api
// proxy hands go's own headers through untouched). the defaults are:
//   X-Content-Type-Options: nosniff
//   Referrer-Policy: strict-origin-when-cross-origin
//   X-Frame-Options: DENY
//   Content-Security-Policy: default-src 'self'; base-uri 'none';
//     object-src 'none'; frame-ancestors 'none'; form-action 'self';
//     img-src 'self' data: blob:; font-src 'self' data:;
//     style-src 'self' 'unsafe-inline'; connect-src 'self';
//     script-src 'self' 'nonce-<per request>'
// the csp rides on documents and on svg (which runs its own scripts when
// navigated to directly), not on every asset. the ssr inline script carrying
// window.__PROPS__ is allowed by that per-request nonce, never by
// 'unsafe-inline'; a hydrate=false page has no inline script and is served
// the same policy without one. style-src keeps 'unsafe-inline' because react
// renders style={{}} as a style attribute, which no nonce can cover, and
// connect-src 'self' covers same-origin ws:// per csp level 3. dev swaps the
// nonce for 'unsafe-inline': the error overlay and the zero-js reload client
// are inline scripts built outside the render.
// BORGO_SECURITY_HEADERS=0 (or false) drops all of it; BORGO_CSP=0 (or false)
// drops the csp alone and BORGO_CSP=<policy> replaces it, with {nonce}
// substituted per request. see cspSetting for why "off" cannot be a policy.
export const CSP_DEFAULT =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
  "form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; connect-src 'self'; script-src 'self'";

const STATIC_SECURITY = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["X-Frame-Options", "DENY"],
] as const;

export type Security = {
  needsNonce: boolean;
  cspFor: (nonce: string) => string;
  apply: (res: Response) => Response;
};

/**
 * WHETHER A VALUE IS SHAPED LIKE A POLICY - ASKED OF ITS SHAPE, NEVER OF A LIST
 * OF DIRECTIVE NAMES.
 *
 * This used to be a set of every directive a browser acts on, and a policy
 * naming none of them was refused. That set was wrong the day it was written
 * and gets wronger: `fenced-frame-src 'none'`, `webrtc 'block'`, `plugin-types
 * application/pdf` and `referrer no-referrer` are all real policies real
 * operators write, and every one of them was a front server that would not
 * start. A list of names is always behind the specification, so EVERY DIRECTIVE
 * ADDED TO CSP AFTER TODAY WOULD HAVE BEEN A BOOT FAILURE - and the operator's
 * only remedy was to patch borgo. That is a worse failure than the one the list
 * was built to prevent, because it has no operator-side fix at all.
 *
 * What actually has to be told apart is narrower than "is this a valid policy":
 * it is "did the operator mean to TURN THE HEADER OFF, or did they write a
 * POLICY". The switch spellings are a closed set of twelve (go's ParseBool),
 * and everything a person reaches for instead - `yes`, `on`, `off`, `no`, `2`,
 * `enabled` - shares exactly one shape: ONE BARE WORD, no value, no separator.
 * That is also the shape of a valueless directive (`upgrade-insecure-requests`),
 * and the two are genuinely indistinguishable without knowing the directive
 * names. So one bare word is the only thing refused, and everything else is a
 * policy:
 *
 *   - two or more tokens: `webrtc 'block'`, `fenced-frame-src 'none'`, and any
 *     directive invented next year. A misspelling like `default_src 'self'`
 *     rides through, which is the price of not holding a list - and it is the
 *     cheap direction, because the operator wrote a policy and gets one.
 *   - anything containing `;`, which no switch spelling has. This is also the
 *     escape hatch for a genuinely valueless directive: `upgrade-insecure-
 *     requests;` is valid serialized csp (the grammar admits a trailing
 *     separator) and every browser takes it, so no policy in the language is
 *     unreachable - the worst case costs one character, which is the whole
 *     difference from the list this replaces.
 *
 * A single trailing space cannot smuggle `yes ` through as two tokens: empty
 * tokens are dropped before counting.
 */
const looksLikeAPolicy = (value: string): boolean => {
  // the punctuation the refusal below suggests must not be a way back into the
  // defect: `false;` was served as `Content-Security-Policy: false;`, and the
  // operator who added that semicolon did it because we told them to. No csp
  // directive is ever named after a switch, so a word that is one is the switch
  // however it is punctuated - a deny-list of english words, not the allow-list
  // of directive names that would lag the spec
  const bare = value.replace(/[\s;]+/g, " ").trim();
  if (SWITCH_WORDS.includes(bare.toLowerCase())) return false;
  return value.includes(";") || value.split(/\s+/).filter(Boolean).length > 1;
};

const SWITCH_WORDS = [
  "0", "1", "t", "f", "true", "false", "yes", "no", "on", "off", "enable",
  "disable", "enabled", "disabled", "none", "null", "nil", "unset", "default",
];

/**
 * WHETHER `Headers.set` WOULD REFUSE THIS, ASKED OF Headers ITSELF.
 *
 * `createSecurity().apply` calls `headers.set("Content-Security-Policy", ...)`
 * on every document. A policy carrying a newline passed every check at boot and
 * then THREW ON EVERY SINGLE REQUEST: measured on the socket, the server
 * announced ready and answered 500 to the page, to /metrics and to a 404 alike,
 * with X-Frame-Options, nosniff and Referrer-Policy present (they are set before
 * the throw) and no csp at all. That is the same "the operator has a server that
 * does not work" as a failed boot, moved to where it is harder to attribute.
 *
 * The rule is bun's and is not restated here: a hard-coded character class is a
 * guess that goes stale the day bun changes what it takes. So the value is
 * offered to a throwaway Headers and the refusal is caught. Bun's own message is
 * NOT propagated - it embeds the offending value raw, newline and all, which
 * would put a CR back into a boot error whose whole job is to be readable.
 */
const headersRefuses = (value: string): boolean => {
  try {
    new Headers().set("Content-Security-Policy", value);
    return false;
  } catch {
    return true;
  }
};

/**
 * BORGO_CSP, which is a switch and a value in one variable - and so the one
 * place the boolean grammar cannot simply be applied.
 *
 * It tested `!== "0"`, so every other spelling of "off" was taken for the TEXT
 * OF THE POLICY: `BORGO_CSP=false` shipped `Content-Security-Policy: false`, a
 * header holding no directive any browser knows. The browser discards it, so
 * the csp is absent - while a csp header sits in the response, in the logs and
 * in every scanner's report. Fail-open wearing the costume of the control.
 *
 * The two roles are separated by grammar, not by guessing: a value spelled as a
 * boolean IS the switch and can never be a policy, a value shaped like a policy
 * is one (see looksLikeAPolicy - shape, not a list of names), and a bare word,
 * which is the one shape the two share, is refused at boot naming BOTH readings.
 * So `false`/`FALSE`/`f` drop the header exactly as `0` always did, `true` asks
 * for the default policy, and `yes`, `on` and `2` name an intent nobody can
 * read - which is a boot failure, not a policy.
 *
 * Returns `false` to drop the header, `null` for the built-in default, or the
 * operator's policy.
 */
export function cspSetting(value: string | undefined): string | false | null {
  const raw = envText("BORGO_CSP", value);
  if (raw === undefined) return null;
  const asSwitch = boolish(raw);
  if (asSwitch !== undefined) return asSwitch && null;
  if (!looksLikeAPolicy(raw)) {
    throw new Error(
      `borgo: BORGO_CSP: ${JSON.stringify(raw)} is a single bare word, which is the one shape a ` +
        `mistyped switch and a valueless directive share - so borgo cannot tell which you meant. ` +
        `If you wanted the header off, write "0" or "false" ("1"/"true" asks for borgo's own ` +
        `policy, unset means the same). If it was a policy, it is missing the punctuation that ` +
        `makes it one: give the directive a value (${JSON.stringify(raw + " 'none'")}) or end it ` +
        `with a semicolon (${JSON.stringify(raw + ";")}), both of which are valid csp. ` +
        `Serving it as written would put a header on every document that no browser enforces`,
    );
  }
  // both forms the policy takes at request time, since {nonce} is substituted
  // after this point - and a boot that accepts what a request cannot write is
  // a server that starts and then answers 500 to everything
  for (const form of [raw.replaceAll("{nonce}", ""), raw.replaceAll("{nonce}", " 'nonce-probe'")]) {
    if (!headersRefuses(form)) continue;
    throw new Error(
      `borgo: BORGO_CSP: ${JSON.stringify(raw)} is a value Headers.set refuses, so writing it ` +
        `onto a response throws. Accepted here it would boot a server that answers 500 to every ` +
        `request, with the csp missing and the other security headers present - refused at boot ` +
        `instead, before a port is bound`,
    );
  }
  return raw;
}

export function createSecurity(
  dev: boolean,
  env: { headers?: string; csp?: string } = {},
): Security | null {
  // fails towards the headers being on: unset, empty and unreadable all keep
  // them, and the last of the three refuses out loud rather than dropping them
  if (envBool("BORGO_SECURITY_HEADERS", env.headers, "every header on") === false) return null;
  const csp = cspSetting(env.csp);
  const enabled = csp !== false;
  const template =
    typeof csp === "string" ? csp : CSP_DEFAULT + (dev ? " 'unsafe-inline'" : "{nonce}");
  const withoutNonce = template.replaceAll("{nonce}", "");
  return {
    needsNonce: enabled && template.includes("{nonce}"),
    cspFor: (nonce) => template.replaceAll("{nonce}", ` 'nonce-${nonce}'`),
    apply(res) {
      const headers = res.headers;
      for (const [name, value] of STATIC_SECURITY) {
        if (!headers.has(name)) headers.set(name, value);
      }
      if (enabled && !headers.has("Content-Security-Policy")) {
        // rfc 9110 §8.3.1: type and subtype are case-insensitive. every
        // content-type borgo writes itself is already lowercase, but an
        // action or a loader guard may hand back a response typed by
        // whoever built it - and a document whose type reads TEXT/HTML is
        // still a document the csp has to cover
        const type = (headers.get("Content-Type") ?? "").toLowerCase();
        if (type.startsWith("text/html") || type.startsWith("image/svg+xml")) {
          headers.set("Content-Security-Policy", withoutNonce);
        }
      }
      return res;
    },
  };
}

// json destined for an inline <script>: escaping "<" neutralizes </script>
// and <!-- inside the block, u+2028/u+2029 are valid json but not valid js
// string content for every parser, so they travel escaped too. chained
// replaceAll beats a one-pass regex with a callback by ~20% in jsc.
export const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

// an action that logs in (or out) changes the jar mid-request: the loader that
// runs right after must be handed the cookies as they are now, not as the
// browser sent them. rebuilding that header means resolving duplicates, and
// every layer that resolves them differently is a way to swap a session - go
// rejects same-name cookies that disagree as ambiguous, so a jar rebuilt with
// a last-wins winner would hand go a single unambiguous cookie it would
// otherwise have refused. duplicates that disagree are dropped here too;
// identical ones are one cookie, and a Set-Cookie the api just issued settles
// the name whatever came in.
export function freshCookieHeader(cookieHeader: string | null, setCookies: string[]): string {
  const AMBIGUOUS = null;
  const jar = new Map<string, string | null>();
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (jar.has(name)) {
      if (jar.get(name) !== value) jar.set(name, AMBIGUOUS);
    } else {
      jar.set(name, value);
    }
  }
  for (const sc of setCookies) {
    const pair = sc.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    // go writes Max-Age=0 for any non-positive MaxAge, so this covers the
    // ClearSession(-1) that a logout action sends
    if (/;\s*max-age=0\b/i.test(sc)) jar.delete(name);
    else jar.set(name, pair.slice(eq + 1).trim());
  }
  const out: string[] = [];
  for (const [name, value] of jar) {
    if (value !== AMBIGUOUS) out.push(`${name}=${value}`);
  }
  return out.join("; ");
}

// "did we ever issue this browser a cookie of this name", regardless of what
// the value reads as. a check that switches itself off when the value is
// unusable is a check an attacker can switch off by making it unusable.
export function hasCookie(header: string | null, name: string): boolean {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return true;
  }
  return false;
}

export type CsrfOptions = {
  // on by default in production; BORGO_CSRF=1 forces the check in dev,
  // BORGO_CSRF=0 disables - serve() resolves the env once and passes this
  enforced: boolean;
};

// csrf: a double-submit token, issued as a cookie on rendered pages and
// required from form actions of requests carrying a session - a cross-site
// post cannot read the cookie to echo it in the form.
export async function csrfRejects(req: Request, { enforced }: CsrfOptions): Promise<boolean> {
  if (!enforced) return false;
  const cookies = req.headers.get("cookie");
  // enforced for any browser that has been issued a token, not only for
  // live sessions: otherwise a cross-site post can log the victim into
  // the attacker's account (login csrf). cookie-less clients (curl, api
  // consumers) are unaffected. presence, not value: a token shadowed by a
  // tossed duplicate reads as absent, and a browser that can be made to
  // look token-less is a browser the check no longer runs for.
  if (!hasCookie(cookies, "borgo_session") && !hasCookie(cookies, CSRF_COOKIE)) return false;
  // a sibling subdomain can drop a second borgo_csrf into the victim's jar;
  // whichever of the two a first-wins read picked, the attacker could make
  // it theirs and then echo it from a cross-site form. duplicates that
  // disagree are no token at all - the same call the browser runtime makes
  const expected = csrfCookieValue(cookies);
  // no token to compare against: reject without buffering and parsing the
  // body, which the action below would parse a second time anyway
  if (!expected) return true;
  // the clone looks like it buffers the body a second time, ahead of the
  // action's own formData(). it does not: bun's clone shares the body
  // store, and holding two clones of a 40mb request costs the same 40mb as
  // holding one (measured). what a single-parse rewrite would cost instead
  // is +40mb per 40mb request - arrayBuffer() materialises one copy and
  // every Request built over that buffer copies it again - plus the action
  // losing the real request's abort signal. the parse itself is the only
  // extra, and it is transient. read the token the same way the action
  // will: one parser, one answer. a cheaper hand-rolled scan of the raw
  // bytes would be a second parser disagreeing with the first about
  // percent-encoding, in the middle of a security check.
  let given = "";
  try {
    const form = await req.clone().formData();
    given = String(form.get(CSRF_FIELD) ?? "");
  } catch {}
  return !given || !keysEqual(given, expected);
}

// the same double-submit token, on the half of the surface a form field cannot
// reach: /api/* is proxied to go, its bodies are json, and nothing on that path
// has a hidden input to carry an echo. so the echo rides in a header - and that
// is not a lesser mechanism here, it is the stronger one. a cross-site *simple*
// form post is the one shape a browser sends with no preflight, and a form
// cannot set a custom header at all; a cross-site fetch that sets one is
// preflighted, and borgo grants no CORS approval for the preflight to win.
//
// what this is defending against, precisely: SameSite=Lax already stops the
// classic cross-*site* post. It does nothing about a same-site cross-origin
// attacker - a sibling subdomain, a stored xss on another host of the same
// registrable domain - for whom the browser sends every borgo cookie. That is
// the attacker this check is for, which is also why the arming below is the
// presence of the cookie rather than a readable value: cookie tossing is that
// same attacker's other primitive, and a check they can switch off by planting
// a duplicate is a check they have already beaten.
//
// so: armed by the token cookie's presence, exactly as the form-action check
// is. a browser that has rendered any borgo page carries it. curl, a mobile
// app and a server-to-server caller do not, and stay unaffected - the rule the
// docs already state for page actions, unchanged here. duplicates that
// disagree are no token, and a request holding no usable token is refused, not
// waved through. safe methods are never checked, and no body is ever read:
// this is decided on the request line and the headers alone.
export function apiCsrfRejects(req: Request, { enforced }: CsrfOptions): boolean {
  if (!enforced) return false;
  if (!unsafeMethod(req.method)) return false;
  const cookies = req.headers.get("cookie");
  if (!hasCookie(cookies, CSRF_COOKIE)) return false;
  const expected = csrfCookieValue(cookies);
  if (!expected) return true;
  const given = req.headers.get(CSRF_HEADER) ?? "";
  return !given || !keysEqual(given, expected);
}

/**
 * A whole non-negative number as the operator wrote it, or undefined when the
 * variable was never set. Same form as envBool below, deliberately: one
 * grammar, one refusal, one meaning for "unset".
 *
 * IT USED TO FLOOR, AND EVERY VARIABLE IT PARSES READS 0 AS "NO LIMIT AT ALL".
 * `BORGO_API_TIMEOUT=0.5` is an operator reaching for the tightest deadline they
 * can spell; floored to 0 it did not shorten the deadline, it REMOVED it - no
 * AbortController is created at 0 - and `BORGO_MAX_BODY=0.5` is the body limit
 * taken off the same way. The one repair borgo performed silently was the one
 * that could only ever move a limit towards off, in the direction nobody checks.
 *
 * So a fraction is refused by name rather than truncated. "0" remains the
 * documented way to disable a limit, and it is the ONLY way: unset (and "",
 * which is unset everywhere in this file) returns undefined, so the caller's
 * default is a value this function never invents.
 */
export function envInt(name: string, v: string | undefined, unsetMeans: string): number | undefined {
  if (envText(name, v) === undefined) return undefined;
  // `Number(" ")` is 0, and 0 is this limit switched off. A value made of
  // nothing but spaces is not a number an operator wrote, it is a variable that
  // came out blank - and it must not be the way a limit gets removed
  const n = v!.trim() === "" ? Number.NaN : Number(v);
  // -0 is zero and leaves here spelled as zero: it passes `>= 0` and
  // `Number.isInteger`, and Bun.serve then answers "expects idleTimeout to be
  // an integer" and the boot dies. Only Object.is can tell the zeroes apart,
  // so the normalisation happens once, here, rather than at each use.
  if (Number.isInteger(n) && n >= 0) return n === 0 ? 0 : n;
  const truncated = Number.isFinite(n) && n > 0 && !Number.isInteger(n);
  throw new Error(
    `borgo: ${name}: invalid value ${JSON.stringify(v)} (want a whole number, 0 or more` +
      (truncated
        ? `; rounding it down would reach ${Math.floor(n)}` +
          (Math.floor(n) === 0 ? `, which is this limit switched off - the opposite of what was asked for` : "")
        : "") +
      `; unset means ${unsetMeans})`,
  );
}

/**
 * The changed files a dev rebuild hands to the front server, and from there to
 * every connected browser.
 *
 * A newline separates them: a path may contain a comma or a space, and none of
 * the paths a watcher reports can contain a newline. One file used to travel
 * here, which meant two saves inside one debounce window announced one of them
 * and the browser - which ignores an update naming a page other than the one on
 * screen - could silently apply nothing at all.
 */
export const UNKNOWN_CHANGE = "__borgo_unknown__";

export const encodeChanged = (files: readonly string[]): string => files.join("\n");

export const decodeChanged = (value: string | undefined): string[] =>
  value ? value.split("\n").filter(Boolean) : [];

/**
 * The inbound read deadline, in seconds - and only that.
 *
 * There are two clocks here and they are not the same clock:
 *
 *   1. how long the server waits for a *request* to arrive. This is a
 *      slowloris control and it has to be a real number: a POST that declares
 *      a Content-Length and then dribbles one byte held the front server
 *      indefinitely, and every path that reads a body parks on it.
 *   2. how long a *response* may live. This one has no honest bound. An event
 *      stream is idle between events; so is an `application/x-ndjson` feed, a
 *      long poll answering `application/json`, a chunked report, a gRPC-web
 *      call, a stalled `/api` download, a streamed document whose suspense
 *      boundary is waiting on a query, and an upstream that needs six seconds
 *      to produce its headers. None of those is a client holding a socket
 *      open. They are the server working.
 *
 * bun has one knob for both: `idleTimeout` is per connection and covers the
 * request read and the response write alike. So the knob is clock 1, and clock
 * 2 is not expressed by touching the knob at all. borgo KEEPS THE SOCKET WARM:
 * while a response is still in flight it re-arms a SHORT deadline every couple
 * of seconds, and it never disarms, never raises, and never touches a request
 * that finished before the first sweep. `createKeepWarm` below is the
 * mechanism, `keepWarmSeconds` the value, `requestFullyRead` and the proxy's
 * `onBodyRead` the two moments a request is known to be in hand.
 *
 * Two designs were tried against real sockets before this one and both were
 * falsified, in the same direction each time - they bought clock 2 by weakening
 * clock 1 for the whole connection.
 *
 *   - `server.timeout(req, 0)`, removing the deadline, under a comment claiming
 *     the next request on the same keep-alive connection would bring it back.
 *     Measured on bun 1.3.14: true of a next request that is not ITSELF lifted
 *     (idleTimeout 8, lift the first only: closed at 8.0s) - and every request
 *     borgo lifted qualified, so the mitigation never applied to borgo's own
 *     traffic (lift both of two: still open at 26s). An attacker simply never
 *     sends a next request: one 40-byte GET per file descriptor, held until the
 *     process restarts.
 *   - raising it to a finite ceiling instead. The connection carries the raised
 *     value into whatever follows, and bun re-arms on request COMPLETION, not
 *     on first byte - so an attacker who sends one complete GET and then
 *     dribbles an unfinished request inherits the ceiling. Measured with a 255s
 *     ceiling at BORGO_FRONT_READ_TIMEOUT=8: a fresh connection dribbling
 *     headers died at 12.0s, the same dribble after one `GET /healthz` survived
 *     to 256.4s. A ceiling trades the size of the hole for its shape.
 *
 * Six properties of the knob, all measured, none reasoned about:
 *
 *   1. it is a real IDLE timer - socket activity re-arms it. Under
 *      `idleTimeout: 8`, with no exemption of any kind, a response writing every
 *      2s ran a 24s stream to completion and closed at 30.1s, one sweep after
 *      the last write; a client sending a request every 1s stayed connected past
 *      26s. So an actively writing response never needed an exemption. The only
 *      thing that ever did is a response that has STARTED writing and then goes
 *      quiet longer than the deadline.
 *   2. THE DEAD ZONE BELONGS TO THE NUMBER BEING ARMED, NOT TO THE CONNECTION.
 *      Any arming of 4 seconds or less does nothing at all and the connection
 *      dies at the next 4s boundary; any arming of 5 or more takes. It does not
 *      matter who arms it or what `idleTimeout` the server was built with - a
 *      socket write re-arms to `idleTimeout`, a `server.timeout(n)` call re-arms
 *      to `n`, and each is judged on its own number. Measured against a 20s
 *      silent stream: at `idleTimeout: 30` a keep-warm arming 3 or 4 was cut,
 *      arming 5 or 12 survived; at `idleTimeout` 1, 2, 3, 4 and 5 a keep-warm
 *      arming 12 survived, 5 for 5. And with no keep-warm at all, a stream
 *      writing every 2s delivered 1 of 8 events at `idleTimeout` 3 and 4 and all
 *      8 at 5, 6 and 8 - the same boundary, applied to the value a write re-arms.
 *
 *      This note has been wrong twice, in the same direction both times, and the
 *      corrections are the reason the design looks as it does. It first said a
 *      value rounding to a single 4s sweep "can never be re-armed", blaming the
 *      wheel's granularity; that conflated the two mechanisms and put the
 *      boundary at 5 instead of 4, which switched the keep-warm off at exactly 5
 *      and handed back the silent truncation it exists to prevent. The fix for
 *      THAT then read the boundary as a property of `idleTimeout` and clamped
 *      the operator's knob up to 5 - which was unnecessary, since the keep-warm
 *      arms its own number, and harmful, since it funnelled every tight setting
 *      onto the one with the least margin. Every early measurement in this file
 *      was taken at `idleTimeout: 3`, inside the dead zone, where the knob looks
 *      like a hard cap on the whole exchange. State the env value AND the armed
 *      value with every number.
 *   3. silence BEFORE the first response byte is not cut at all: at
 *      BORGO_FRONT_READ_TIMEOUT=30 an upstream that stalled 38s was still
 *      answered, at 38.06s. The slow-upstream case this exemption was originally
 *      built for does not exist above the degenerate values.
 *   4. `server.timeout(req, n)` lands while the exchange is live - from `fetch`
 *      or from a timer during the response - and re-arms from the moment of the
 *      call. Once the exchange is over it does not land at all: lifted to 0 and
 *      re-armed 200ms later, a connection was still open at 26s. Nothing can be
 *      restored afterwards, so any design that needs to restore is already dead.
 *   5. an incomplete request on a FRESH connection is bun's own, bounded at 12.0s
 *      and invariant - 12.01s / 12.00s / 12.01s at idleTimeout 1, 5 and 30. On a
 *      connection that has already completed a request it is the knob's: 8.0s at
 *      T=8, 32.06s at T=30, untouched. That 12s invariant is where
 *      KEEP_WARM_SECONDS comes from.
 *   6. `server.requestIP(req)` returns null the moment bun is done with the
 *      exchange, and keeps returning an address for as long as the response is
 *      in flight. It is the end-of-exchange signal bun otherwise does not offer -
 *      `req.signal` never fires on a clean finish.
 *
 * (1) and (3) shrink clock 2 to one case; (4) says it cannot be handled after
 * the fact; (5) says any value left on the connection is inherited by the next
 * unfinished request; (6) says when to stop. Keeping the socket warm is what is
 * left: re-arm a short deadline while the response is live, stop when it is
 * over, and leave behind bun's own 12s and never more. A request that
 * ended before its first sweep is never touched, so ordinary traffic is
 * byte-for-byte bun's untouched behaviour - measured, an idle connection after
 * one fast GET closed at 8.01s under T=8 and 32.03s under T=30, against 8.02s
 * and 32.06s for a server that calls nothing.
 *
 * What the design costs. A response that stops writing is held for as long as
 * the application keeps its stream open: the keep-warm cannot tell a live
 * subscriber from a client that stopped reading without closing, and
 * deliberately does not try, because the alternative is truncating live feeds.
 * An ordinary disconnect is still handled, since (6) evicts the moment bun sees
 * the socket end.
 *
 * Every value of BORGO_FRONT_READ_TIMEOUT is honoured verbatim except one below
 * a whole second, and P2 HAS NO CONFIG EXEMPTION - no setting of the operator's
 * knob switches the keep-warm off or narrows its margin, because the keep-warm
 * no longer reads that knob for anything but "is there a deadline at all". Two
 * revisions got that wrong in the same direction: one left the keep-warm inert
 * below a floor, so any value in that range silently gave the truncation back
 * (measured at 5: `GET /api/sse` with a 20s gap answered `HTTP/1.1 200 OK` and
 * then nothing, no events, no terminator, indistinguishable from an empty feed);
 * the next clamped the knob up to that floor instead, which routed every tight
 * setting onto the configuration with the least margin against a stalled event
 * loop. A control whose safety depends on the operator not choosing a particular
 * number is not a control. See KEEP_WARM_SECONDS.
 *
 * A form action's own render is not kept warm: its body is read by
 * `runAction`, not by the proxy, so nothing tells this side the request landed.
 * That is the pre-existing cost and it is unchanged.
 *
 * Content-Type was tried as the discriminator and was wrong in kind. An
 * allowlist of `text/event-stream` and `multipart/x-mixed-replace` truncates
 * every other long-lived response at the deadline - measured with
 * `idleTimeout: 3` and a stream idle 8s mid-body, `application/x-ndjson` was
 * cancelled server-side at ~3s and the connection closed at 4.0s, and the
 * client saw a *truncated 200*, not an error.
 *
 * bun caps idleTimeout at 255 seconds and rejects anything larger.
 */
export const READ_TIMEOUT_SECONDS = 30;
export const READ_TIMEOUT_MAX = 255;
// The smallest arming bun acts on, measured (property 2 above). It is NOT a
// floor on this knob: the operator's value bounds a client that has not finished
// sending, and the keep-warm arms its own number, so a 1s slowloris bound is
// honoured exactly and its streams are still kept alive at KEEP_WARM_SECONDS.
// What it does bound is anything that arms the operator's number directly - a
// socket write - which is why a response NOT covered by the keep-warm is cut
// below 5. Named so the tests can say which boundary they are standing on.
export const WHEEL_MIN_ARMED_SECONDS = 5;

/**
 * BORGO_FRONT_READ_TIMEOUT: this side's own name, in seconds.
 *
 * It used to read BORGO_IDLE_TIMEOUT, which is the go api's - go parses that
 * one with `time.ParseDuration` and panics on anything it cannot read. The
 * systemd unit and the compose file put both processes in one environment
 * block, so the documented `BORGO_IDLE_TIMEOUT=2m` gave go two minutes and
 * gave the front server a silent 30 seconds, while `BORGO_IDLE_TIMEOUT=120`
 * panicked the go api at boot. One name, two grammars, two meanings.
 *
 * The first fix for that renamed this side's knob to BORGO_READ_TIMEOUT, which
 * `newServer` in borgo.go ALSO reads, also with `time.ParseDuration`, also
 * panicking. That is the same defect under a new spelling: `=45` boots the
 * front server on forty-five seconds and stops the go binary from starting at
 * all, `=45s` gives go forty-five seconds and silently leaves this side on its
 * default 30. Renaming a collision moves it; it does not close it. The name
 * has to be one no other half reads, which is what FRONT says - and
 * `envNamesDoNotCollide` in util.test.ts fails the build if a later edit points
 * either grammar back at the other's variable.
 *
 * Neither older name is honoured as an alias, here or anywhere: an alias kept
 * for compatibility is an alias that keeps the collision alive.
 */
// A TIGHTENING MUST NEVER BECOME A DISABLING. The deadline is whole seconds, so
// `=0.5` had to become something; flooring made it 0, which is the documented
// "no deadline at all" - the operator who reached for the strictest setting
// turned the control off (measured at 0.5: a dribbled body still connected at
// 45s, against 8.0s at 8). Every fraction is therefore rounded down but never
// below one second, which is the smallest thing this side can say.
//
// Nothing else is moved. An earlier revision raised everything under five here,
// on the theory that bun cannot re-arm below that - which was measured on the
// wrong variable. The dead zone belongs to the NUMBER BEING ARMED, not to the
// connection's configured timeout (property 2), and the keep-warm arms its own
// number. So 1 through 4 are honoured exactly as written.
const wholeSeconds = (raw: string | undefined): number | null => {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n) || n <= 0 || Number.isInteger(n)) return null;
  return Math.min(Math.max(1, Math.floor(n)), READ_TIMEOUT_MAX);
};

export function readTimeout(env: Record<string, string | undefined>): number {
  const rounded = wholeSeconds(env.BORGO_FRONT_READ_TIMEOUT);
  if (rounded !== null) return rounded;
  // THE ONE VARIABLE THAT FALLS BACK INSTEAD OF REFUSING, AND WHY IT MAY.
  // envInt throws, because the limits it parses read 0 as "off" and their
  // fallback direction is the weak one. This value's is not: every reading
  // borgo cannot parse lands on READ_TIMEOUT_SECONDS, which is a deadline that
  // APPLIES, and the fraction that could have reached 0 was already caught
  // above. It is also read below serve-entry's `try`, so a throw here would be
  // answered from the fallback server's bound port - the very shape
  // resolveSwitches exists to close. One grammar, two dispositions, both said
  // out loud. The name is spelled out rather than passed as a local because
  // envNamesDoNotCollide in util.test.ts reads this file for `envInt("NAME"`,
  // and a name hidden behind a variable is a name that guard cannot see.
  let asked: number | undefined;
  try {
    asked = envInt("BORGO_FRONT_READ_TIMEOUT", env.BORGO_FRONT_READ_TIMEOUT, `${READ_TIMEOUT_SECONDS}s`);
  } catch {
    return READ_TIMEOUT_SECONDS;
  }
  return Math.min(asked ?? READ_TIMEOUT_SECONDS, READ_TIMEOUT_MAX);
}

// A value borgo moved is a value the operator has to hear about, or the next
// person reads the unit file and believes it. Returned rather than printed:
// readTimeout is called from several places and on every request path, and a
// warning that fires per call is a warning nobody reads.
export function readTimeoutNotice(env: Record<string, string | undefined>): string | null {
  const raw = env.BORGO_FRONT_READ_TIMEOUT;
  const rounded = wholeSeconds(raw);
  if (rounded === null) return null;
  return (
    `BORGO_FRONT_READ_TIMEOUT=${raw} read as ${rounded}s ` +
    `(the read deadline is whole seconds; rounding down to 0 would have been ` +
    `the documented "no deadline at all" - the opposite of what was asked for)`
  );
}

export const KEEP_WARM_INTERVAL_MS = 2_000;

/**
 * WHAT THE KEEP-WARM RE-ARMS TO, AND WHY IT IS NOT THE OPERATOR'S NUMBER.
 *
 * These are two clocks and they answer two different questions. The operator's
 * BORGO_FRONT_READ_TIMEOUT bounds A CLIENT THAT HAS NOT FINISHED SENDING - it is
 * the slowloris control. This one only ever applies to a request that is already
 * FULLY RECEIVED, which by definition is not a slowloris; it bounds how long the
 * server may be quiet while answering. An earlier revision computed this as
 * `min(readTimeout, 12)` and so fused them back together, which had two costs,
 * one of them the same mistake as the original lift, one level down:
 *
 *   - it made the margin equal to whatever the operator set. The sweep is a JS
 *     timer, so it runs late when the event loop is busy, and a connection
 *     survives a stall only on the armed time it is already carrying. At T=5
 *     that is 5 seconds against a 4-second wheel - the least margin of any
 *     setting. A verifier measured a live stream truncated 2/2 at T=5 under a
 *     17.5s and a 24.2s loop stall from twelve concurrent renders, against 0/3
 *     at T=30 (re-arm 12) with comparable and larger stalls. The client had
 *     already had `200 OK` and `: open`, so EventSource just reconnects.
 *   - it then funnelled every value below the old floor ONTO that worst setting.
 *
 * So the keep-warm gets its own constant. 12 is not a taste: it is exactly bun's
 * own bound on an incomplete request on a fresh connection, measured invariant
 * at idleTimeout 1, 5 and 30 (12.01s / 12.00s / 12.01s). That is the ceiling
 * because whatever the keep-warm leaves on a connection is inherited by the next
 * unfinished request on it (property 5), and at 12 that leftover never grants an
 * attacker anything a second socket would not have given them for free. It is
 * also the floor worth having, being the largest such value - the margin
 * argument wants as much as the ceiling allows.
 *
 * Decoupling is what makes the tight settings safe rather than merely allowed:
 * arming 12 keeps a 30s silent stream alive at idleTimeout 1, 2, 3, 4 and 5
 * alike (measured, 5/5), because the dead zone belongs to the armed number.
 *
 * WHAT IT DOES NOT REACH, and this one is a decision rather than an accident:
 *
 *   - A SILENT STREAM CAN STILL BE TRUNCATED BY A STARVED EVENT LOOP, RARELY.
 *     Measured: 24 concurrent SSR renders of a 600,000-row loader payload,
 *     against one SSE stream held silent 45s, at BORGO_FRONT_READ_TIMEOUT=5 -
 *     one truncation in the TWO runs at that load, a 19,878ms event-loop stall,
 *     connection closed at 23.71s with no terminating chunk, after the client
 *     had already received `200 OK` and `: open`. The lighter attack that broke
 *     the previous design - twelve concurrent renders of a 400,000-row payload -
 *     did not truncate in seven runs across T=3, T=5 and T=30 (stalls
 *     14,994-17,375ms), where the previous design truncated 2/2 at 17,494ms and
 *     24,216ms. Quote the denominator with the load it belongs to: the two are
 *     different experiments and averaging them reads as ~8% when the number at
 *     the heavy load is one in two and at the lighter one is none in seven.
 *
 *     IT IS NOT MONOTONIC IN STALL LENGTH, which is the part that misleads. A
 *     57,680ms stall at the same setting did NOT truncate. That much is
 *     measured; the explanation that fits it - nobody has instrumented bun's
 *     timer wheel - is that a fully blocked loop freezes the wheel alongside the
 *     sweep, and a frozen wheel expires nothing, so the total block protects the
 *     connection. What would then kill is the PARTIALLY STARVED regime in
 *     between, where the wheel still fires but the sweep has not been given a
 *     turn to re-arm. Either way the observation stands: this is a stochastic
 *     interleaving and not a threshold, there is no stall length above which it
 *     happens, and looking for one will waste the time it wasted here.
 *
 *     There is no setting that avoids it. After the first sweep the armed number
 *     is KEEP_WARM_SECONDS at every setting of the operator's knob, so there is
 *     nothing to tune and raising the read timeout does not help - though under
 *     the PREVIOUS design it did, because the armed value was min(read, 12) and
 *     so derived from theirs; removing that coupling is what this change was.
 *     Configuration-independence here is what the mechanism predicts rather than
 *     something demonstrated: no matched control at T=30 could be produced,
 *     because both runs at that load landed in the fully-blocked regime.
 *
 *     NO VERSION OF THIS DESIGN CAN CLOSE IT, which is why it is written down
 *     instead of chased. The keep-warm is a JavaScript timer, so a loop with no
 *     turn to give cannot run it, and the one alternative - arm high, come back
 *     down afterwards - is dead on property 4: a `server.timeout` applied once
 *     the exchange is over does not land at all. Closing this would take a bound
 *     bun applies from outside the loop, which bun does not expose. Raising
 *     KEEP_WARM_SECONDS is not that bound and costs the leftover guarantee.
 *
 *     HOW IT PRESENTS: a truncated 200 that `EventSource` silently reconnects
 *     from, indistinguishable from a complete response to anyone not counting
 *     bytes. That is also how the class of bug this whole file is about
 *     presented, which is the reason for saying so out loud. docs/realtime.md
 *     carries the same entry for the reader running the stream.
 */
export const KEEP_WARM_SECONDS = 12;

export function keepWarmSeconds(env: Record<string, string | undefined>): number {
  // 0 is the only thing the operator's knob still decides here: they turned the
  // deadline off outright, so there is nothing to keep warm against. Every other
  // value gets the same constant, and `theTwoClocksAreNotTheSameNumber` in
  // util.test.ts fails the build if a later edit couples them again.
  return readTimeout(env) === 0 ? 0 : KEEP_WARM_SECONDS;
}

// only what the keep-warm needs of a Bun.Server, so a test can hand it a fake
// and count the calls
export type DeadlineHost = {
  timeout(req: Request, seconds: number): void;
  requestIP(req: Request): unknown;
};

/**
 * Keeps in-flight responses warm without ever disarming the deadline.
 *
 * A request is HELD only once it is known to be in hand. Every sweep, a held
 * request is either evicted - `requestIP` has gone null, so bun is done with
 * the exchange and nothing could be set on it anyway (property 4) - or re-armed
 * at `seconds`. A request that ends before its first sweep is evicted having
 * never been touched, which is why ordinary traffic behaves exactly as it does
 * on a server that calls nothing.
 *
 * HOW THIS FAILS IF IT IS WRONG, in the three directions that matter:
 *
 *   - if `requestIP` ever stops going null at end of exchange, nothing is ever
 *     evicted: the set grows without bound and every connection that served one
 *     request is re-armed forever. That is P3 broken again, and worse than the
 *     ceiling was. The test for it watches an idle connection AFTER a
 *     kept-warm exchange, not after a fast one.
 *   - if a sweep ever falls further apart than the wheel tolerates for
 *     `seconds`, a live stream is cut and the client sees a truncated 200 - the
 *     invisible failure. The test for it runs a stream silent far longer than
 *     the deadline and asserts the terminator arrived.
 *   - if `hold` is ever reached by a request still arriving, a slowloris is
 *     kept warm by the very thing meant to bound it. The test for it dribbles a
 *     body and asserts the cut.
 *
 * And the one that produced the original bug - the event that simply never
 * happens: a response that never ends. It is held for as long as the
 * application keeps its stream open, on purpose. Nothing here tries to
 * distinguish a live subscriber from a client that stopped reading without
 * closing, because the only way to do that is to truncate feeds.
 */
export function createKeepWarm(
  // a thunk, not the server: this is built before Bun.serve returns, so that a
  // request arriving the instant bun starts listening cannot reach a binding
  // still in its temporal dead zone. It also leaves `server.timeout` named in
  // exactly one file, which is what the structural guard in util.test.ts
  // checks - the front server must not be able to weaken a deadline directly.
  getHost: () => DeadlineHost,
  seconds: number,
  intervalMs: number = KEEP_WARM_INTERVAL_MS,
): { hold(req: Request): void; held(): number; stop(): void } {
  if (seconds <= 0) return { hold: () => {}, held: () => 0, stop: () => {} };
  const inFlight = new Set<Request>();
  const timer = setInterval(() => {
    if (!inFlight.size) return;
    const host = getHost();
    for (const req of inFlight) {
      if (host.requestIP(req) === null) inFlight.delete(req);
      else host.timeout(req, seconds);
    }
  }, intervalMs);
  // the sweep must not be a reason for the process to stay up
  timer.unref?.();
  return {
    hold: (req) => void inFlight.add(req),
    held: () => inFlight.size,
    stop: () => clearInterval(timer),
  };
}

/**
 * Whether nothing is left for a client to dribble at us.
 *
 * Two things have to hold and only one of them is bun's. This used to be just
 * `req.body === null`, on the reasoning that bun hands a body-less request a
 * null body - which it does, and also hands one to a request that is still
 * arriving. bun discards bodies on GET and HEAD, so a `GET` carrying
 * `Content-Length: 100` with one byte sent arrives at the handler as
 * `body === null`, and so does a GET with an unterminated
 * `Transfer-Encoding: chunked` stream (both measured on bun 1.3.14). The
 * predicate reported "entirely in hand" while the client still held 99 bytes:
 * against the real server, `GET /healthz` + `Content-Length: 100` dribbling a
 * byte every 2.5s was answered 200 and held past 12s, where the same dribble on
 * `DELETE /api/echo` was cut at 4.0s.
 *
 * So the request also has to have declared nothing more: no Transfer-Encoding
 * at all, and a Content-Length that is absent or exactly zero. That second half
 * reads a client-supplied header, which is safe here for one reason only - it
 * can only ever WITHHOLD the exemption. A forged length keeps the deadline; it
 * cannot remove it. Every shape that is not plainly "no body" is therefore read
 * as a body still coming: absent is in hand, `0` is in hand, and empty,
 * non-numeric, signed, or the `"100, 100"` bun passes through when the header
 * arrives twice with the same value are all out (a conflicting pair, and a
 * single header holding a comma, bun rejects itself before `fetch` is called).
 * Transfer-Encoding is refused on presence, whatever it says and however it is
 * cased, since every value of it means a body framed by something other than a
 * length we can check.
 */
export function requestFullyRead(req: Request): boolean {
  if (req.body !== null) return false;
  if (req.headers.get("transfer-encoding") !== null) return false;
  const declared = req.headers.get("content-length");
  return declared === null || /^0+$/.test(declared.trim());
}

/**
 * Whether /metrics is exposed.
 *
 * The name is prefixed for a reason: a bare `METRICS` is the single most
 * collidable variable borgo ever read, and a neighbouring process in the same
 * environment has every right to its own. It was `METRICS` before 0.21 and the
 * old name is not honoured - an alias kept for compatibility is an alias that
 * keeps the collision alive.
 */
export function metricsEnabled(env: Record<string, string | undefined>): boolean {
  // it tested === "1", so BORGO_METRICS=true served 404 on the endpoint it
  // names. not a fail-open, but an explicit instruction the server dropped in
  // silence - and the operator debugs a scrape, not a variable
  return envBool("BORGO_METRICS", env.BORGO_METRICS, "off") ?? false;
}

/**
 * Dev mode, resolved once for the whole process.
 *
 * `!!process.env.BORGO_DEV` tested the variable's PRESENCE, not its value, so
 * BORGO_DEV=0 turned dev ON: csrf off by default, the csp relaxed to
 * 'unsafe-inline', the dev websocket channel open and __BORGO_DEV__ injected
 * into every page - measured on a production build. Whoever writes `=0` means
 * the exact opposite of what they got, and this is the switch that OVERRIDES
 * the csrf default the BORGO_CSRF fix just repaired: mending the variable and
 * leaving in place the flag that decides its default is mending nothing.
 *
 * It refuses a value it cannot read rather than picking a side, and here the
 * refusal is worth more than elsewhere. Nothing outside borgo sets this - the
 * dev loop writes "1" (dev.ts) and no one else is meant to - so a value it
 * cannot read did not come from borgo, and both readings of it are bad in a
 * way nobody would notice: guessing "dev" weakens a production server, guessing
 * "production" hands a developer a session with no reload channel and a
 * confusing service worker. Refusing names the variable, at boot, before a port
 * is bound. An unset variable still means production, because the absence of a
 * decision must never be the weaker of the two.
 */
export const devMode = (env: Record<string, string | undefined>): boolean =>
  envBool("BORGO_DEV", env.BORGO_DEV, "production") ?? false;

// BORGO_RELOAD marks a restart so the banner prints its short form. Tested for
// presence, so `=0` read as "yes". Cosmetic on its own; a switch that ignores
// what the operator wrote teaches them the variable does not work.
export const reloadBanner = (env: Record<string, string | undefined>): boolean =>
  envBool("BORGO_RELOAD", env.BORGO_RELOAD, "the full banner") ?? false;

// SESSION_SECURE decides whether the session and csrf cookies carry Secure,
// and the two halves have to agree on what it says. Go parses it with
// strconv.ParseBool and refuses what it cannot read; this side tested === "1",
// so SESSION_SECURE=true gave the session cookie Secure and left the csrf
// cookie without it - one variable, one intent, two answers, silently, in the
// direction that downgrades. Same grammar as ParseBool, same refusal.
const BOOL_TRUE = ["1", "t", "T", "true", "TRUE", "True"];
const BOOL_FALSE = ["0", "f", "F", "false", "FALSE", "False"];

// the same grammar as a question rather than a decision. BORGO_CSP is a switch
// AND a value, so it has to be able to ask "is this spelled like a boolean"
// without refusing every policy that is not one.
export const boolish = (v: string): boolean | undefined =>
  BOOL_TRUE.includes(v) ? true : BOOL_FALSE.includes(v) ? false : undefined;

/**
 * THE ONE RULE, FOR ALL SEVEN VARIABLES: A CONTROL CHARACTER IS REFUSED AT
 * BOOT, NAMING THE VARIABLE AND SHOWING THE BYTE.
 *
 * It was one rule in six places and a different one in the seventh. `\r` - what
 * every line of a .env file authored on windows carries - made `BORGO_DEV=0\r` a
 * boot failure, while `BORGO_CSP=default-src 'self'\r` was ACCEPTED and bun
 * trimmed the CR in silence (measured: Headers.set stores a trailing CR, LF and
 * CRLF alike, dropping them, and stores VT, FF and BEL verbatim). One byte,
 * fatal in six variables and invisible in the seventh, is a rule the operator
 * cannot learn.
 *
 * The direction is the one the rest of this file already takes: refuse rather
 * than normalise. A value borgo silently repaired is a value the operator goes
 * on believing they wrote, and the repair is only ever obvious to whoever wrote
 * the repair. Refusing costs one boot and names the character; trimming costs
 * nothing today and hides whatever arrives in that byte tomorrow.
 *
 * Returns the value, or undefined when the variable was never set - "" is unset,
 * uniformly, because a variable exported empty is a variable nobody assigned.
 */
export function envText(name: string, v: string | undefined): string | undefined {
  if (v === undefined || v === "") return undefined;
  // C0 and DEL. JSON.stringify below is what makes them visible; the message
  // must never carry the raw byte, or a CR returns the cursor and overwrites
  // the half of the line naming the variable
  const at = v.search(/[\u0000-\u001f\u007f]/);
  if (at === -1) return v;
  throw new Error(
    `borgo: ${name}: invalid value ${JSON.stringify(v)} ` +
      `(a control character at position ${at}; a trailing \\r is what a .env file ` +
      `authored on windows puts on every line - strip it rather than letting borgo guess)`,
  );
}

/**
 * A boolean switch as go's strconv.ParseBool reads it, or undefined when it was
 * never set. Refuses what it cannot read rather than picking a side: a value
 * nobody can parse is a value whose author had an intent, and guessing it wrong
 * is how `=true` came to mean off.
 *
 * Every switch borgo reads goes through here, and `every boolean env switch
 * reads one grammar` in util.test.ts enumerates all of them against one
 * alphabet - because repairing BORGO_CSRF alone left five others, one of which
 * (BORGO_DEV) decided BORGO_CSRF's own default.
 */
export function envBool(name: string, v: string | undefined, unsetMeans: string): boolean | undefined {
  if (envText(name, v) === undefined) return undefined;
  const parsed = boolish(v as string);
  if (parsed !== undefined) return parsed;
  // JSON.stringify, not quotes: the value that reaches here is most often a
  // .env line read on windows, whose trailing \r would otherwise return the
  // cursor to the start of the message and overwrite the half naming the
  // variable. an operator has to be able to SEE the character that was refused
  throw new Error(
    `borgo: ${name}: invalid value ${JSON.stringify(v)} ` +
      `(want "1"/"true" or "0"/"false"; unset means ${unsetMeans})`,
  );
}

export function sessionSecure(env: Record<string, string | undefined>): boolean {
  return envBool("SESSION_SECURE", env.SESSION_SECURE, "not secure") ?? false;
}

// on in production, off in dev, BORGO_CSRF decides either way. It tested
// === "1" once, so BORGO_CSRF=true turned off the check it names
export const csrfEnabled = (dev: boolean, env: Record<string, string | undefined>): boolean =>
  envBool("BORGO_CSRF", env.BORGO_CSRF, dev ? "off in dev" : "on") ?? !dev;

// how long borgo waits for the go api's response headers, and how big a request
// body it will take, both 0 for "no limit". They are defaults, not policy: the
// arguments for the numbers are on their reads in server.ts.
export const API_TIMEOUT_MS = 30_000;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

export type Switches = {
  dev: boolean;
  security: Security | null;
  csrfEnforced: boolean;
  csrfCookieAttrs: string;
  metrics: boolean;
  reloading: boolean;
  // ms and bytes. Resolved here rather than where they are used, because envInt
  // now refuses what it cannot read and a refusal read inside serve() would be
  // caught by serve-entry's try and answered from the fallback server's bound
  // port - the whole reason this function exists.
  apiTimeout: number;
  maxBody: number;
  // whether a /ws handshake carrying no Origin at all may upgrade. Off: a
  // browser always sends one, so "absent" is a non-browser client, and the
  // check exists to keep a cross-origin *browser* out. See the /ws handler for
  // when to turn it on.
  wsAllowNoOrigin: boolean;
};

/**
 * EVERY SWITCH, RESOLVED IN ONE PLACE, BEFORE ANY PORT CAN BE BOUND.
 *
 * A REFUSAL THAT ARRIVES FROM A SERVER ALREADY LISTENING IS NOT A REFUSAL. That
 * argument was written on server.ts's BORGO_RELOAD read and was true of exactly
 * one variable: BORGO_DEV was resolved above serve-entry's `try`, and every
 * other switch was read INSIDE `serve()`, whose throw the catch turns into a
 * fallback server. Measured on the socket with `BORGO_DEV=1 BORGO_CSP=yes`: port
 * bound, process alive, and every request answered 500 with `x-borgo-fallback:
 * 1` and NO csp, NO X-Frame-Options, NO nosniff, NO Referrer-Policy - a value
 * borgo refused, serving on the port it refused to serve on, with strictly fewer
 * security headers than a server that had accepted it.
 *
 * So this is the whole class, not the one variable: an unreadable value cannot
 * reach the fallback path if it was already read before the try. serve-entry
 * calls this above its `try` and hands the answers to `serve()`; `serve()` falls
 * back to calling it itself for the entry points that have no fallback at all
 * (`borgo start`, `borgo export`), so there is one resolution either way and
 * never two readings of one intent.
 *
 * `dev` is a parameter rather than a read because it is the one switch a caller
 * overrides: `borgo start` and `borgo export` serve production whatever
 * BORGO_DEV says. Everything derived from dev - the csp's nonce-vs-unsafe-inline
 * and the csrf default - is derived from that same answer.
 */
export function resolveSwitches(
  env: Record<string, string | undefined>,
  dev: boolean = devMode(env),
): Switches {
  return {
    dev,
    security: createSecurity(dev, { headers: env.BORGO_SECURITY_HEADERS, csp: env.BORGO_CSP }),
    csrfEnforced: csrfEnabled(dev, env),
    csrfCookieAttrs: `Path=/; SameSite=Lax${sessionSecure(env) ? "; Secure" : ""}`,
    metrics: metricsEnabled(env),
    reloading: reloadBanner(env),
    apiTimeout: envInt("BORGO_API_TIMEOUT", env.BORGO_API_TIMEOUT, `${API_TIMEOUT_MS}ms`) ?? API_TIMEOUT_MS,
    maxBody: envInt("BORGO_MAX_BODY", env.BORGO_MAX_BODY, `${MAX_BODY_BYTES} bytes`) ?? MAX_BODY_BYTES,
    wsAllowNoOrigin: envBool("BORGO_WS_ALLOW_NO_ORIGIN", env.BORGO_WS_ALLOW_NO_ORIGIN, "refused") ?? false,
  };
}

/**
 * Who may POST /__borgo/publish.
 *
 * BORGO_PUSH_KEY has to hold on both halves, and the two failure directions
 * were not symmetric. Set on the front server only: the api sends no key, every
 * push is refused - visible, and closed. Set on the api ONLY: this side never
 * looked at the header at all and fell straight through to the loopback rule,
 * so every push was accepted and the operator had a setting that reads as
 * authentication and authenticates nothing.
 *
 * Loopback is not that rule's equal. `borgo start` puts both halves on one host,
 * so "came from 127.0.0.1" admits every other process on the box, every
 * container sharing the network namespace, and every other tenant of a shared
 * one - and /__borgo/publish relays whatever it is given to every browser
 * subscribed to the topic.
 *
 * So a presented key is the api's statement that key auth is in force, and a
 * side that cannot check it refuses rather than quietly applying the weaker
 * rule. The asymmetry now fails the same way round whichever half is
 * misconfigured, and says so on the way past.
 *
 * With a key on both sides the loopback and forwarding checks do not apply:
 * cross-host push is the entire reason the key exists.
 */
export type PushVerdict = "ok" | "bad-key" | "half-configured" | "not-local";

/**
 * Did any hop stamp this request on its way here.
 *
 * PRESENCE, NEVER CONTENT. The loopback rule was disarmed by a header the
 * caller writes: `X-Forwarded-For:` with an empty value read as falsy, so
 * `!forwarded` said "nothing forwarded this" about a request that arrived
 * carrying a forwarding header, and `?? ` made it worse - an empty
 * X-Forwarded-For is not null, so it satisfied the coalesce and MASKED a real
 * `Forwarded:` behind it. Two spellings of "" (empty, spaces) and one ordering
 * took a 403 to a 204 (measured: all three ACCEPTED a push).
 *
 * The question was never what the chain says. borgo cannot verify a chain
 * anyway; what it can see is that a proxy touched this request at all, and that
 * is a property of the header EXISTING. So this reads `has`, and it reads every
 * header a proxy stamps rather than the two that happened to be checked -
 * borgo's own generated nginx sets X-Forwarded-Proto, and a value the guard
 * does not look at is a hop it cannot see.
 */
export const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "forwarded",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-real-ip",
] as const;

export const isForwarded = (headers: Headers): boolean =>
  FORWARDING_HEADERS.some((name) => headers.has(name));

export function pushAuthorized(req: {
  key: string | undefined;
  presented: string | null;
  address: string | undefined;
  // isForwarded above, never a header value: a boolean cannot be emptied by
  // whoever is calling
  forwarded: boolean;
}): PushVerdict {
  if (req.key) return keysEqual(req.presented ?? "", req.key) ? "ok" : "bad-key";
  if (req.presented !== null) return "half-configured";
  const local =
    req.address === "127.0.0.1" || req.address === "::1" || req.address === "::ffff:127.0.0.1";
  return local && !req.forwarded ? "ok" : "not-local";
}

/**
 * A COMMA IN A TOPIC IS NOT A CHARACTER, IT IS THE SEPARATOR.
 *
 * The relay packs a socket's topics into one query parameter - /ws?topics=a,b -
 * so `subscribe("a,b")` percent-encodes the comma, borgo decoded it, split on
 * it, and subscribed the browser to "a" AND "b" while its onmessage went on
 * filtering every frame for the topic "a,b". Measured: the handshake returns
 * 101, the `__count` frames arrive (for "a" and for "b"), the counters move, and
 * a `borgo.Push("a,b", ...)` publishes into a topic with no subscribers. The
 * channel looks alive from every angle a person debugging would check, and not
 * one message is ever delivered.
 *
 * Escaping it would put a second protocol inside the first - every producer of a
 * topic name (this file, the go side, the browser) would have to agree on the
 * escape, and the one that did not would fail exactly this silently again. So it
 * is refused, by name, at the door, in both directions: a subscription that
 * names one and a push that names one.
 */
export const TOPIC_SEPARATOR = ",";

export const topicRejection = (topic: string): string | null =>
  topic.includes(TOPIC_SEPARATOR)
    ? `topic ${JSON.stringify(topic)} contains ${JSON.stringify(TOPIC_SEPARATOR)}, which separates topics ` +
      `on the wire (/ws?topics=a,b) and cannot appear inside one - rename the topic`
    : null;

/**
 * Responses borgo did not write.
 *
 * /api is exempt from the security headers because go states its own and borgo
 * does not second-guess them. That exemption was written on the PATH, so it
 * covered borgo's own answers on that path too: the 403 for a bad csrf token,
 * the 504 when the api does not answer in time, the 502 when it cannot be
 * reached at all. Measured on the socket - 502 and 403 shipped with no nosniff,
 * no Referrer-Policy, no X-Frame-Options and no CSP, while a 404 from the same
 * server one path over carried all four.
 *
 * The rule is about AUTHORSHIP, so it is recorded on the response object the
 * author produced, not on the url it happened to be produced for. A WeakSet
 * cannot drift from the path the way a string test can, and a response borgo
 * builds is unmarked by construction - the safe direction, since an unmarked
 * response gets the headers.
 */
const upstreamResponses = new WeakSet<Response>();

export const markUpstream = <T extends Response>(res: T): T => (upstreamResponses.add(res), res);

export const isUpstream = (res: Response): boolean => upstreamResponses.has(res);

/**
 * May this /ws handshake upgrade.
 *
 * A browser attaches cookies to a websocket handshake whatever page opened it,
 * and there is no preflight and no CORS on the way in, so `Origin` is the only
 * thing separating "this app's page" from "any page on the internet". It was
 * compared on the HOST ALONE, and an absent one was waved through:
 *
 *   - host alone means `http://app.test` may join the socket of
 *     `https://app.test`. That is not a hypothetical: it is what a network
 *     attacker who can answer plain http for the name arranges, and the whole
 *     point of serving the app over tls is that such a page is not the app.
 *     Measured: `Origin: https://localhost:3111` upgraded on an http server,
 *     101, cookies attached.
 *   - absent means anything that is not a browser, which is the entire
 *     population this check exists to tell browsers apart from. `curl` with no
 *     Origin got 101 while `curl -H 'Origin: http://evil.test'` got 403 - the
 *     header the caller controls decided whether the guard applied.
 *
 * So: scheme and host, and no Origin is a refusal. The scheme compared is the
 * one the request arrived on, or what a terminating proxy says it arrived on -
 * borgo behind nginx sees http and the browser sent https, and its own generated
 * config sets X-Forwarded-Proto for exactly this. That header is trusted here
 * and nowhere near a security decision it could weaken: a browser cannot set it,
 * and anything that can set it can set Origin to whatever it likes anyway.
 *
 * BORGO_WS_ALLOW_NO_ORIGIN=1 admits the originless client on purpose - a native
 * app, a CLI, a service-to-service socket. It is a real need and it is a real
 * hole: it re-admits every non-browser caller, so it is a switch the operator
 * turns on knowing that, not a default they never saw.
 */
export function wsOriginAllowed(req: {
  origin: string | null;
  host: string;
  proto: string;
  forwardedProto: string | null;
  allowNoOrigin: boolean;
}): boolean {
  if (req.origin === null) return req.allowNoOrigin;
  // a proxy chain joins its values; the first is the client's hop
  const scheme = (req.forwardedProto?.split(",")[0] ?? "").trim().toLowerCase() || req.proto;
  let origin: URL;
  try {
    // "null" is what a sandboxed iframe and a cross-origin redirect send. It
    // parses as no url at all, which is the answer: it is not this origin
    origin = new URL(req.origin);
  } catch {
    return false;
  }
  return origin.host === req.host && origin.protocol === `${scheme}:`;
}

export const goBinName = () => "api" + (process.platform === "win32" ? ".exe" : "");

// rfc 9110 §7.6.1: these govern one connection and are meaningless - or
// actively harmful - on the next hop. the browser -> borgo connection is not
// the borgo -> go connection, so forwarding them verbatim hands the client
// control of a hop that is not theirs:
//   Connection also *names* further headers as hop-scoped, so `Connection:
//     X-Api-Key` is a header-stripping primitive aimed at whatever go trusts;
//   Upgrade invites go to answer 101 on a pooled keep-alive socket bun will
//     reuse for the next /api request, desynchronised (the 101 guard in the
//     proxy saves the client, not the socket);
//   Proxy-Authorization / Proxy-Connection leak credentials meant for a
//     forward proxy into application-visible headers;
//   Transfer-Encoding is the client's framing of *its* request. bun frames the
//     outbound request itself - chunked for a stream, content-length for a
//     buffer, both derived from the bytes it actually writes - so passing the
//     inbound framing on can only disagree with what goes on the wire.
// measured on a 16-header browser request: ~0.9us, 0.1-0.5% of the proxy
// handler's cpu under concurrency (2.5% of a 75us handler when fully serial).
export const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
] as const;

// tchar, rfc 9110 §5.6.2. the Connection value is the client's, and not every
// comma-separated piece of it is a field name: `keep-alive,` leaves an empty
// token, `,` leaves two, a quoted string leaves quotes. Headers.delete throws
// on any of them - and it throws from *outside* proxyRequest's try, so the 502
// the proxy answers its own failures with never runs. the request lands in
// serve()'s catch instead and /api answers a rendered 500 document: html on an
// api path, a fresh csrf cookie, a full ssr render bought with one malformed
// header. tokens are judged one at a time, so a junk token cannot smuggle a
// real one - `Connection: X-Api-Key, "junk"` still strips X-Api-Key.
const TCHAR = /^[!#$%&'*+.^_`|~\w-]+$/;

// content-length is deliberately kept: bun recomputes it for a buffered body
// and the streamed path only ever carries the length bun's own server already
// framed the request with, so go still sees an honest r.ContentLength.
export function forwardableHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  // read Connection before deleting it; a single token carries no comma, so
  // this cannot be shortcut on one
  const connection = out.get("connection");
  if (connection) {
    for (const token of connection.split(",")) {
      const name = token.trim();
      if (TCHAR.test(name)) out.delete(name);
    }
  }
  for (const name of HOP_BY_HOP) out.delete(name);
  return out;
}

// the /api proxy buffers request bodies so a refused connection (api mid-
// restart) can be retried; only bodies of known, modest size qualify - a
// large upload or a chunked stream passes through once, without retry
export const PROXY_RETRY_MAX_BODY = 10 * 1024 * 1024;

// rfc 9112 §6.3 allows a request to repeat Content-Length as long as every
// value agrees, and bun.serve accepts one: `Headers` then joins the repeats
// into "5, 5". Number() reads that as NaN, which used to mean "unbuffered" -
// so a five byte body lost its retry, and the comma-joined header went on to
// go verbatim. parse the list instead, and require the values to agree.
// Number() is the wrong reader for a header value in general: it also takes
// "", "0x10", "1e3" and " 5 " as numbers a length may never be.
function parseContentLength(value: string): number | null {
  let length: number | null = null;
  for (const part of value.split(",")) {
    const token = part.trim();
    if (!/^\d+$/.test(token)) return null;
    const n = Number(token);
    if (length !== null && n !== length) return null;
    length = n;
  }
  return length;
}

export function shouldBufferBody(
  method: string,
  contentLength: string | null,
  transferEncoding: string | null = null,
): boolean {
  if (method === "GET" || method === "HEAD") return false;
  // rfc 9112 §6.3: a body framed by Transfer-Encoding is not framed by a
  // length, whatever length also rides along - so its size is not knowable
  // before it is read, and it must not be sized off the header pair
  if (transferEncoding !== null) return false;
  if (contentLength === null) return false;
  const length = parseContentLength(contentLength);
  return length !== null && length <= PROXY_RETRY_MAX_BODY;
}

/**
 * THE SIZE A BODY IS ACTUALLY FRAMED BY, or null when nothing frames it.
 *
 * Transfer-Encoding wins over Content-Length and the length is then not a
 * length at all - the classic request-smuggling pair. bun answers that pair
 * `400` itself before a handler is called (measured on 1.3.14:
 * `Content-Length: 4` + `Transfer-Encoding: chunked` -> 400, connection
 * closed), so on the real server this can only be reached by a hand-built
 * Request; it is written down anyway, because `proxyRequest` and `runAction`
 * are exported and the caller that reaches them next may not be bun.
 */
export function framedLength(headers: Headers): number | null {
  if (headers.get("transfer-encoding") !== null) return null;
  const raw = headers.get("content-length");
  return raw === null ? null : parseContentLength(raw);
}

/**
 * BORGO_MAX_BODY COUNTS BYTES, BECAUSE A DECLARATION IS THE CLIENT'S.
 *
 * The limit used to be handed straight to bun as `maxRequestBodySize`, and
 * bun's cap is on a *declared* Content-Length. Measured on bun 1.3.14 over a
 * real socket at `BORGO_MAX_BODY=64`, with the same handler each time:
 *
 *   Content-Length: 200 / 4Ki / 16Ki   413, before the handler runs
 *   Content-Length: 64Ki / 1Mi         socket closed, NO response at all
 *   Transfer-Encoding: chunked, 200 B  reaches the handler, read whole
 *   Transfer-Encoding: chunked, 1 Mi   reaches the handler, read whole
 *
 * And the cap never fired at all for a body the handler consumed as a stream
 * or through `clone()` - measured: chunked 1 MiB read in full under a cap of
 * 64 by a handler that piped `req.body`, and again by one that called
 * `req.clone().formData()`. Those are exactly borgo's two buffering paths
 * (`csrfRejects` clones and parses, the proxy pipes), so the only framing the
 * cap ever governed was the one nobody is obliged to use. Nothing had to be
 * circumvented: the limit was skipped by not declaring a length.
 *
 * A LIMIT THAT CANNOT COUNT WHAT WAS NOT DECLARED IS NOT A LIMIT. So the count
 * is taken off the read itself, and it STOPS the read at the limit rather than
 * discovering the size after buffering it - memory is the whole reason the
 * limit exists, and a check that runs after the allocation protects nothing.
 * The refusal is a 413 with a body, written while the socket is still there:
 * with bun's own cap out of the way a handler-authored 413 was received in
 * every framing, up to a declared 100 MiB and a chunked 100 MiB (measured).
 *
 * `0` is no limit, and it has to be honoured HERE rather than by bun:
 * `maxRequestBodySize: 0` makes bun refuse EVERY body (measured - a 1000-byte
 * POST answered 413), the exact inverse of what the variable documents.
 */
export const bodyTooLarge = (limit: number) =>
  new Response(`request body too large (over BORGO_MAX_BODY=${limit})\n`, {
    status: 413,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

/**
 * The body, or null the moment it goes one byte past `limit`.
 *
 * The chunk that crosses the limit is dropped rather than appended and the
 * source is cancelled, so what is held is never more than `limit` plus the one
 * chunk bun handed over - the read granularity of the socket, not the size of
 * the body. A 100 MiB upload under a 64-byte limit ends after bun's first
 * read.
 */
export async function readBodyWithin(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  // the one-chunk case is handed back without a copy. The cast is only about
  // the buffer's provenance - a stream's chunk is typed over ArrayBufferLike,
  // which admits a SharedArrayBuffer no socket read ever produces - and
  // BodyInit will not take that union
  if (chunks.length === 1) return chunks[0] as Uint8Array<ArrayBuffer>;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * The same request over the bytes already in hand, or null when it is too big.
 *
 * For the paths that were always going to buffer. A declared length over the
 * limit is refused on the declaration - no byte is read, nothing upstream is
 * dialled - and every other framing is counted as it arrives. The request that
 * comes back shares the original's abort signal rather than copying it, since
 * `runAction` and `serve()` both ask a request whether the client is still
 * there; and the body is read once here and parsed twice downstream
 * (`csrfRejects`' clone, then the action's own `formData()`), which is what
 * the clone already did.
 *
 * A limit of 0 - or a request with no body at all - is handed straight back
 * untouched, so nothing that does not need bounding acquires a copy.
 */
export async function limitRequestBody(req: Request, limit: number): Promise<Request | null> {
  if (limit <= 0 || req.body === null) return req;
  const declared = framedLength(req.headers);
  if (declared !== null && declared > limit) {
    void req.body.cancel().catch(() => {});
    return null;
  }
  const bytes = await readBodyWithin(req.body, limit);
  if (bytes === null) return null;
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: bytes,
    signal: req.signal,
  });
}

// a head renders for real - status and headers must be what a get would have
// said - and only the body is dropped. cancelled, too: without that the
// ssr/gzip pipeline behind it keeps rendering into a stream nobody reads.
//
// a null body is itself a claim: bun frames one as Content-Length: 0. so every
// response that never measured its own length - the streamed document,
// /healthz, /metrics, a props payload, a plain text 404 - used to answer a head
// by declaring itself empty, for a resource a get returns in full. that is the
// same lie the asset paths set an explicit length to avoid, arriving from the
// other side. a length that is known still rides (the assets state theirs, and
// go states its own through the proxy); where none is, an already-closed
// stream leaves bun framing the head as it framed the get. rfc 9110 §9.3.2
// allows omitting a field "determined only while generating the content" -
// it does not allow getting it wrong.
export function headResponse(method: string, res: Response): Response {
  if (method !== "HEAD" || !res.body) return res;
  const measured = res.headers.has("Content-Length");
  const headless = new Response(measured ? null : emptyStream(), {
    status: res.status,
    headers: res.headers,
  });
  void res.body.cancel().catch(() => {});
  return headless;
}

const emptyStream = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

// set-cookie headers collected from the api ride out on whatever response the
// request ends with; a response that gathered none passes through untouched
export function withCookies(res: Response, cookies: string[]): Response {
  if (!cookies.length) return res;
  const headers = new Headers(res.headers);
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(res.body, { status: res.status, headers });
}

// in dev a tiny inline client keeps a zero-js page live: css swaps in
// place, anything else is a full reload.
//
// It also sets __BORGO_DEV__, and that is not decoration. The flag used to be
// written by the props script alone, which a hydrate=false page does not emit -
// but such a page can still run client js, because islands hydrate on it
// through their own entry. So on exactly those pages the flag was absent in
// development, and every guard that reads it silently took its production
// branch: registerServiceWorker installed a caching service worker over a dev
// session, which is the single most confusing state to debug from. The signal
// has to reach every page that can execute js, not every page that hydrates.
export const DEV_INLINE_CLIENT =
  "<script>window.__BORGO_DEV__=1;(()=>{const c=()=>{const w=new WebSocket(`ws://${location.host}/__borgo/dev`);" +
  'w.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.type==="css"){for(const l of document.querySelectorAll(\'link[rel="stylesheet"]\'))l.href=l.href.split("?")[0]+"?t="+Date.now();}' +
  'else if(!m.stamp||(m.stamp>performance.timeOrigin&&Number(sessionStorage.getItem("borgo:devstamp")||0)<m.stamp)){if(m.stamp)sessionStorage.setItem("borgo:devstamp",String(m.stamp));location.reload();}};' +
  "w.onclose=()=>setTimeout(c,300);};c();})()</script>";

export type ShellParts = {
  // everything before <!--app-->, untouched
  start: string;
  // the shell's default title as TEXT, not as the markup it was written in.
  // The browser runtime assigns it to document.title, which takes text.
  title: string;
  // start split at </head>, with and without its <title>
  head: [string, string];
  headNoTitle: [string, string];
  // everything after <!--app-->, split at the props slot
  endProps: [string, string];
  // the tail of a hydrate=false page: no props, no client script - or the
  // islands entry, which hydrates only those
  zeroJsEnd: { plain: string; islands: string };
  // closes the props script: the shell title for the client-side router,
  // and the dev flag
  stateTail: string;
};

// which file each of the names an index.html is written against became. Empty
// is the honest default: every url stays exactly as the document spelled it.
export type AssetNames = Record<string, string>;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// the five references a <title> can legally carry, plus the numeric forms.
// `escapeHtml` above emits exactly the first four; the fifth is what an author
// types, and browsers accept both spellings of the numeric one
const NAMED_REFS: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * The text an element's markup stands for.
 *
 * `<title>` holds HTML, and `window.__BORGO_TITLE__` is read by the client
 * router into `document.title`, which holds TEXT. Shipping the markup verbatim
 * meant one title had two spellings: the server-rendered tab said `Tom & Jerry`
 * and the first client-side navigation back to the shell default replaced it
 * with the literal `Tom &amp; Jerry` (measured on the wire:
 * `window.__BORGO_TITLE__="Tom &amp; Jerry"`). Nothing looks broken until you
 * navigate, which is why it survived.
 *
 * A reference borgo does not know is left exactly as written: this decodes a
 * value, it does not repair one, and a half-decoded `&` would be a new way to
 * disagree with the browser about the same bytes.
 */
export const decodeHtmlText = (s: string): string =>
  s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ref: string) => {
    const named = NAMED_REFS[ref.toLowerCase()];
    if (named !== undefined) return named;
    if (ref[0] !== "#") return whole;
    const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    // surrogates and out-of-range values are not characters; String.fromCodePoint
    // would throw on the second and produce a lone surrogate for the first
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return whole;
    }
    return String.fromCodePoint(code);
  });

// A production build names its entry bundle and stylesheet after their bytes,
// so the url can be pinned for a year; the app's index.html goes on naming
// /assets/client.js and /assets/style.css, and this is where the two meet. The
// document is never edited on disk - an app author must never have to keep a
// hash in their html - and an unrecorded name is left alone, which costs a
// revalidation rather than a 404 on a file that was never emitted.
export function resolveAssetUrls(shell: string, names: AssetNames): string {
  let resolved = shell;
  for (const [logical, emitted] of Object.entries(names)) {
    if (emitted && emitted !== logical) {
      resolved = resolved.replaceAll(`/assets/${logical}`, `/assets/${emitted}`);
    }
  }
  return resolved;
}

// the shell is scanned once at boot so a render only concatenates strings:
// injecting <head> content is a per-request rewrite of the whole shell head,
// and the props slot and client script tag are resolved here, not per page
export function prepareShell(source: string, dev: boolean, names: AssetNames = {}): ShellParts {
  const shell = resolveAssetUrls(source, names);
  const [start, end = ""] = shell.split("<!--app-->");
  // decoded here, once, so what leaves this function is the title as DATA and
  // nothing downstream has to know it was ever markup
  const title = decodeHtmlText(shell.match(/<title>(.*?)<\/title>/s)?.[1] ?? "");
  const splitAtHead = (html: string): [string, string] => {
    const at = html.indexOf("</head>");
    return at === -1 ? [html, ""] : [html.slice(0, at), html.slice(at)];
  };
  const PROPS_SLOT = "<!--props-->";
  const splitAtProps = (html: string): [string, string] => {
    const at = html.indexOf(PROPS_SLOT);
    return at === -1 ? [html, ""] : [html.slice(0, at), html.slice(at + PROPS_SLOT.length)];
  };
  // tolerate any attribute order/extras on the client script tag; a shell
  // where it cannot be found would otherwise hydrate the wrong page over a
  // zero-js document. built from the resolved name, since that is what the
  // shell above now carries
  const clientSrc = escapeRe(names["client.js"] ?? "client.js");
  const clientScriptRe = new RegExp(
    `[ \\t]*<script\\b[^>]*src="/assets/${clientSrc}"[^>]*></script>\\r?\\n?`,
  );
  const islandsSrc = names["islands-client.js"] ?? "islands-client.js";
  const zeroJsTail = (islands: boolean) =>
    end
      .replace(PROPS_SLOT, dev ? DEV_INLINE_CLIENT : "")
      .replace(
        clientScriptRe,
        islands ? `<script type="module" src="/assets/${islandsSrc}"></script>` : "",
      );
  return {
    start,
    title,
    head: splitAtHead(start),
    headNoTitle: splitAtHead(start.replace(/<title>.*?<\/title>/s, "")),
    endProps: splitAtProps(end),
    zeroJsEnd: { plain: zeroJsTail(false), islands: zeroJsTail(true) },
    stateTail: `;window.__BORGO_TITLE__=${scriptJson(title)}${dev ? ";window.__BORGO_DEV__=1" : ""}</script>`,
  };
}

export type LoaderResult = Record<string, unknown> | Response;

export type RenderPageOptions = {
  dev: boolean;
  shell: ShellParts;
  security: Security | null;
  // attributes minted onto a fresh csrf cookie (path, samesite, secure)
  csrfCookieAttrs: string;
  // the page's loader wired to the api client; collects set-cookie headers
  runLoader: (
    req: Request,
    route: Route,
    params: Record<string, string>,
    onSetCookie: (cookies: string[]) => void,
  ) => Promise<LoaderResult>;
  // the page component wrapped in its layouts - serve() owns react
  compose: (route: Route, props: Record<string, unknown>) => import("react").ReactNode;
  // react-dom's renderToReadableStream, narrowed to what the render asks
  renderToStream: (
    element: import("react").ReactNode,
    init: { nonce?: string; onError: (error: unknown) => void },
  ) => Promise<AsyncIterable<Uint8Array>>;
  // the props json and the head computed from the props are built outside
  // that stream; production runs the same local-path redaction over both
  redactText?: (text: string) => string;
  // injectable for tests; production passes none of these
  randomToken?: () => string;
  onError?: (value: unknown) => void;
};

export async function renderPage(
  req: Request,
  route: Route,
  params: Record<string, string>,
  status: number,
  options: RenderPageOptions,
  extraProps?: Record<string, unknown>,
  extraCookies: string[] = [],
): Promise<Response> {
  const {
    dev,
    shell,
    security,
    csrfCookieAttrs,
    runLoader,
    compose,
    renderToStream,
    redactText = (text) => text,
    randomToken = () => crypto.randomUUID().replaceAll("-", ""),
    onError = console.error,
  } = options;

  const apiCookies = [...extraCookies];
  const loaded = await runLoader(req, route, params, (c) => apiCookies.push(...c));
  // a loader may short-circuit with a response, e.g. redirect() as a guard
  if (loaded instanceof Response) return withCookies(loaded, apiCookies);
  const props = extraProps ? { ...loaded, ...extraProps } : loaded;

  // the same token rides in the cookie and in every <CsrfField />; a
  // browser without one gets it minted alongside this page
  const cookieToken = csrfCookieValue(req.headers.get("cookie"));
  const csrfToken = cookieToken || randomToken();
  if (!cookieToken) apiCookies.push(`${CSRF_COOKIE}=${csrfToken}; ${csrfCookieAttrs}`);

  // react emits inline scripts of its own to reveal streamed suspense
  // boundaries: they need the same nonce as the props script, so it is
  // minted before the render and not when the document tail is built
  const nonce = security?.needsNonce ? randomToken() : "";

  // props are serialized before the render, not while the document tail is
  // built: a loader that hands back something json cannot carry (a bigint, a
  // cycle, a toJSON that throws) makes this throw, and a render already in
  // flight would then be abandoned unread - react has no consumer to end it
  // through, so the whole component tree is walked for a document that can
  // never ship, and the request object stays resident. failing first costs
  // nothing and keeps the waste at zero.
  const propsJson = route.module.hydrate === false ? "" : redactText(scriptJson(props));

  const head = resolveHead(route.module, props);
  const stream = await renderToStream(withCsrf(compose(route, props), csrfToken), {
    nonce: nonce || undefined,
    onError(error) {
      onError(error);
    },
  });

  let start = shell.start;
  const injected = redactText(headHtml(head));
  if (injected) {
    const [before, after] = head.title ? shell.headNoTitle : shell.head;
    start = before + injected + after;
  }

  let end: string;
  if (route.module.hydrate === false) {
    // the page opted out of hydration: ship no props and no client script.
    // pages with islands get the islands entry, which hydrates only those.
    end = route.islands ? shell.zeroJsEnd.islands : shell.zeroJsEnd.plain;
  } else {
    const tag = nonce ? `<script nonce="${nonce}">` : "<script>";
    end = `${shell.endProps[0]}${tag}window.__PROPS__=${propsJson}${shell.stateTail}${shell.endProps[1]}`;
  }

  // react-dom's bun build misbehaves under a manual reader pump; async
  // iteration is the reliable way to drain it
  const body = documentStream(start, stream, end);

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    Vary: "Accept-Encoding",
  });
  if (nonce) headers.set("Content-Security-Policy", security!.cspFor(nonce));
  for (const c of apiCookies) headers.append("Set-Cookie", c);
  // gzip only: brotli is too slow for dynamic responses. no size threshold
  // here - a rendered document is virtually always past it, and the length
  // of a stream is unknown up front. the per-chunk sync flush in gzipStream
  // keeps streamed suspense content progressive.
  if (!dev && pickEncoding(req.headers.get("accept-encoding"), ["gzip"])) {
    headers.set("Content-Encoding", "gzip");
    return new Response(gzipStream(body), { status, headers });
  }
  return new Response(body, { status, headers });
}

// a response built by an action or a loader guard may carry headers of its
// own (set-cookie above all); they must survive the translation to json.
// location, set-cookie and the content-* family are excluded from the plain
// copy: the first two are re-stated by the envelope and the cookie append
// below, and the content-* of the original body would describe a body this
// response no longer carries.
export function carryHeaders(from: Response, json: Response): Response {
  const headers = new Headers(json.headers);
  from.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "location" || k === "set-cookie" || k.startsWith("content-")) return;
    headers.set(key, value);
  });
  for (const c of from.headers.getSetCookie()) headers.append("Set-Cookie", c);
  // only the headers of `from` survive; its body is going nowhere and holds
  // whatever is behind it - an upstream socket for a Response the action
  // proxied, a file handle - until the tab that started the request closes.
  // a redirect with a body is not exotic: `Response.redirect` has none, but a
  // hand-built `new Response(html, { status: 302, headers: { Location } })` is
  // exactly what an action that wants a fallback page writes.
  void from.body?.cancel().catch(() => {});
  return new Response(json.body, { status: json.status, headers });
}

// an action that logs in (or out) changes the cookie jar mid-request: the
// loader that runs right after must see the new session, not the one the
// browser sent before the action. freshCookieHeader owns the duplicate
// semantics, which have to match what go would have made of the same jar
export function freshCookieRequest(req: Request, setCookies: string[]): Request {
  if (!setCookies.length) return req;
  const headers = new Headers(req.headers);
  const cookie = freshCookieHeader(req.headers.get("cookie"), setCookies);
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");
  return new Request(req.url, { method: req.method, headers });
}

// the one match a request already does, handed on rather than repeated
export type RouteMatch = { route: Route; params: Record<string, string> };

export type RunLoaderFn = (
  req: Request,
  route: Route,
  params: Record<string, string>,
  onSetCookie?: (cookies: string[]) => void,
) => Promise<LoaderResult>;

export type RenderPageFn = (
  req: Request,
  route: Route,
  params: Record<string, string>,
  status: number,
  extraProps?: Record<string, unknown>,
  extraCookies?: string[],
) => Promise<Response>;

// dev answers with Response.json, production with the compressing jsonResponse
export type SendJsonFn = (req: Request, value: unknown, init?: ResponseInit) => Response;

export type ActionOptions = {
  dev: boolean;
  // raw base url handed to the action, for anything the typed client misses
  apiUrl: string;
  // the _500 page, rendered when an enhanced action throws in production
  serverError: Route | null;
  // serve() has already resolved the enforced flag from the environment
  csrfRejects: (req: Request) => Promise<boolean>;
  // bytes, 0 for no limit. serve() resolves BORGO_MAX_BODY once; it is not
  // optional, because a body limit that defaults to absent when a caller
  // forgets it is a limit that fails open
  maxBody: number;
  // the api client bound to this request's cookies, collecting set-cookie
  apiFor: (req: Request, onSetCookie?: (cookies: string[]) => void) => ActionContext["api"];
  runLoader: RunLoaderFn;
  renderPage: RenderPageFn;
  sendJson: SendJsonFn;
  // overlayHtml in dev; never called in production
  renderOverlay: (error: unknown) => string;
  // injectable for tests; production passes none of these
  onError?: (value: unknown) => void;
};

// a POST landing on the page routes. answers, or hands back null for "not
// mine" - a post to a path with no page, or to a page with no action, which
// the caller turns into the 405 a native form gets.
//
// the client runtime submits enhanced forms with X-Borgo-Action: 1 and gets
// json back (props + actionData, or a redirect) instead of a document, so the
// page re-renders in place without losing the scroll position. classic no-js
// posts get the full html render. every enhanced answer is marked X-Borgo
// (action = json envelope, raw = a full document to swap in) so the runtime
// never has to guess; anything left unmarked is a custom response it reloads
// on, which is the documented escape hatch.
export async function runAction(
  original: Request,
  target: RouteMatch | null,
  options: ActionOptions,
): Promise<Response | null> {
  const {
    dev,
    apiUrl,
    serverError,
    csrfRejects: rejectsCsrf,
    maxBody,
    apiFor,
    runLoader,
    renderPage,
    sendJson,
    renderOverlay,
    onError = console.error,
  } = options;

  const action = target?.route.module.action;
  const wantsJson = original.headers.get("x-borgo-action") === "1";
  const actionJson = (value: unknown, init: ResponseInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("X-Borgo", "action");
    headers.set("Cache-Control", "private, no-store");
    return sendJson(original, value, { ...init, headers });
  };
  const rawDocument = (doc: Response) => {
    const headers = new Headers(doc.headers);
    headers.set("X-Borgo", "raw");
    return new Response(doc.body, { status: doc.status, headers });
  };

  if (target && action) {
    if (typeof action !== "function") {
      throw new Error(`the action export of pages/${target.route.file} must be a function`);
    }
    // BEFORE the csrf check, which is the first thing here that reads a body:
    // it clones and parses the whole of it looking for the token field, so a
    // limit applied after it is a limit applied after the allocation. Refused
    // here the request costs one buffer of at most `maxBody`, and an
    // unparseable-length or chunked body - the framing bun's own cap never
    // counted - costs exactly as much as a declared one.
    const limited = await limitRequestBody(original, maxBody);
    if (limited === null) return bodyTooLarge(maxBody);
    const req = limited;
    if (await rejectsCsrf(req)) {
      if (wantsJson) return actionJson({ csrf: true }, { status: 403 });
      return new Response("invalid csrf token", { status: 403 });
    }
    const apiCookies: string[] = [];
    try {
      const result = await action({
        request: req,
        params: target.params,
        api: apiFor(req, (c) => apiCookies.push(...c)),
        apiUrl,
      });
      if (result instanceof Response) {
        const location = result.headers.get("Location");
        if (wantsJson && location) {
          return withCookies(carryHeaders(result, actionJson({ redirect: location })), apiCookies);
        }
        // case-insensitively, for the same reason the csp check is: the
        // action owns this content-type, and a document the marker misses
        // is a document the runtime reloads over instead of swapping in
        if (wantsJson && (result.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
          return withCookies(rawDocument(result), apiCookies);
        }
        return withCookies(result, apiCookies);
      }
      const freshReq = freshCookieRequest(req, apiCookies);
      if (wantsJson) {
        const loaded = await runLoader(freshReq, target.route, target.params, (c) =>
          apiCookies.push(...c),
        );
        if (loaded instanceof Response) {
          const location = loaded.headers.get("Location");
          if (location) {
            return withCookies(carryHeaders(loaded, actionJson({ redirect: location })), apiCookies);
          }
          return withCookies(loaded, apiCookies);
        }
        return withCookies(actionJson({ props: loaded, actionData: result }), apiCookies);
      }
      // awaited, not returned: `return promise` inside a try resolves the outer
      // promise with it and leaves the try before it settles, so the catch
      // below - the whole point of which is this render - would never see it
      return await renderPage(
        freshReq,
        target.route,
        target.params,
        200,
        { actionData: result },
        apiCookies,
      );
    } catch (error) {
      // the native path normally lets the error out to the server's handler,
      // which renders the 500 page from the *original* request - and knows
      // nothing about the cookies this action collected. An action that logged
      // the user in through go and then threw while rendering would answer 500
      // with the session cookie dropped on the floor: the login ran, the
      // browser never heard about it, and the user is told nothing happened.
      // The error page is rendered here instead, with the cookies attached.
      //
      // A client that has already hung up is still the server's 499 to make,
      // and it is the same 499 whichever way the form was posted. The abort
      // check used to sit inside the native branch, so an enhanced submit
      // (X-Borgo-Action: 1) from a client that was already gone still bought a
      // full _500 ssr render and its go round trip, writing it to a socket
      // nobody was reading - the very waste the 499 in serve() says it closed,
      // and reachable with no credentials at all, since csrfRejects returns
      // false immediately for a cookie-less client.
      if (req.signal.aborted) throw error;
      if (!wantsJson && !apiCookies.length) throw error;
      onError(error);
      if (!wantsJson) {
        if (dev) {
          return withCookies(
            new Response(renderOverlay(error), {
              status: 500,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            }),
            apiCookies,
          );
        }
        if (serverError) {
          try {
            return await renderPage(req, serverError, {}, 500, undefined, apiCookies);
          } catch {}
        }
        return withCookies(new Response("internal server error", { status: 500 }), apiCookies);
      }
      // the native flow would show the overlay or the 500 page; the
      // enhanced flow must deliver that same document, not vanish the
      // failure behind a silent reload.
      //
      // And it carries the cookies the action already collected, for the same
      // reason the native path does: an action that logged the user in through
      // go and then threw during the render would otherwise answer 500 with the
      // Set-Cookie dropped, so the login silently did not stick and the user
      // retries against a session that was created.
      const errorDocument = (doc: Response) => withCookies(rawDocument(doc), apiCookies);
      if (dev) {
        return errorDocument(
          new Response(renderOverlay(error), {
            status: 500,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
        );
      }
      if (serverError) {
        try {
          return errorDocument(await renderPage(req, serverError, {}, 500));
        } catch {}
      }
      return errorDocument(new Response("internal server error", { status: 500 }));
    }
  }
  if (wantsJson && target) {
    // a post to a page without an action: tell the runtime to go native
    return actionJson({ unsupported: true }, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  return null;
}

export type PropsOptions = {
  runLoader: RunLoaderFn;
  sendJson: SendJsonFn;
};

// ?__borgo=props: the client router asks for the next page's loader data
// alone, and renders the component it already has. never cached - it carries
// session-shaped data and the cookies the loader's api calls issued.
export async function runPropsRequest(
  req: Request,
  route: Route,
  params: Record<string, string>,
  { runLoader, sendJson }: PropsOptions,
): Promise<Response> {
  const apiCookies: string[] = [];
  const props = await runLoader(req, route, params, (c) => apiCookies.push(...c));
  const noStore = { headers: { "Cache-Control": "private, no-store" } };
  if (props instanceof Response) {
    // surface loader redirects as data, so the client runtime can follow
    const location = props.headers.get("Location");
    if (location) {
      return withCookies(carryHeaders(props, sendJson(req, { redirect: location }, noStore)), apiCookies);
    }
    return withCookies(props, apiCookies);
  }
  return withCookies(sendJson(req, { props }, noStore), apiCookies);
}

// the seam, narrowed to what the proxy actually asks of fetch: a target and
// an init in, a response out. the global satisfies it and so does a stub.
export type ProxyFetch = (target: string, init: RequestInit) => Promise<Response>;

export type ProxyOptions = {
  // absolute upstream url, query included
  target: string;
  // how long to wait for response *headers*; 0 disables the deadline
  deadlineMs: number;
  // connection-refused retries (the api restarting), 0 to never retry
  retries: number;
  // bytes, 0 for no limit. required for the same reason it is on ActionOptions
  maxBody: number;
  retryDelayMs?: number;
  // the address borgo actually read this request from, appended to the
  // X-Forwarded-For chain. undefined means "no peer to vouch for", and then no
  // chain travels at all
  clientIp?: string;
  // called once the request body is entirely in hand - buffered or streamed,
  // both - so the caller can start keeping the socket warm: from here on the
  // connection is the server's to hold, not the client's. it fires at the last
  // byte of the body and never on a declaration, since a declaration is the
  // client's. see readTimeout above for why that is a second clock.
  onBodyRead?: () => void;
  // injectable for tests; production passes none of these
  fetchImpl?: ProxyFetch;
  sleep?: (ms: number) => Promise<void>;
  onError?: (value: unknown) => void;
};

export const isConnRefused = (err: unknown) => {
  const e = err as { code?: string; message?: string };
  return e?.code === "ConnectionRefused" || e?.code === "ECONNREFUSED" || /unable to connect|refused/i.test(e?.message ?? "");
};

// the /api hop, borgo -> go. the go api restarts on every .go edit in dev: a
// refused connection never reached it, so retrying briefly is safe even for
// mutations. small bodies are buffered once so the request can be re-sent;
// large or unsized bodies stream through, at the price of no retry.
export async function proxyRequest(req: Request, options: ProxyOptions): Promise<Response> {
  const {
    target,
    deadlineMs,
    retries,
    maxBody,
    retryDelayMs = 250,
    clientIp,
    onBodyRead,
    fetchImpl = fetch,
    sleep = Bun.sleep,
    onError = console.error,
  } = options;

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const buffered = shouldBufferBody(
    req.method,
    req.headers.get("content-length"),
    req.headers.get("transfer-encoding"),
  );
  // a declared length over the limit is refused on the declaration: no byte is
  // read, go is never dialled, and the 413 goes out while the client is still
  // writing. taking the client at its word is only ever safe in this
  // direction - a forged length can withhold the body's passage, never widen it
  if (hasBody && maxBody > 0) {
    const declared = framedLength(req.headers);
    if (declared !== null && declared > maxBody) {
      void req.body?.cancel().catch(() => {});
      return bodyTooLarge(maxBody);
    }
  }
  // set by the counting pass-through below, read after the fetch settles: the
  // streamed body is refused mid-flight, and what comes back has to be the 413
  // and not the 502 a broken upstream write otherwise looks like
  let overLimit = false;
  // may throw when the client hangs up mid-upload; the caller owns that (it
  // is the one holding the request that would answer 499)
  let body: ArrayBuffer | ReadableStream<Uint8Array> | undefined;
  if (!hasBody) {
    body = undefined;
  } else if (buffered) {
    // bounded by the declaration, which framed the read and was checked above
    body = await req.arrayBuffer();
    // the whole body is here, so the request is in hand and the response is
    // the server's work from now on
    onBodyRead?.();
  } else if (req.body) {
    // A STREAMED BODY IS IN HAND TOO, JUST LATER. `onBodyRead` used to fire for
    // the buffered case only, so a chunked POST - or any Content-Length over
    // PROXY_RETRY_MAX_BODY - carried clock 1 for the entire life of its
    // response, and `requestFullyRead` rightly refuses it at `fetch` entry
    // because the framing headers are there. An SSE or NDJSON reply to such a
    // request was silently truncated: measured at BORGO_FRONT_READ_TIMEOUT=30,
    // a chunked POST whose body was complete, answered by a stream with a 36s
    // gap, got `: open` and then FIN at 32.04s with no terminating chunk (8.00s
    // at =8), where the same stream behind a small buffered body ran to
    // completion at 72.11s. EventSource reconnects, so nobody sees it.
    //
    // The last byte of the body is the server's own knowledge of the moment, so
    // it is read off the stream rather than declared. An upstream that answers
    // before draining the body leaves this unfired - it is the body ending that
    // is the claim, and nothing else may stand in for it.
    //
    // THE SAME PASS-THROUGH COUNTS, and this branch is the whole of the hole:
    // it is where an undeclared body lands - chunked, or a length past
    // PROXY_RETRY_MAX_BODY - and bun's cap never sees a body a handler pipes,
    // so `Transfer-Encoding: chunked` reached go unmetered at any size.
    // Counting does not turn this into a buffering branch: nothing is held,
    // the tally is one number, and the stream is CUT at the limit rather than
    // measured after it. `flush` does not run on that cut, so `onBodyRead`
    // stays unfired - the body did not end, it was refused, and the socket is
    // still the client's.
    let read = 0;
    body = req.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          read += chunk.byteLength;
          if (maxBody > 0 && read > maxBody) {
            overLimit = true;
            controller.error(new Error(`borgo: request body over BORGO_MAX_BODY=${maxBody}`));
            return;
          }
          controller.enqueue(chunk);
        },
        flush: () => onBodyRead?.(),
      }),
    );
  } else {
    body = undefined;
  }
  // hop-by-hop headers belong to the browser -> borgo connection, not to
  // this one; built once, outside the retry loop
  const headers = forwardableHeaders(req.headers);
  // a GET or HEAD is forwarded with no body at all, so a Content-Length the
  // client sent with one is a promise we are not keeping: go's net/http reads
  // the header, runs the handler, then blocks in finishRequest draining bytes
  // that never arrive - the response never leaves, this side answers 504 after
  // the deadline, and a goroutine and a connection stay pinned for as long as
  // it lasted (forever, with BORGO_API_TIMEOUT=0, which the docs offer). One
  // header on one cheap request wedges one upstream connection.
  if (!hasBody) headers.delete("content-length");
  // Host is the same kind of thing: it addresses borgo, not go. forwarded
  // verbatim it makes go's r.Host whatever the client typed into the header,
  // and r.Host is the field go reaches for implicitly - http.Redirect's
  // absolute Location, a password-reset link, anything built from "the site's
  // own name". dropping it lets bun write the target's authority, so r.Host
  // is the api borgo actually dialled and nothing else. the browser's value
  // is not lost, it is moved to the header that declares itself untrusted.
  const inboundHost = headers.get("host");
  headers.delete("host");
  // and it is *set*, never merely defaulted. X-Forwarded-* describe the hop
  // the client made, so the client does not get to write them: leaving a
  // client-supplied X-Forwarded-Host in place moves the primitive Host was
  // just dropped to prevent exactly one header over, into the field app code
  // reaches for when it builds an absolute url or keys a rate limit. The old
  // rule ("a front proxy already set it") was not true of the deployment borgo
  // ships: its own generated nginx sets Host, X-Forwarded-For and
  // X-Forwarded-Proto, and no X-Forwarded-Host at all - so the only sender
  // that value ever had in practice was the browser. Behind a proxy the
  // inbound Host *is* the public name ($host), which is what belongs here.
  if (inboundHost) headers.set("x-forwarded-host", inboundHost);
  else headers.delete("x-forwarded-host");
  // the chain gets the real peer appended, the way nginx's
  // $proxy_add_x_forwarded_for does. what came in may be a trusted proxy's
  // chain or a client's invention and borgo cannot tell the two apart, but the
  // last entry is now always the address it read the request from - the one
  // hop it can vouch for. with no peer to append (the connection is already
  // gone) nothing travels: a chain borgo cannot sign is not evidence.
  if (clientIp) {
    const chain = headers.get("x-forwarded-for");
    headers.set("x-forwarded-for", chain ? `${chain}, ${clientIp}` : clientIp);
  } else {
    headers.delete("x-forwarded-for");
  }
  // resendable unless a real body streamed through unbuffered - a
  // body-less delete/post (body null) is as safe to retry as a get
  const retriable = !hasBody || buffered || body == null;

  for (let attempt = 0; ; attempt++) {
    // an api that accepts the connection and then never answers would
    // otherwise pin this request forever: the deadline covers the wait for
    // response headers only and is dropped once they arrive, so a stream
    // (sse) still runs for as long as it wants
    const abort = deadlineMs > 0 ? new AbortController() : null;
    let timedOut = false;
    const deadline = abort
      ? setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, deadlineMs)
      : undefined;
    try {
      // decompress: false passes go's response through untouched, encoding
      // included; bun would otherwise inflate it and resend identity
      const upstream = await fetchImpl(target, {
        method: req.method,
        headers,
        ...(hasBody ? { body } : {}),
        decompress: false,
        signal: abort?.signal,
      } as RequestInit);
      // an upstream that answers before it has drained the body can beat the
      // cut to the finish line - go is free to reply to half a request. The
      // limit decided first, whatever came back after it
      if (overLimit) {
        void upstream.body?.cancel().catch(() => {});
        return bodyTooLarge(maxBody);
      }
      // the deadline can fire while these headers are still in flight:
      // the abort has already torn the connection down, but fetch still
      // resolves, with a body that ends at zero bytes. returning it would
      // hand the browser a 200 it cannot tell from a genuinely empty
      // answer - and, on sse, a stream that is dead on arrival. the
      // timeout already decided; say so.
      if (timedOut) {
        void upstream.body?.cancel().catch(() => {});
        return new Response("api timeout", { status: 504 });
      }
      // an upgrade is hop-by-hop and this proxy has no tunnel to hand
      // over: relaying the 101 would leave the client speaking a switched
      // protocol into a socket that is still framing http, and every byte
      // after it desynchronised. app sockets belong on /ws.
      if (upstream.status === 101) {
        void upstream.body?.cancel().catch(() => {});
        onError(`${new URL(target).pathname} answered 101; /api cannot tunnel an upgrade`);
        return new Response("api upgrade not supported", { status: 502 });
      }
      // handed back untouched, body included. Worth knowing before you are
      // tempted to wrap it: Bun.serve withholds a response's headers until its
      // body produces a byte, so an upstream that opens a stream and then
      // stays quiet leaves the client waiting on fetch(). The fix belongs
      // upstream, and borgo.SSE does it - it opens with an SSE comment, so the
      // headers go out at once. Re-wrapping the body here to inject that
      // comment was tried and reverted: reading the native body through a
      // JS ReadableStream and cancelling it when the client hangs up
      // segfaults bun 1.3.14, which takes the whole front server with it.
      //
      // marked as go's: this is the ONE response on /api the security headers
      // must not be applied to, and every other answer this function returns -
      // the 504s and the 502s below - is borgo's own and carries them
      return markUpstream(upstream);
    } catch (err) {
      // FIRST, and ahead of the timeout: cutting the request body is what made
      // this fetch reject, so the error is borgo's own refusal wearing an
      // upstream failure's clothes. Answered 502 it would read as "the api is
      // down" in the operator's logs and in the client's hands, for a request
      // borgo itself refused
      if (overLimit) return bodyTooLarge(maxBody);
      if (timedOut) return new Response("api timeout", { status: 504 });
      if (retriable && attempt < retries && isConnRefused(err)) {
        await sleep(retryDelayMs);
        continue;
      }
      // an api endpoint must fail as an api: a bad gateway status, not
      // the rendered 500 page (or the dev overlay) meant for documents
      onError(err);
      return new Response("api unreachable", { status: 502 });
    } finally {
      clearTimeout(deadline);
    }
  }
}

// regenerate .borgo/api-types.d.ts (and the route mounting) from the go api.
// the tool is wired through the app's go.mod `tool` directive. returns
// success so build and export can refuse to ship stale generated files;
// dev ignores it and keeps serving
export async function runBorgogen(): Promise<boolean> {
  if (!existsSync("api")) return true;
  const proc = Bun.spawn(["go", "tool", "borgogen"], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(stderr.trimEnd());
    console.error(
      `  ${c.red(g.err)} borgogen failed - api types are stale ${c.dim("(is `tool github.com/LuigiDavideMicca/borgo/cmd/borgogen` in go.mod?)")}`,
    );
    return false;
  }
  return true;
}
