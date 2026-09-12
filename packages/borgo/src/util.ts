import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { c, g } from "./colors";
import { documentStream, gzipStream, pickEncoding } from "./compress";
import { CSRF_COOKIE, CSRF_FIELD, CSRF_HEADER, csrfCookieValue } from "./index";
import { unsafeMethod, withCsrf } from "./internal";
import { resolveHead, safeHeadAttrs, type ActionContext, type Head, type Route } from "./router";

// length compared first, then constant-time on the bytes
export const keysEqual = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// attribute values are always double-quoted, so this is the complete set
export const escapeHtml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// safeHeadAttrs lives in router.ts: the browser runtime applies the same head
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

// security headers for every response borgo builds itself; the /api proxy
// passes go's headers through untouched. the csp rides on documents and on
// svg (it runs its own scripts when navigated to directly), not on assets.
// style-src keeps 'unsafe-inline': react renders style={{}} as an attribute,
// which no nonce can cover. connect-src 'self' covers same-origin ws://
// (csp level 3). dev swaps the nonce for 'unsafe-inline' because the error
// overlay and the reload client are inline scripts built outside the render.
// BORGO_SECURITY_HEADERS=0 drops all of it; BORGO_CSP=0 drops the csp alone,
// BORGO_CSP=<policy> replaces it with {nonce} substituted per request.
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

// shape, not a list of directive names (a list lags the spec and turns every
// new directive into a boot failure). the only ambiguous shape is one bare
// word: a mistyped switch (`yes`, `on`, `2`) and a valueless directive
// (`upgrade-insecure-requests`) look the same, so that alone is refused; a
// trailing `;` is valid csp and makes the valueless directive reachable.
// a misspelling like `default_src 'self'` rides through on purpose.
const looksLikeAPolicy = (value: string): boolean => {
  // a switch word stays a switch however punctuated: `false;` must not become
  // the policy "false;"
  const bare = value.replace(/[\s;]+/g, " ").trim();
  if (SWITCH_WORDS.includes(bare.toLowerCase())) return false;
  return value.includes(";") || value.split(/\s+/).filter(Boolean).length > 1;
};

const SWITCH_WORDS = [
  "0", "1", "t", "f", "true", "false", "yes", "no", "on", "off", "enable",
  "disable", "enabled", "disabled", "none", "null", "nil", "unset", "default",
];

// asked of Headers itself rather than a character class: the rule is bun's.
// bun's message is not propagated because it embeds the raw value, newline
// and all
const headersRefuses = (value: string): boolean => {
  try {
    new Headers().set("Content-Security-Policy", value);
    return false;
  } catch {
    return true;
  }
};

// BORGO_CSP is a switch and a value in one variable: a boolean spelling is
// the switch and never a policy (`false` must not ship
// `Content-Security-Policy: false`, which browsers discard while scanners
// count it). returns false to drop the header, null for the default, or the
// operator's policy.
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
  // both forms the policy takes at request time; a value Headers.set refuses
  // would boot a server that answers 500 to everything
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
  // fails towards on: unset and empty keep the headers, unreadable refuses
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
        // rfc 9110 §8.3.1: media type is case-insensitive, and an action or
        // loader guard may hand back TEXT/HTML
        const type = (headers.get("Content-Type") ?? "").toLowerCase();
        if (type.startsWith("text/html") || type.startsWith("image/svg+xml")) {
          headers.set("Content-Security-Policy", withoutNonce);
        }
      }
      return res;
    },
  };
}

// for an inline <script>: "<" neutralizes </script> and <!--, u+2028/u+2029
// are valid json but not js for every parser. chained replaceAll beats a
// one-pass regex callback by ~20% in jsc.
export const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

// the loader after a login/logout action needs the jar as it is now. same-name
// cookies that disagree are dropped, not last-wins: go refuses them as
// ambiguous, and a rebuilt jar must not hand it a winner it would have refused
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

// presence regardless of value: a check that switches itself off on an
// unusable value is one an attacker can switch off
export function hasCookie(header: string | null, name: string): boolean {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return true;
  }
  return false;
}

export type CsrfOptions = {
  // BORGO_CSRF: on in production, off in dev; serve() resolves it once
  enforced: boolean;
};

// double-submit token: a cross-site post cannot read the cookie to echo it
export async function csrfRejects(req: Request, { enforced }: CsrfOptions): Promise<boolean> {
  if (!enforced) return false;
  const cookies = req.headers.get("cookie");
  // armed by token presence, not by a live session (login csrf) and not by a
  // readable value (a tossed duplicate must not switch the check off).
  // cookie-less clients are unaffected
  if (!hasCookie(cookies, "borgo_session") && !hasCookie(cookies, CSRF_COOKIE)) return false;
  // duplicates that disagree are no token: a sibling subdomain can toss one
  const expected = csrfCookieValue(cookies);
  if (!expected) return true;
  // clone() shares bun's body store (measured: two clones of 40mb cost 40mb);
  // same parser as the action, since a hand-rolled scan would disagree about
  // percent-encoding inside a security check
  let given = "";
  try {
    const form = await req.clone().formData();
    given = String(form.get(CSRF_FIELD) ?? "");
  } catch {}
  return !given || !keysEqual(given, expected);
}

// every variable parsed here reads 0 as "no limit", so a fraction is refused
// rather than floored: `=0.5` must not switch a limit off. "" is unset.
export function envInt(name: string, v: string | undefined, unsetMeans: string): number | undefined {
  if (envText(name, v) === undefined) return undefined;
  // Number(" ") is 0, which would be the limit switched off
  const n = v!.trim() === "" ? Number.NaN : Number(v);
  // -0 passes `>= 0` and isInteger but reaches Bun.serve as a non-integer
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

// changed files from a dev rebuild, newline-separated: a path may hold a comma
// or a space, never a newline. all of them, not one: the browser ignores an
// update naming a page other than the one on screen
export const UNKNOWN_CHANGE = "__borgo_unknown__";

export const encodeChanged = (files: readonly string[]): string => files.join("\n");

export const decodeChanged = (value: string | undefined): string[] =>
  value ? value.split("\n").filter(Boolean) : [];

// BORGO_DEV, unset = production; only dev.ts is meant to set it. value, not
// presence: `=0` must not turn dev on, and dev decides the csrf default and
// relaxes the csp
export const devMode = (env: Record<string, string | undefined>): boolean =>
  envBool("BORGO_DEV", env.BORGO_DEV, "production") ?? false;

// BORGO_RELOAD marks a restart so the banner prints its short form
export const reloadBanner = (env: Record<string, string | undefined>): boolean =>
  envBool("BORGO_RELOAD", env.BORGO_RELOAD, "the full banner") ?? false;

// what `borgo start` must have in its LAUNCH environment, defaulted only.
// both values are read before any module code can assign them: bun sizes its
// fetch pool at boot, and bun's jsx transform for a page can be pinned before
// server.ts runs a line - a mid-module NODE_ENV default left a jsxDEV-compiled
// layout meeting the production react-dom, which is a render crash
// (`dispatcher.getOwner is not a function`), so the only reliable place is
// the environment of the process itself, set by the re-exec in cli.ts
// || rather than ??, deliberately: the re-exec fires on a falsy value, so a
// defaulting that preserves the empty string (`NODE_ENV=` in a .env) would
// hand the child the same falsy value and the child would re-exec again -
// forever. the invariant the test pins: one re-exec always settles it.
// whitespace trims to the same fate as empty: `NODE_ENV=" "` is nobody's
// deliberate mode, and passed through it reached react as a non-production
// value on a production server
const settled = (v: string | undefined): string | undefined => (v?.trim() ? v.trim() : undefined);
export const startEnv = (env: Record<string, string | undefined>): Record<string, string> => ({
  BUN_CONFIG_MAX_HTTP_REQUESTS: settled(env.BUN_CONFIG_MAX_HTTP_REQUESTS) || "16384",
  NODE_ENV: settled(env.NODE_ENV) || "production",
});

export const startNeedsReexec = (env: Record<string, string | undefined>): boolean =>
  !settled(env.BUN_CONFIG_MAX_HTTP_REQUESTS) || !settled(env.NODE_ENV);

// go's strconv.ParseBool grammar, exactly: SESSION_SECURE is read by both
// halves and `true` must not give the session cookie Secure and the csrf
// cookie not
const BOOL_TRUE = ["1", "t", "T", "true", "TRUE", "True"];
const BOOL_FALSE = ["0", "f", "F", "false", "FALSE", "False"];

// the grammar as a question, for BORGO_CSP which is a switch and a value
export const boolish = (v: string): boolean | undefined =>
  BOOL_TRUE.includes(v) ? true : BOOL_FALSE.includes(v) ? false : undefined;

// a control character is refused, not trimmed, for every variable alike: a
// windows .env puts \r on every line, and Headers.set would drop a trailing
// CR in silence while storing VT, FF and BEL verbatim. "" is unset
export function envText(name: string, v: string | undefined): string | undefined {
  if (v === undefined || v === "") return undefined;
  // C0 and DEL; JSON.stringify keeps the raw CR out of the message
  const at = v.search(/[\u0000-\u001f\u007f]/);
  if (at === -1) return v;
  throw new Error(
    `borgo: ${name}: invalid value ${JSON.stringify(v)} ` +
      `(a control character at position ${at}; a trailing \\r is what a .env file ` +
      `authored on windows puts on every line - strip it rather than letting borgo guess)`,
  );
}

// ParseBool grammar, undefined when unset, refuses what it cannot read. every
// switch goes through here; util.test.ts enumerates them against one alphabet
export function envBool(name: string, v: string | undefined, unsetMeans: string): boolean | undefined {
  if (envText(name, v) === undefined) return undefined;
  const parsed = boolish(v as string);
  if (parsed !== undefined) return parsed;
  throw new Error(
    `borgo: ${name}: invalid value ${JSON.stringify(v)} ` +
      `(want "1"/"true" or "0"/"false"; unset means ${unsetMeans})`,
  );
}

export function sessionSecure(env: Record<string, string | undefined>): boolean {
  return envBool("SESSION_SECURE", env.SESSION_SECURE, "not secure") ?? false;
}

// BORGO_CSRF: unset = on in production, off in dev
export const csrfEnabled = (dev: boolean, env: Record<string, string | undefined>): boolean =>
  envBool("BORGO_CSRF", env.BORGO_CSRF, dev ? "off in dev" : "on") ?? !dev;

// BORGO_MAX_BODY (bytes), 0 = no limit; the read in server.ts argues the number
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

export type Switches = {
  dev: boolean;
  security: Security | null;
  csrfEnforced: boolean;
  csrfCookieAttrs: string;
  reloading: boolean;
  maxBody: number;
  // a /ws handshake with no Origin is a non-browser client; off by default
  wsAllowNoOrigin: boolean;
  // BORGO_RENDER=1: this process is the render service behind the go front
  // (front.go): bound to loopback, answering only requests that carry the
  // key the front minted for this boot, and reaching the api on the front's
  // own loopback listener with the same key
  render: boolean;
  internalKey: string;
  renderPort: number;
};

// the header both processes put the boot key in, and the one the front
// uses to hand over a session it has already verified
export const INTERNAL_KEY_HEADER = "X-Borgo-Internal";
export const SESSION_HEADER = "X-Borgo-Session";

// The session a loader or an action sees. Read ONLY in render mode: there the
// boot key was checked at the top of fetch, so the header was written by the
// go front, which deletes any client's own spelling before setting it. A
// render service started without a front - serve() called by an embedder or
// a test - receives the same header straight from whoever sent the request,
// and reading it there would be believing a session somebody typed. The
// failure direction is always "no session", never "somebody's session":
// absent, not render mode, not base64url, not a json object - all null.
export function sessionFrom(req: Request, render: boolean): import("./router").Session | null {
  if (!render) return null;
  const raw = req.headers.get(SESSION_HEADER);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as import("./router").Session)
      : null;
  } catch {
    return null;
  }
}
// the go front's page cache asks for a shared render with this header: the
// request arrives anonymised, the render mints no csrf token, and the
// response is drained here so the errored-render mark can travel as a header
export const SHARED_RENDER_HEADER = "X-Borgo-Shared";
// on every response in render mode: the go front reloads the page policy
// table when the stamp changes, i.e. when this process was restarted
export const BOOT_HEADER = "X-Borgo-Boot";
export const ROUTES_PATH = "/__borgo/routes";
export const INTERNAL_KEY_MIN_LEN = 32;
export const RENDER_PORT_DEFAULT = 3600;

// whether a request reaching the render service is the front's: the key is
// compared in constant time and a request without one is a stranger on the
// box, not a browser - the public port never forwards a client's own value
export function internalKeyRejects(req: Request, key: string): boolean {
  const presented = req.headers.get(INTERNAL_KEY_HEADER);
  return presented === null || !keysEqual(presented, key);
}

// every switch resolved above serve-entry's try: a refusal thrown inside
// serve() is caught and answered from the fallback server's bound port, with
// fewer security headers than a server that had accepted the value. dev is a
// parameter because `borgo start` and `borgo export` serve production
// whatever BORGO_DEV says
export function resolveSwitches(
  env: Record<string, string | undefined>,
  dev: boolean = devMode(env),
): Switches {
  return {
    dev,
    security: createSecurity(dev, { headers: env.BORGO_SECURITY_HEADERS, csp: env.BORGO_CSP }),
    csrfEnforced: csrfEnabled(dev, env),
    csrfCookieAttrs: `Path=/; SameSite=Lax${sessionSecure(env) ? "; Secure" : ""}`,
    reloading: reloadBanner(env),
    maxBody: envInt("BORGO_MAX_BODY", env.BORGO_MAX_BODY, `${MAX_BODY_BYTES} bytes`) ?? MAX_BODY_BYTES,
    wsAllowNoOrigin: envBool("BORGO_WS_ALLOW_NO_ORIGIN", env.BORGO_WS_ALLOW_NO_ORIGIN, "refused") ?? false,
    ...renderSwitches(env),
  };
}

// The topology every borgo command runs: the go binary answers the public
// port and the bun process beside it is the render service behind it. One
// boot key, minted here unless the operator set a usable one; both halves
// take their addresses from this one object, so they cannot disagree.
export type FrontTopology = {
  publicPort: number;
  apiPort: number;
  renderPort: number;
  key: string;
};

export function frontTopology(env: Record<string, string | undefined>): FrontTopology {
  let key = env.BORGO_INTERNAL_KEY ?? "";
  if (key.length < INTERNAL_KEY_MIN_LEN) {
    // said, not silent: an operator who set a short key and later tries it
    // by hand against the internal listener would be refused with no hint why
    if (key) {
      console.error(
        `  BORGO_INTERNAL_KEY is shorter than ${INTERNAL_KEY_MIN_LEN} bytes and is not used: a key minted for this boot replaces it`,
      );
    }
    key = mintInternalKey();
  }
  return {
    publicPort: envInt("PORT", env.PORT, "3000") ?? 3000,
    apiPort: envInt("API_PORT", env.API_PORT, "3501") ?? 3501,
    renderPort: envInt("BORGO_RENDER_PORT", env.BORGO_RENDER_PORT, String(RENDER_PORT_DEFAULT)) ?? RENDER_PORT_DEFAULT,
    key,
  };
}

// 32 random bytes as hex: the floor the go side holds the key to, doubled
export function mintInternalKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// what the go binary needs to be the front: naming the render service is
// what makes it one, so there is no flag to set
export const goFrontEnv = (t: FrontTopology): Record<string, string> => ({
  PORT: String(t.publicPort),
  API_PORT: String(t.apiPort),
  BORGO_INTERNAL_KEY: t.key,
  BORGO_RENDER_URL: `http://127.0.0.1:${t.renderPort}`,
});

// what this process, or the one it spawns, needs to be the render service
export const renderEnv = (t: FrontTopology): Record<string, string> => ({
  BORGO_RENDER: "1",
  BORGO_RENDER_PORT: String(t.renderPort),
  BORGO_INTERNAL_KEY: t.key,
  API_PORT: String(t.apiPort),
});

// what a go child is handed by a process that has already become the render
// service: that process's environment, minus the render half's own switches.
// borgo start and borgo export assign renderEnv to process.env and then
// spread process.env into the go binary, so every go child was carrying
// BORGO_RENDER=1. Go reads neither name today, which is exactly when a name
// reaching the wrong process is cheapest to take away
export function withoutRenderEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const { BORGO_RENDER: _render, BORGO_RENDER_PORT: _renderPort, ...rest } = env;
  return rest;
}

// the render half of the switches: a render service without a usable key is
// a loopback listener anyone on the box can drive, so it refuses to boot
function renderSwitches(env: Record<string, string | undefined>) {
  const render = envBool("BORGO_RENDER", env.BORGO_RENDER, "a public front server") ?? false;
  const internalKey = env.BORGO_INTERNAL_KEY ?? "";
  if (render && internalKey.length < INTERNAL_KEY_MIN_LEN) {
    throw new Error(
      `borgo: BORGO_INTERNAL_KEY must be set to at least ${INTERNAL_KEY_MIN_LEN} bytes in render mode ` +
        `(the go front mints one per boot; by hand: openssl rand -base64 48)`,
    );
  }
  return {
    render,
    internalKey,
    renderPort: envInt("BORGO_RENDER_PORT", env.BORGO_RENDER_PORT, String(RENDER_PORT_DEFAULT)) ?? RENDER_PORT_DEFAULT,
  };
}

// who may POST /__borgo/publish. a key presented to a side that holds none is
// refused, not dropped to the loopback rule: loopback admits every process on
// the box. with a key on both sides loopback and forwarding do not apply
export type PushVerdict = "ok" | "bad-key" | "half-configured" | "not-local";

// presence, never content: an empty X-Forwarded-For is still a hop, and every
// header a proxy stamps counts (borgo's nginx sets X-Forwarded-Proto)
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
  // isForwarded, never a header value
  forwarded: boolean;
}): PushVerdict {
  if (req.key) return keysEqual(req.presented ?? "", req.key) ? "ok" : "bad-key";
  if (req.presented !== null) return "half-configured";
  const local =
    req.address === "127.0.0.1" || req.address === "::1" || req.address === "::ffff:127.0.0.1";
  return local && !req.forwarded ? "ok" : "not-local";
}

// a comma inside a topic would be split on the wire (/ws?topics=a,b) and the
// push would land in a topic with no subscribers, 101 and counters intact.
// refused rather than escaped: three producers would have to agree on the escape
export const TOPIC_SEPARATOR = ",";

export const topicRejection = (topic: string): string | null =>
  topic.includes(TOPIC_SEPARATOR)
    ? `topic ${JSON.stringify(topic)} contains ${JSON.stringify(TOPIC_SEPARATOR)}, which separates topics ` +
      `on the wire (/ws?topics=a,b) and cannot appear inside one - rename the topic`
    : null;

// a websocket handshake carries cookies with no preflight, so Origin is the
// only guard: scheme and host, not host alone (http://app.test must not join
// https://app.test), and no Origin is a refusal. X-Forwarded-Proto is trusted
// here because anything that can set it can set Origin too.
// BORGO_WS_ALLOW_NO_ORIGIN=1 re-admits every non-browser caller, on purpose
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
    // "null" (sandboxed iframe, cross-origin redirect) fails to parse: refused
    origin = new URL(req.origin);
  } catch {
    return false;
  }
  return origin.host === req.host && origin.protocol === `${scheme}:`;
}

export const goBinName = () => "api" + (process.platform === "win32" ? ".exe" : "");

// a refused connection never reached the api, so the typed client may
// retry it - the one thing the deleted proxy and that client shared
export const isConnRefused = (err: unknown) => {
  const e = err as { code?: string; message?: string };
  return e?.code === "ConnectionRefused" || e?.code === "ECONNREFUSED" || /unable to connect|refused/i.test(e?.message ?? "");
};

// rfc 9112 §6.3: a repeated Content-Length reaches Headers as "5, 5" and
// must agree. not Number(): it takes "", "0x10", "1e3" and " 5 "
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

// the size a body is framed by, null when nothing frames it. bun answers the
// smuggling pair (both headers) 400 itself, but proxyRequest and runAction
// are exported and the next caller may not be bun
export function framedLength(headers: Headers): number | null {
  if (headers.get("transfer-encoding") !== null) return null;
  const raw = headers.get("content-length");
  return raw === null ? null : parseContentLength(raw);
}

// BORGO_MAX_BODY counts bytes as they are read, not bun's maxRequestBodySize:
// that one caps a declared Content-Length only, a chunked 1 MiB under a cap
// of 64 reached the handler whole, and `maxRequestBodySize: 0` refuses every
// body rather than none
export const bodyTooLarge = (limit: number) =>
  new Response(`request body too large (over BORGO_MAX_BODY=${limit})\n`, {
    status: 413,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

// null the moment the read passes limit; the crossing chunk is dropped, so
// memory is limit plus one socket read, never the body
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
  // no copy for one chunk; the cast drops the SharedArrayBuffer a socket read
  // never produces, which BodyInit will not take
  if (chunks.length === 1) return chunks[0] as Uint8Array<ArrayBuffer>;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

// null when too big: a declared length over the limit is refused unread, any
// other framing is counted as it arrives. shares the abort signal, since
// runAction and serve() both ask it. limit 0 and a body-less request pass
// through untouched
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

// a head renders for real and drops only the body, cancelled so the ssr/gzip
// pipeline stops. a null body is a claim: bun frames it as Content-Length: 0,
// which for an unmeasured response is a lie, so a closed stream is used
// instead and bun frames the head as it framed the get
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

// set-cookies collected from the api ride out on whatever response ends the
// request
export function withCookies(res: Response, cookies: string[]): Response {
  if (!cookies.length) return res;
  const headers = new Headers(res.headers);
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(res.body, { status: res.status, headers });
}

// dev client for a zero-js page: css swaps in place, anything else reloads.
// it also sets __BORGO_DEV__, because islands run js on a page that emits no
// props script, and without the flag registerServiceWorker installs a caching
// worker over a dev session
export const DEV_INLINE_CLIENT =
  "<script>window.__BORGO_DEV__=1;(()=>{const c=()=>{const w=new WebSocket(`ws://${location.host}/__borgo/dev`);" +
  'w.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.type==="css"){for(const l of document.querySelectorAll(\'link[rel="stylesheet"]\'))l.href=l.href.split("?")[0]+"?t="+Date.now();}' +
  'else if(!m.stamp||(m.stamp>performance.timeOrigin&&Number(sessionStorage.getItem("borgo:devstamp")||0)<m.stamp)){if(m.stamp)sessionStorage.setItem("borgo:devstamp",String(m.stamp));location.reload();}};' +
  "w.onclose=()=>setTimeout(c,300);};c();})()</script>";

export type ShellParts = {
  // everything before <!--app-->, untouched
  start: string;
  // as text, not markup: the browser runtime assigns it to document.title
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

// which emitted file each name an index.html is written against became
export type AssetNames = Record<string, string>;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// escapeHtml emits the first four; apos is what an author types
const NAMED_REFS: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

// <title> holds html, document.title holds text: `Tom &amp; Jerry` must not
// reach the tab on the first client navigation. an unknown reference is left
// as written rather than half-decoded
export const decodeHtmlText = (s: string): string =>
  s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ref: string) => {
    const named = NAMED_REFS[ref.toLowerCase()];
    if (named !== undefined) return named;
    if (ref[0] !== "#") return whole;
    const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    // fromCodePoint throws out of range and yields a lone surrogate in range
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return whole;
    }
    return String.fromCodePoint(code);
  });

// index.html keeps naming /assets/client.js while the build emits hashed
// names; an unrecorded name is left alone (a revalidation, not a 404)
export function resolveAssetUrls(shell: string, names: AssetNames): string {
  let resolved = shell;
  for (const [logical, emitted] of Object.entries(names)) {
    if (emitted && emitted !== logical) {
      resolved = resolved.replaceAll(`/assets/${logical}`, `/assets/${emitted}`);
    }
  }
  return resolved;
}

// scanned once at boot so a render only concatenates strings
export function prepareShell(source: string, dev: boolean, names: AssetNames = {}): ShellParts {
  let shell = resolveAssetUrls(source, names);
  // the refresh prelude must finish before any app chunk evaluates, and
  // module scripts in document order are the one sequencing the chunk graph
  // cannot reshuffle: injected ahead of the client tag, dev only
  if (dev) {
    shell = shell.replace(
      /(<script\b[^>]*src="\/assets\/(?:client|islands-client)[^"]*"[^>]*><\/script>)/,
      '<script type="module" src="/assets/refresh.js"></script>$1',
    );
  }
  const [start, end = ""] = shell.split("<!--app-->");
  // decoded once: downstream sees the title as data
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
  // any attribute order on the client script tag; matched on the resolved
  // name the shell now carries
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
  // a render whose output may be served to more than one visitor (isr): no
  // csrf cookie is minted and no token reaches the bytes - a page that uses
  // <CsrfField /> still renders the field, which is exactly how the cache's
  // residue check catches it and refuses to share the copy
  sharedRender?: boolean;
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
  // the local-path redaction, over the props json and the head alike
  redactText?: (text: string) => string;
  // injectable for tests
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

  // one token for the cookie and every <CsrfField />. a shared render mints
  // nothing: a token frozen into a copy served to everyone matches nobody's
  // cookie, so the field renders empty and the cache's residue check refuses
  // the page rather than sharing a broken form that looks like a working one
  const cookieToken = options.sharedRender ? "" : csrfCookieValue(req.headers.get("cookie"));
  const csrfToken = options.sharedRender ? "" : cookieToken || randomToken();
  if (!cookieToken && !options.sharedRender) {
    apiCookies.push(`${CSRF_COOKIE}=${csrfToken}; ${csrfCookieAttrs}`);
  }

  // minted before the render: react's own suspense scripts need the nonce
  const nonce = security?.needsNonce ? randomToken() : "";

  // serialized before the render: a bigint or a cycle throws here, and a
  // render already in flight would be walked to the end for nobody
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
    // no props and no client script; islands get their own entry
    end = route.islands ? shell.zeroJsEnd.islands : shell.zeroJsEnd.plain;
  } else {
    const tag = nonce ? `<script nonce="${nonce}">` : "<script>";
    end = `${shell.endProps[0]}${tag}window.__PROPS__=${propsJson}${shell.stateTail}${shell.endProps[1]}`;
  }

  // react-dom's bun build misbehaves under a manual reader pump
  const body = documentStream(start, stream, end);

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    Vary: "Accept-Encoding",
  });
  if (nonce) headers.set("Content-Security-Policy", security!.cspFor(nonce));
  for (const c of apiCookies) headers.append("Set-Cookie", c);
  // gzip only, brotli is too slow for dynamic responses; no size threshold,
  // a stream's length is unknown up front
  if (!dev && pickEncoding(req.headers.get("accept-encoding"), ["gzip"])) {
    headers.set("Content-Encoding", "gzip");
    return new Response(gzipStream(body), { status, headers });
  }
  return new Response(body, { status, headers });
}

// an action's own headers survive the translation to json. location and
// set-cookie are re-stated by the envelope and the append below, content-*
// would describe a body this response no longer carries
export function carryHeaders(from: Response, json: Response): Response {
  const headers = new Headers(json.headers);
  from.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "location" || k === "set-cookie" || k.startsWith("content-")) return;
    headers.set(key, value);
  });
  for (const c of from.headers.getSetCookie()) headers.append("Set-Cookie", c);
  // the body goes nowhere and holds whatever is behind it (an upstream
  // socket, a file handle) until cancelled; a hand-built 302 often has one
  void from.body?.cancel().catch(() => {});
  return new Response(json.body, { status: json.status, headers });
}

// the loader after an action sees the jar as the action left it
export function freshCookieRequest(req: Request, setCookies: string[]): Request {
  if (!setCookies.length) return req;
  const headers = new Headers(req.headers);
  const cookie = freshCookieHeader(req.headers.get("cookie"), setCookies);
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");
  return new Request(req.url, { method: req.method, headers });
}

// the match a request already did, handed on
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
  // bytes, 0 for no limit. not optional: a limit absent by default fails open
  maxBody: number;
  // the api client bound to this request's cookies, collecting set-cookie
  apiFor: (req: Request, onSetCookie?: (cookies: string[]) => void) => ActionContext["api"];
  // the verified session for this request (sessionFrom). Optional because
  // absent reads as "nobody", which is the safe default
  sessionFor?: (req: Request) => ActionContext["session"];
  runLoader: RunLoaderFn;
  renderPage: RenderPageFn;
  sendJson: SendJsonFn;
  // overlayHtml in dev; never called in production
  renderOverlay: (error: unknown) => string;
  // injectable for tests
  onError?: (value: unknown) => void;
};

// a POST on the page routes; null for "not mine" (the caller answers 405).
// X-Borgo-Action: 1 gets json (props + actionData, or a redirect), a no-js
// post gets the document. X-Borgo marks every enhanced answer (action = json
// envelope, raw = a document to swap in); unmarked means the runtime reloads
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
    sessionFor = () => null,
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
    // before the csrf check, which clones and parses the whole body
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
        session: sessionFor(req),
      });
      if (result instanceof Response) {
        const location = result.headers.get("Location");
        if (wantsJson && location) {
          return withCookies(carryHeaders(result, actionJson({ redirect: location })), apiCookies);
        }
        // case-insensitive: the action owns this content-type
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
      // awaited, not returned: the catch below must see this render fail
      return await renderPage(
        freshReq,
        target.route,
        target.params,
        200,
        { actionData: result },
        apiCookies,
      );
    } catch (error) {
      // the 500 is rendered here when cookies were collected: an action that
      // logged in through go and then threw must not drop the session cookie.
      // a client already gone is serve()'s 499, enhanced or native alike, and
      // is checked first so a cookie-less client cannot buy a _500 render
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
      // the enhanced flow gets the same document as the native one, with the
      // same cookies, not a silent reload
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

// ?__borgo=props: the next page's loader data alone, never cached
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

// regenerates .borgo/api-types.d.ts via go.mod's `tool` directive; build and
// export refuse on false, dev keeps serving
export async function runBorgogen(): Promise<boolean> {
  if (!existsSync("api")) return true;
  const proc = Bun.spawn(["go", "tool", "borgogen"], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(stderr.trimEnd());
    // the go.mod hint only when the failure IS the missing tool: printed on
    // a plain syntax error it sent the reader to go.mod for a bug in their
    // own handler (observed)
    const toolMissing = /no required module provides package|unknown tool|is not a tool/i.test(stderr);
    console.error(
      `  ${c.red(g.err)} borgogen failed - api types are stale${toolMissing ? ` ${c.dim("(is `tool github.com/LuigiDavideMicca/borgo/cmd/borgogen` in go.mod?)")}` : ""}`,
    );
    return false;
  }
  return true;
}
