import { Glob } from "bun";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, sep } from "node:path";
import { c, g } from "./colors";
import { NO_BUILD_OUTPUTS, precompressAssets, type BuildOutputs } from "./compress";
import { stampWorkerFile } from "./pwa";
import { filePathToPattern } from "./router";
import { metricsEnabled, type AssetNames } from "./util";

const outDir = "public/assets";
const genDir = ".borgo";
const buildModePath = `${genDir}/build-mode`;

// which kind of build last wrote public/assets. `borgo start` must not
// silently serve what `borgo dev` left there (dev react, no precompression),
// nor what `borgo export` left there: an export build compiles the props
// endpoint out of the bundle, so every client navigation under `borgo start`
// would degrade to a full document reload with nothing on screen to say why.
export type BuildMode = "dev" | "production" | "export";

export function buildModeFor(dev: boolean, env: NodeJS.ProcessEnv = process.env): BuildMode {
  if (dev) return "dev";
  return env.BORGO_STATIC === "1" ? "export" : "production";
}

// `recorded` separates "no build has run here" from "a build-mode is on disk
// and it is not one borgo writes" - an empty file, a truncated one, a `DEV`
// some editor upper-cased. Both are unknown, and the two lines they earn name
// different things to go and look at.
export type BuildModeRead = { mode: BuildMode | null; recorded: boolean };

export function readBuildMode(path = buildModePath): BuildModeRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { mode: null, recorded: false };
  }
  const mode = raw.trim();
  return mode === "dev" || mode === "production" || mode === "export"
    ? { mode, recorded: true }
    : { mode: null, recorded: true };
}

export function assetsBuildMode(path = buildModePath): BuildMode | null {
  return readBuildMode(path).mode;
}

/**
 * Why `borgo start` has to rebuild before serving, or null to serve what is here.
 *
 * The guard used to be `mode === "dev" || mode === "export"`, so every way of
 * not knowing - no file, an empty one, garbage, `DEV` - fell through to
 * serving. That is the guard failing toward the outcome it exists to prevent:
 * an unreadable stamp is the state a dev tree reaches by having its `.borgo`
 * half-copied, and the reward for guessing right is nothing while the cost of
 * guessing wrong is a development bundle on a production port, silently.
 *
 * So only the stamp that says "production" in so many words is served. Doubt
 * rebuilds: the price is one build.
 */
export function rebuildBeforeServing(read: BuildModeRead = readBuildMode()): string | null {
  if (read.mode === "production") return null;
  if (read.mode === "dev") return "public/assets holds a dev build";
  if (read.mode === "export") return "public/assets holds a static export build";
  return read.recorded
    ? `${buildModePath} does not say which build public/assets holds`
    : "nothing here records which build public/assets holds";
}

// the mark a build leaves on the tree while it is running, removed only when
// it has written everything it promises. See buildLeftUnfinished.
const incompletePath = `${genDir}/build-incomplete`;

export function markBuildStarted(path = incompletePath) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${new Date().toISOString()}\n`);
}

export function clearBuildMark(path = incompletePath) {
  rmSync(path, { force: true });
}

/**
 * Whether the last build here stopped somewhere in the middle.
 *
 * generateManifest writes `.borgo/routes.gen.tsx` before anything can fail, so
 * the very first thing a failed build did was to erase the evidence that it was
 * needed: the boot after it found a manifest and a public/assets from the last
 * build that worked, decided there was nothing to do, and served the old assets
 * without a word. An error that deletes its own cause is worse than one that
 * stays - the operator reads the failure once, fixes nothing, restarts, and is
 * told everything is fine.
 *
 * The mark is written before the manifest and removed after the last byte of a
 * successful build, so the state in between is legible to whoever boots next.
 */
export function buildLeftUnfinished(path = incompletePath): boolean {
  return existsSync(path);
}

const dynamicSegments = (pattern: string) =>
  pattern.split("/").filter((s) => s.startsWith(":")).length;

// paths the front server answers before the route table is consulted at all:
// everything under /api/ is proxied to go, /__borgo/ is the dev channel and
// the push endpoint, and the last three are borgo's own. a page generated for
// one of them is dead code that the startup route table still prints as if it
// worked, so it is called out where it is generated.
const RESERVED_PREFIXES: Array<[string, string]> = [
  ["/api/", "proxied to the go api"],
  ["/__borgo/", "borgo's own dev and push endpoints"],
];
const RESERVED_PATHS: Array<[string, string]> = [
  ["/ws", "the websocket endpoint"],
  ["/healthz", "the health probe"],
];
// the server only claims /metrics with BORGO_METRICS=1 (server.ts asks
// metricsEnabled, which is why this asks the same function rather than
// repeating the variable name). listing it unconditionally called a perfectly
// reachable page dead on every build that never enabled metrics.
const METRICS_PATH: [string, string] = ["/metrics", "the metrics endpoint (BORGO_METRICS=1)"];

export type DeadRoute = { pattern: string; file: string; owner: string };

export function reservedRoutes(
  pages: Array<{ pattern: string; file: string }>,
  env: NodeJS.ProcessEnv = process.env,
): DeadRoute[] {
  const paths = metricsEnabled(env) ? [...RESERVED_PATHS, METRICS_PATH] : RESERVED_PATHS;
  const dead: DeadRoute[] = [];
  for (const { pattern, file } of pages) {
    const exact = paths.find(([path]) => path === pattern);
    const prefix = RESERVED_PREFIXES.find(([start]) => pattern.startsWith(start));
    const owner = exact?.[1] ?? prefix?.[1];
    if (owner) dead.push({ pattern, file, owner });
  }
  return dead;
}

// the warning, printed wherever a route table is about to be believed. it used
// to live inside generateManifest alone, which is the one place `borgo start`
// on a pre-built tree never reaches: the startup table listed the dead route
// like any other and nothing said it could never answer.
export function warnDeadRoutes(
  pages: Array<{ pattern: string; file: string }>,
  env: NodeJS.ProcessEnv = process.env,
): DeadRoute[] {
  const dead = reservedRoutes(pages, env);
  for (const route of dead) {
    console.warn(
      `  ${c.red(g.err)} pages/${route.file} routes ${route.pattern}, which never reaches the router ` +
        `${g.dot} ${route.owner} answers it first`,
    );
  }
  return dead;
}

async function writeIfChanged(path: string, content: string) {
  const file = Bun.file(path);
  const current = (await file.exists()) ? await file.text() : "";
  if (current !== content) await Bun.write(path, content);
}

// the hydrate export must be a literal so it can be read without executing the
// page - which means the text is all there is, and the text lies. `//` and
// `/* */` hold code that is not code, string and template literals hold text
// that looks like code, and a regex literal holds quotes that are not quotes.
// scanCode blanks the comments (keeping every offset, so line anchors still
// mean lines) and reports where the surviving literals are, so a match inside
// one can be told from a real export.
type Scan = { code: string; strings: Array<[number, number]> };

// where a `/` starts a regex rather than divides: after an operator, an
// opening bracket, a statement end, or one of the keywords that can only be
// followed by an expression
const REGEX_BEFORE = /(?:^|[^\p{L}\p{N}_$])(return|typeof|instanceof|in|of|case|do|else|yield|await|void|delete|new|throw)$/u;

function regexCanStart(tail: string): boolean {
  if (!tail) return true;
  if ("(,=:[!&|?{};+-*%~^<>".includes(tail[tail.length - 1])) return true;
  return REGEX_BEFORE.test(tail);
}

export function scanCode(source: string): Scan {
  // split(""), not [...source]: code units, so every index below is the index
  // String.prototype.indexOf and RegExp.lastIndex speak
  const chars = source.split("");
  const strings: Array<[number, number]> = [];
  // blanked, not removed: every later offset - and every `^` in a multiline
  // match - has to keep meaning what it meant in the original source
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < chars.length; k++) if (chars[k] !== "\n") chars[k] = " ";
  };
  // the last few significant characters, which is all `regexCanStart` reads
  let tail = "";
  const push = (ch: string) => {
    tail = (tail + ch).slice(-12);
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      const end = nl === -1 ? source.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === ch) {
          i++;
          closed = true;
          break;
        }
        // ' and " cannot hold a raw newline, so an unterminated one is not a
        // string at all: it is an apostrophe in jsx text (<p>don't</p>), and
        // letting it run to the next quote in the file is how a real export
        // ends up inside a "string" and goes missing
        if (source[i] === "\n" && ch !== "`") break;
        i++;
      }
      if (!closed && ch !== "`") {
        i = start + 1;
        push(ch);
        continue;
      }
      // a template literal's ${...} does hold real code, but nothing inside an
      // interpolation can be a top-level export: the whole literal is one span
      strings.push([start, i]);
      push(ch);
      continue;
    }
    if (ch === "/" && regexCanStart(tail)) {
      i++;
      let inClass = false;
      while (i < source.length) {
        const r = source[i];
        if (r === "\\") {
          i += 2;
          continue;
        }
        if (r === "\n") break;
        i++;
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
      }
      push("/");
      continue;
    }
    if (!/\s/.test(ch)) push(ch);
    i++;
  }
  return { code: chars.join(""), strings };
}

// anchored to the start of a line: an `export` is a top-level statement, so
// anything indented into an expression is not one
const hydrateRe = /^[ \t]*export\s+const\s+hydrate\s*(?::[^=\n]+)?=\s*(false|true|["']visible["'])/gm;

export function parseHydrate(source: string): "false" | "true" | '"visible"' {
  const { code, strings } = scanCode(source);
  for (const match of code.matchAll(hydrateRe)) {
    const at = match.index;
    if (strings.some(([from, to]) => at >= from && at < to)) continue;
    return match[1] === "false" ? "false" : match[1] === "true" ? "true" : '"visible"';
  }
  return "true";
}

/**
 * A reference whose spelling only a case-insensitive filesystem forgives.
 *
 * `public/Logo.png` on disk and `/logo.png` in a page is served by windows and
 * by macos - in dev and in production alike, because both serving paths end at
 * the same fold - and answered 404 by linux. Nothing in the build, the export
 * or the doctor compared the two spellings, so the app works on the machine it
 * is written on and breaks on the machine it is deployed to, which for a chunk
 * or the stylesheet is a page that never hydrates.
 *
 * The rule is deliberately narrow, and that is the whole design: a reference
 * that matches nothing at all is ignored - it is a route, an api path, an
 * external url or a name assembled at runtime, and guessing about those is how
 * a warning earns the right to be ignored. Only a reference that misses on an
 * exact match and hits on a folded one is reported, which is provably a file
 * that exists under another spelling.
 */
export type CaseMismatch = { ref: string; onDisk: string[]; source: string };

// an absolute url path carrying an extension, and only where the leading slash
// is not itself part of something longer: `https://cdn/x/Logo.png` and
// `./logo.png` are both refused by the lookbehind
const ASSET_REF = /(?<![\p{L}\p{N}.:/_-])\/[\p{L}\p{N}._~%@+-]+(?:\/[\p{L}\p{N}._~%@+-]+)*\.[\p{L}\p{N}]{1,8}/gu;

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const TEXT_EXT = new Set([".html", ".css", ".scss", ".json", ".webmanifest"]);
// at any depth, because a linked workspace puts a node_modules under a package
const SKIP_DIRS = new Set(["node_modules", "dist"]);
// public/assets is the build's own output: its references were written by the
// bundler with the spelling it wrote the files under, so they cannot diverge
const SKIP_PATHS = new Set(["public/assets"]);
const MAX_SOURCE_BYTES = 512 * 1024;

// in code the candidates are taken from string literals only, so a path in a
// comment or inside a regex is not a reference
export function scanAssetRefs(source: string, code: boolean): string[] {
  const found: string[] = [];
  if (!code) {
    for (const match of source.matchAll(ASSET_REF)) found.push(match[0]);
    return found;
  }
  const scan = scanCode(source);
  for (const match of scan.code.matchAll(ASSET_REF)) {
    const at = match.index;
    if (scan.strings.some(([from, to]) => at >= from && at < to)) found.push(match[0]);
  }
  return found;
}

function* walkSources(root: string): Generator<string> {
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || SKIP_PATHS.has(child)) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(child);
      } else if (entry.isFile()) yield child;
    }
  }
}

export function collectAssetRefs(root = "."): Array<{ url: string; source: string }> {
  const refs: Array<{ url: string; source: string }> = [];
  for (const rel of walkSources(root)) {
    const ext = extname(rel).toLowerCase();
    const code = CODE_EXT.has(ext);
    if (!code && !TEXT_EXT.has(ext)) continue;
    const path = join(root, rel);
    try {
      if (statSync(path).size > MAX_SOURCE_BYTES) continue;
      for (const url of scanAssetRefs(readFileSync(path, "utf8"), code)) refs.push({ url, source: rel });
    } catch {}
  }
  return refs;
}

// the served urls of everything in public/, spelled as the directory spells it
export function publicAssetUrls(dir = "public"): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  const base = dir.replaceAll("\\", "/").replace(/\/+$/, "");
  const urls: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    urls.push(join(entry.parentPath, entry.name).replaceAll("\\", "/").slice(base.length));
  }
  return urls;
}

export function caseOnlyMismatches(
  refs: Iterable<{ url: string; source: string }>,
  urls: Iterable<string>,
): CaseMismatch[] {
  const exact = new Set(urls);
  const folded = new Map<string, string[]>();
  for (const url of exact) {
    const key = url.toLowerCase();
    const hits = folded.get(key);
    if (hits) hits.push(url);
    else folded.set(key, [url]);
  }
  const found: CaseMismatch[] = [];
  const seen = new Set<string>();
  for (const { url, source } of refs) {
    if (exact.has(url)) continue;
    const hits = folded.get(url.toLowerCase());
    if (!hits) continue;
    const key = `${source}\0${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ ref: url, onDisk: [...hits].sort(), source });
  }
  return found.sort((a, b) => a.source.localeCompare(b.source) || a.ref.localeCompare(b.ref));
}

/**
 * The names borgo opens by name, checked the same way and for a worse failure.
 *
 * `Style.scss` compiles on windows and is invisible to linux, where cssSource
 * finds no source at all: the build drops the stylesheet it emitted, exits 0,
 * and the site ships unstyled. This costs a single readdir of the app root and
 * cannot report a name that is not there.
 */
export const CONVENTIONAL_PATHS = ["index.html", "style.scss", "style.css", "pages", "islands", "public"];

export function miscasedConventions(
  root = ".",
  names: readonly string[] = CONVENTIONAL_PATHS,
): Array<{ expected: string; onDisk: string }> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const exact = new Set(entries);
  const folded = new Map<string, string>();
  for (const name of entries) {
    const key = name.toLowerCase();
    if (!folded.has(key)) folded.set(key, name);
  }
  const found: Array<{ expected: string; onDisk: string }> = [];
  for (const name of names) {
    if (exact.has(name)) continue;
    const onDisk = folded.get(name.toLowerCase());
    if (onDisk) found.push({ expected: name, onDisk });
  }
  return found;
}

/**
 * The module specifier with the same disease, and not the loud one it was
 * registered as.
 *
 * `import "./helper"` against a `Helper.ts` on disk resolves on windows and on
 * macos. It was left uncovered on the grounds that linux answers it with a
 * failed build - loud, blocking, ahead of production. Half of that is measured
 * true and half of it is measured false, on a real case-sensitive filesystem:
 *
 *   - a static import, and a dynamic `import()` the bundler walks: the build
 *     fails, `File not found`, exit 1. Loud, and this check only moves it
 *     earlier, onto the machine the author is already watching.
 *   - a dynamic `import()` inside a loader, an action or a prerender export:
 *     the page transpiler eliminates those exports and `trimUnusedImports`
 *     takes the specifier with them, so the bundler never sees it. Measured:
 *     the client build is green, the bundle does not name the module, and the
 *     loader the front server runs from source throws ENOENT per request. The
 *     deploy goes out, the container is healthy, one route answers 500.
 *   - anything a `hydrate = false` page or `_500.tsx` imports: never in the
 *     client bundle either, so the build is green and the server's own import
 *     of the manifest is where it stops.
 *
 * `borgo export` builds on the author's machine and ships the output, so
 * nothing on linux ever resolves those specifiers again - there the defect is
 * invisible because it is inert. The scaffolded Dockerfile is the opposite: it
 * runs `bun run build` on linux and then serves pages from source on linux.
 *
 * Same narrowness as the asset rule above, for the same reason: a specifier
 * that matches nothing at all is left alone - it is a file that is generated
 * later, an extension this does not know, or a genuine mistake that is not a
 * spelling one - and only one that misses on the exact spelling and hits on a
 * folded one is named, which is provably a file that exists under another.
 */
const IMPORT_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".scss"];

// `from "x"` covers import and `export ... from`; the bare form covers a
// side-effect import; then the two call forms. Read off scanCode's output, so
// a specifier in a comment is already blank by the time these run.
const SPEC_PATTERNS = [
  /\bfrom\s*(["'])([^"'\n]+)\1/g,
  /\bimport\s*(["'])([^"'\n]+)\1/g,
  /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
  /\brequire\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
];

/**
 * The relative specifiers a source names, and only those.
 *
 * A bare specifier (`react`, `borgo-framework/router`) goes through node_modules
 * resolution, which is a different mechanism with a different failure, and
 * guessing at it here is how a warning earns the right to be ignored.
 *
 * The match is rejected when the keyword that starts it is itself inside a
 * string or a template literal: generated code - borgo's own manifests are
 * written this way - holds `import ... from "./x"` as text, and that text is
 * not this file's import.
 */
export function scanImportSpecifiers(source: string): string[] {
  const { code, strings } = scanCode(source);
  const found = new Set<string>();
  for (const pattern of SPEC_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const at = match.index;
      if (strings.some(([from, to]) => at >= from && at < to)) continue;
      const spec = match[2];
      if (spec.startsWith("./") || spec.startsWith("../")) found.add(spec);
    }
  }
  return [...found];
}

export type DirEntries = (path: string) => string[];

/**
 * The on-disk spellings of the segment this specifier spells another way, or
 * null for every other answer.
 *
 * Compared segment by segment, never as a filename: a typescript import omits
 * the extension, so `./helper` has to be matched against `helper.ts`,
 * `helper.tsx` and a `helper/` directory alike. An intermediate segment must be
 * a directory that is really there under that exact name; the last one is
 * satisfied by the name itself or by the name plus any extension a bundler
 * would have tried. Anything that resolves exactly returns null, and so does
 * anything that resolves to nothing at all.
 *
 * Every folded hit is returned, sorted. On a case-sensitive checkout the two
 * spellings can sit in the same directory - measured, with `Helper.ts` and
 * `helper.ts` side by side - and naming whichever one readdir happened to
 * return first is a message that changes between machines and hides the other.
 */
export function miscasedImport(
  root: string,
  fromDir: string,
  spec: string,
  dir: DirEntries,
): string[] | null {
  const hits = (names: string[]) => (names.length ? [...names].sort() : null);
  const parts = spec.split(/[?#]/)[0].split("/");
  let at = fromDir;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // above the app root, where this has read nothing and knows nothing
      if (!at) return null;
      at = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "";
      continue;
    }
    const names = dir(at ? join(root, at) : root);
    const folded = part.toLowerCase();
    if (i < parts.length - 1) {
      if (names.includes(part)) {
        at = at ? `${at}/${part}` : part;
        continue;
      }
      return hits(names.filter((name) => name.toLowerCase() === folded));
    }
    if (names.includes(part) || IMPORT_EXT.some((ext) => names.includes(part + ext))) return null;
    return hits(
      names.filter((name) => {
        const lower = name.toLowerCase();
        return lower === folded || IMPORT_EXT.some((ext) => lower === folded + ext);
      }),
    );
  }
  return null;
}

export function miscasedImports(root = "."): CaseMismatch[] {
  const cache = new Map<string, string[]>();
  const dir: DirEntries = (path) => {
    let names = cache.get(path);
    if (!names) {
      try {
        names = readdirSync(path);
      } catch {
        names = [];
      }
      cache.set(path, names);
    }
    return names;
  };
  const found: CaseMismatch[] = [];
  const seen = new Set<string>();
  for (const rel of walkSources(root)) {
    if (!CODE_EXT.has(extname(rel).toLowerCase())) continue;
    const path = join(root, rel);
    try {
      if (statSync(path).size > MAX_SOURCE_BYTES) continue;
      const fromDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      for (const spec of scanImportSpecifiers(readFileSync(path, "utf8"))) {
        const onDisk = miscasedImport(root, fromDir, spec, dir);
        if (!onDisk) continue;
        const key = `${rel}\0${spec}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ ref: spec, onDisk, source: rel });
      }
    } catch {}
  }
  return found.sort((a, b) => a.source.localeCompare(b.source) || a.ref.localeCompare(b.ref));
}

const SHOWN = 10;

/**
 * Printed, never thrown. A build that works today has to go on working today:
 * the check reports a file that exists under another spelling, which is as
 * close to certain as a static reading gets, and it is still only a warning -
 * the one thing it must not be able to do is stop a build over a string.
 *
 * The last line states what was not read, because a check that names no limit
 * teaches whoever read it that there is none.
 */
export function warnAssetCase(root = ".", pub = join(root, "public")): number {
  const mismatches = caseOnlyMismatches(collectAssetRefs(root), publicAssetUrls(pub));
  const conventions = miscasedConventions(root);
  const imports = miscasedImports(root);
  const total = mismatches.length + conventions.length + imports.length;
  if (!total) return 0;
  for (const { expected, onDisk } of conventions) {
    console.warn(
      `  ${c.red(g.err)} borgo opens ${c.bold(expected)} by name and this folder holds ${c.bold(onDisk)} ` +
        `${g.dot} windows and macos resolve it, linux does not`,
    );
  }
  for (const { source, ref, onDisk } of mismatches.slice(0, SHOWN)) {
    console.warn(
      `  ${c.red(g.err)} ${source} references ${c.bold(ref)}, and public/ holds ${c.bold(onDisk.join(", "))} ` +
        `${g.dot} served here, 404 on linux`,
    );
  }
  if (mismatches.length > SHOWN) {
    console.warn(`  ${c.red(g.err)} and ${mismatches.length - SHOWN} more references spelled another way`);
  }
  for (const { source, ref, onDisk } of imports.slice(0, SHOWN)) {
    console.warn(
      `  ${c.red(g.err)} ${source} imports ${c.bold(ref)}, and that folder holds ${c.bold(onDisk.join(", "))} ` +
        `${g.dot} resolved here, not found on linux`,
    );
  }
  if (imports.length > SHOWN) {
    console.warn(`  ${c.red(g.err)} and ${imports.length - SHOWN} more imports spelled another way`);
  }
  console.warn(
    `  ${c.dim(`${g.dot} read: literal absolute paths in html, ts/tsx/js, css/scss and json, and relative import specifiers in ts/tsx/js ${g.dot} not read: a url or a specifier built at runtime, a bare package specifier, @import inside css, or a path that comes from the api`)}`,
  );
  return total;
}

// islands are detected by the <Island marker in the page (or layout) source,
// like hydrate: read statically, without executing the page
const islandRe = /<Island[\s/>]/;

export async function generateManifest(dev = false) {
  if (!existsSync("pages")) {
    throw new Error("no pages/ directory here - run borgo from the app root (the folder holding pages/)");
  }
  // before the first generated file is written, because the first one written
  // is what a later boot mistakes for a finished build
  markBuildStarted();
  const files = [...new Glob("**/*.tsx").scanSync("pages")]
    .map((f) => f.replaceAll("\\", "/"))
    .sort();

  const special = (f: string) => f.split("/").pop()!.startsWith("_");

  const sources = new Map<string, string>();
  for (const f of files) sources.set(f, await Bun.file(`pages/${f}`).text());

  // a full basename, never a suffix: `endsWith` also matched page files, so
  // pages/post_layout.tsx became a phantom layout for a pages/post/ directory
  // that need not exist - emitting an import of "../pages/post/_layout" that
  // resolves nowhere and takes dev, build and export down with it
  const layoutDirs = files
    .filter((f) => f === "_layout.tsx" || f.endsWith("/_layout.tsx"))
    .map((f) => f.slice(0, -"_layout.tsx".length).replace(/\/$/, ""));

  // layout chain for a page, outermost first
  const layoutsFor = (file: string) => {
    const parts = file.split("/").slice(0, -1);
    const chain: string[] = [];
    for (let i = 0; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (layoutDirs.includes(dir)) chain.push(dir);
    }
    return chain;
  };

  // static segments win over dynamic ones
  const pages = files
    .filter((f) => !special(f))
    .map((file) => ({ file, pattern: filePathToPattern(file) }))
    .sort(
      (a, b) =>
        dynamicSegments(a.pattern) - dynamicSegments(b.pattern) ||
        a.pattern.localeCompare(b.pattern),
    );

  warnDeadRoutes(pages);

  const layoutName = (dir: string) => `layout${layoutDirs.indexOf(dir)}`;
  const chainFor = (file: string) => layoutsFor(file).map(layoutName).join(", ");
  const layoutImports = layoutDirs.map(
    (dir) => `import * as ${layoutName(dir)} from "../pages/${dir ? dir + "/" : ""}_layout";`,
  );

  const usesIslands = (file: string) =>
    islandRe.test(sources.get(file) ?? "") ||
    layoutsFor(file).some((dir) =>
      islandRe.test(sources.get(dir ? `${dir}/_layout.tsx` : "_layout.tsx") ?? ""),
    );

  const specialRoute = (file: string, name: string) =>
    files.includes(file)
      ? `export const ${name}: Route | null = { pattern: "*", file: ${JSON.stringify(file)}, module: ${name}Page, layouts: [${chainFor(file)}], islands: ${usesIslands(file)} };`
      : `export const ${name}: Route | null = null;`;

  const manifest = [
    "// generated by borgo - do not edit",
    'import type { Route } from "borgo-framework/router";',
    ...layoutImports,
    ...pages.map((p, i) => `import * as page${i} from "../pages/${p.file.replace(/\.tsx$/, "")}";`),
    ...(files.includes("_404.tsx") ? ['import * as notFoundPage from "../pages/_404";'] : []),
    ...(files.includes("_500.tsx") ? ['import * as serverErrorPage from "../pages/_500";'] : []),
    "",
    "export const routes: Route[] = [",
    ...pages.map(
      (p, i) =>
        `  { pattern: ${JSON.stringify(p.pattern)}, file: ${JSON.stringify(p.file)}, module: page${i}, layouts: [${chainFor(p.file)}], islands: ${usesIslands(p.file)} },`,
    ),
    "];",
    specialRoute("_404.tsx", "notFound"),
    specialRoute("_500.tsx", "serverError"),
    "",
  ].join("\n");
  await writeIfChanged(`${genDir}/routes.gen.tsx`, manifest);

  // client manifest: pages become lazy chunks; hydrate=false pages ship no js at all
  const hydrateOf = new Map<string, string>();
  for (const p of pages) hydrateOf.set(p.file, parseHydrate(sources.get(p.file)!));
  if (files.includes("_404.tsx")) hydrateOf.set("_404.tsx", parseHydrate(sources.get("_404.tsx")!));

  const clientEntry = (pattern: string, file: string) => {
    const importPath = `../pages/${file.replace(/\.tsx$/, "")}`;
    return `{ pattern: ${JSON.stringify(pattern)}, file: ${JSON.stringify(file)}, hydrate: ${hydrateOf.get(file)}, load: () => import(${JSON.stringify(importPath)}), layouts: [${chainFor(file)}] }`;
  };

  const clientPages = pages.filter((p) => hydrateOf.get(p.file) !== "false");
  const clientManifest = [
    "// generated by borgo - do not edit",
    'import type { ClientRoute } from "borgo-framework/runtime";',
    ...layoutImports,
    "",
    "export const routes: ClientRoute[] = [",
    ...clientPages.map((p) => `  ${clientEntry(p.pattern, p.file)},`),
    "];",
    files.includes("_404.tsx") && hydrateOf.get("_404.tsx") !== "false"
      ? `export const notFound: ClientRoute | null = ${clientEntry("*", "_404.tsx")};`
      : "export const notFound: ClientRoute | null = null;",
    "",
  ].join("\n");
  await writeIfChanged(`${genDir}/client-routes.gen.ts`, clientManifest);

  // islands: components in islands/*.tsx, registered eagerly - island code
  // rides with the entry, client="visible" defers the hydration work only
  const islandFiles = existsSync("islands")
    ? [...new Glob("*.tsx").scanSync("islands")].sort()
    : [];
  const islandsManifest = [
    "// generated by borgo - do not edit",
    'import type { ComponentType } from "react";',
    ...islandFiles.map((f, i) => `import island${i} from "../islands/${f.replace(/\.tsx$/, "")}";`),
    "",
    "export const islands: Record<string, ComponentType<any>> = {",
    ...islandFiles.map((f, i) => `  ${JSON.stringify(f.replace(/\.tsx$/, ""))}: island${i},`),
    "};",
    "",
  ].join("\n");
  await writeIfChanged(`${genDir}/islands.gen.ts`, islandsManifest);

  // dev only: the react-refresh runtime must install itself before react
  // loads, so it lives in its own module imported first
  if (dev) {
    const refresh = [
      "// @ts-nocheck",
      "// generated by borgo - do not edit",
      'import RefreshRuntime from "borgo-framework/refresh-runtime";',
      "",
      "RefreshRuntime.injectIntoGlobalHook(window);",
      "globalThis.$RefreshRuntime$ = RefreshRuntime;",
      "globalThis.$RefreshReg$ = () => {};",
      "globalThis.$RefreshSig$ = () => (type) => type;",
      "",
    ].join("\n");
    await writeIfChanged(`${genDir}/refresh.ts`, refresh);
  }

  // react is imported here, from inside the app, and handed to the runtime so
  // the bundle never picks up a second copy through a linked borgo checkout.
  // the registries come from borgo-framework/internal, not the root entry: the
  // root entry is the application-facing api and generated code is not an
  // application. these files are rewritten on every build, so moving the
  // specifier here is the whole migration.
  const entry = [
    "// generated by borgo - do not edit",
    ...(dev ? ['import "./refresh";'] : []),
    'import { createContext, createElement, useContext } from "react";',
    'import { hydrateRoot } from "react-dom/client";',
    'import { registerCsrf, registerIslands } from "borgo-framework/internal";',
    'import { mount } from "borgo-framework/runtime";',
    'import { routes, notFound } from "./client-routes.gen";',
    'import { islands } from "./islands.gen";',
    "",
    "registerIslands(islands, createElement);",
    "registerCsrf({ createElement, createContext, useContext });",
    "mount({ createElement, hydrateRoot, routes, notFound });",
    "",
  ].join("\n");
  await writeIfChanged(`${genDir}/client.tsx`, entry);

  // a second, tiny entry for hydrate=false pages that use islands: it
  // hydrates only the island markers, nothing else
  const islandsEntry = [
    "// generated by borgo - do not edit",
    'import { createContext, createElement, useContext } from "react";',
    'import { hydrateRoot } from "react-dom/client";',
    'import { registerCsrf, registerIslands } from "borgo-framework/internal";',
    'import { mountIslands } from "borgo-framework/runtime";',
    'import { islands } from "./islands.gen";',
    "",
    "registerIslands(islands, createElement);",
    "registerCsrf({ createElement, createContext, useContext });",
    "mountIslands({ createElement, hydrateRoot, islands });",
    "",
  ].join("\n");
  await writeIfChanged(`${genDir}/islands-client.tsx`, islandsEntry);

  return { hasIslands: islandFiles.length > 0 };
}

export type Asset = { path: string; kind: "entry-point" | "chunk" | string; size: number };
export type BuildResult = { assets: Asset[]; chunkMap: Record<string, string>; names: AssetNames };

// the cache key a service worker hangs its precache on, so it must move
// whenever any listed byte does. names alone are not enough: a dev build names
// its entry points client.js and islands-client.js whatever they contain, and
// a change confined to one of them - a layout edit lands in client.js - would
// leave the stamp, and every cache keyed on it, pinned to yesterday's bundle
export async function precacheStamp(dir: string, files: string[]): Promise<string> {
  let payload = "";
  for (const file of files) {
    const path = `${dir}/${file.replace(/^\/assets\//, "")}`;
    const bytes = await Bun.file(path).arrayBuffer();
    payload += `${file}:${Bun.hash(bytes)}|`;
  }
  return String(Bun.hash(payload));
}

// tailwind runs as a postcss plugin, not the cli: @tailwindcss/cli pulls in
// @parcel/watcher, whose postinstall compiles a native watcher from source -
// a `Blocked 1 postinstall` warning on the very first install, for a watcher
// borgo never uses (it does its own watching and asks for one-shot compiles).
// the plugin api has no such dependency, and staying in-process takes a
// rebuild from ~300ms to ~15ms. loaded from the app, not from borgo's own
// tree, so the app's tailwind version is the one that runs.
type Processor = { process: (css: string, opts: { from: string; to: string }) => Promise<{ css: string }> };
let tailwindPostcss: { dev: boolean; processor: Processor } | null = null;

function resolveFromApp(specifier: string): string | null {
  try {
    return Bun.resolveSync(specifier, process.cwd());
  } catch {
    return null;
  }
}

async function compileTailwind(dev: boolean) {
  if (!existsSync("style.css")) {
    throw new Error(
      '--tailwind expects a style.css entry in the app root (start with `@import "tailwindcss";`)',
    );
  }

  const pluginPath = resolveFromApp("@tailwindcss/postcss");
  const postcssPath = resolveFromApp("postcss");
  // apps scaffolded before 0.21 only have the cli: keep compiling those
  // rather than breaking every existing tailwind app on upgrade
  if (!pluginPath || !postcssPath) {
    if (!existsSync("node_modules/@tailwindcss/cli")) {
      throw new Error(
        "--tailwind needs tailwind in the app: bun add -d tailwindcss @tailwindcss/postcss postcss",
      );
    }
    const args = ["x", "@tailwindcss/cli", "-i", "style.css", "-o", `${outDir}/style.css`];
    if (!dev) args.push("--minify");
    // tailwind logs its banner to stderr even on success: only the exit
    // code decides
    const proc = Bun.spawn(["bun", ...args], { stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) throw new Error(`tailwind failed:\n${stderr.trim()}`);
    return;
  }

  // the plugin scans for class candidates from `base`, which defaults to cwd -
  // the app root borgo already runs from. the processor is kept across
  // rebuilds (that is where the speedup lives) but rebuilt if the mode flips,
  // since `optimize` is fixed when the plugin is constructed
  if (tailwindPostcss?.dev !== dev) {
    const plugin = (await import(pluginPath)).default as (opts: { optimize: boolean }) => unknown;
    const postcss = (await import(postcssPath)).default as (plugins: unknown[]) => Processor;
    tailwindPostcss = { dev, processor: postcss([plugin({ optimize: !dev })]) };
  }
  const source = await Bun.file("style.css").text();
  const result = await tailwindPostcss.processor.process(source, {
    from: "style.css",
    to: `${outDir}/style.css`,
  });
  await Bun.write(`${outDir}/style.css`, result.css);
}

// which stylesheet the app root holds. style.scss is the sass pipeline's
// entry, style.css is tailwind's; `null` - and only null - means the emitted
// public/assets/style.css has no source left anywhere and is an orphan.
export function cssSource(dir = "."): "scss" | "css" | null {
  if (existsSync(join(dir, "style.scss"))) return "scss";
  if (existsSync(join(dir, "style.css"))) return "css";
  return null;
}

// which stylesheet is sitting in public/assets right now, under the name the
// last build recorded or the plain one. null means there is none: nothing to
// keep, and nothing a message may claim was kept.
function stylesheetOnDisk(dir = outDir): string | null {
  const emitted = readAssetNames()["style.css"];
  if (emitted && existsSync(`${dir}/${emitted}`)) return emitted;
  return existsSync(`${dir}/style.css`) ? "style.css" : null;
}

/**
 * The previous build's stylesheet, dropped once its source is gone.
 *
 * Only names the build's own record claims. This used to delete
 * `public/assets/style.css` on sight, which is a file this build did not write
 * and cannot restore: public/assets is gitignored by every template, so a
 * stylesheet put there by anything other than borgo - a copy step, an older
 * borgo, a hand-placed file - was removed silently, exit 0, with no line
 * anywhere saying it had happened. The sweep two functions down settled the
 * same question the same way: with no record, the file is not provably borgo's
 * and stays.
 *
 * Returns the names it removed, which the caller prints. A build that deletes
 * something says so.
 */
function dropStylesheet(inventory: string[] | null = readBuildInventory()): string[] {
  const owned = new Set(inventory ?? []);
  // the name the last build emitted it under as well as the plain one: a
  // production build renames the stylesheet after its content, so style.css
  // alone would leave the orphan on disk under the name still being served
  const emitted = readAssetNames()["style.css"];
  const removed: string[] = [];
  for (const name of new Set([...(emitted ? [emitted] : []), "style.css"])) {
    if (!owned.has(name)) continue;
    for (const suffix of ["", ".gz", ".br"]) rmSync(`${outDir}/${name}${suffix}`, { force: true });
    removed.push(name);
  }
  return removed;
}

// whether this build compiled the stylesheet itself. What it did not write, it
// does not get to rename or record as its own output.
export async function compileCss(dev = false): Promise<boolean> {
  if (process.env.BORGO_TAILWIND === "1") {
    await compileTailwind(dev);
    return true;
  }
  if (existsSync("style.scss")) {
    const sass = await import("sass-embedded");
    const css = await sass.compileAsync("style.scss", { style: dev ? "expanded" : "compressed" });
    await Bun.write(`${outDir}/style.css`, css.css);
    return true;
  }
  // a deleted or renamed style.scss - and the scss -> tailwind switch, which
  // leaves BORGO_TAILWIND unset on the build that removed the scss - must take
  // the stylesheet it produced with it
  if (cssSource() === null) {
    for (const name of dropStylesheet()) {
      console.warn(
        `  ${c.terracotta(g.change)} public/assets/${name} dropped ` +
          `${c.dim(`${g.dot} the app has no style.scss or style.css left to compile`)}`,
      );
    }
    return false;
  }
  // tailwind is opt-in by flag, never by detection, so this build cannot
  // compile it - but it must not delete it either, and silence here reads
  // as "the stylesheet is stale" on the next page load
  const kept = stylesheetOnDisk();
  if (!kept) {
    // "left as the last build wrote it" was printed on a clean clone, where
    // there is no last build and public/assets is empty: the build then exited
    // 0 having produced an app with no stylesheet at all, and said so in words
    // that describe a tree that does not exist. Nothing here can be recovered
    // by rebuilding without the flag, so this is where it stops.
    throw new Error(
      "style.css is the app's stylesheet but this command ran without --tailwind, " +
        "and public/assets holds no stylesheet from an earlier build - re-run with --tailwind",
    );
  }
  console.warn(
    `  ${c.terracotta(g.change)} style.css is the app's stylesheet but this command ran without ` +
      `${c.bold("--tailwind")} ${c.dim(`${g.dot} public/assets/${kept} left as the last build wrote it`)}`,
  );
  return false;
}

// the names borgo writes on every build, whatever the app looks like. the
// hashed chunks are NOT guessable and are not guessed: they come from the
// inventory below. client.js and islands-client.js are here for the tree a
// dev build left, and for the upgrade from a borgo whose entries were never
// content-named - a production build now emits neither name.
const FIXED_OUTPUT = ["client.js", "islands-client.js", "precache.json"];

// the urls an app's index.html is written against, and which this build turned
// each of them into. an app author never types a hash: the document keeps
// naming /assets/client.js and the server resolves it at boot.
export const LOGICAL_ASSETS = ["client.js", "islands-client.js", "style.css"] as const;

// what the last build emitted, recorded rather than inferred. the sweep used
// to match a *shape* - `[^/\\]+-[a-z0-9]{8}\.js` - which is also the shape of
// `analytics-9f8e7d6c.js`, so the very file the narrowed sweep was written to
// protect was deleted anyway, while `vendor.js` beside it survived. a name is
// either on the list borgo wrote or it is the app's.
const inventoryPath = `${genDir}/build-output.json`;

export function readBuildInventory(path = inventoryPath): string[] | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { files?: unknown };
    if (!Array.isArray(parsed.files)) return null;
    return parsed.files.every((f) => typeof f === "string") ? (parsed.files as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * The emitted names whose url is a promise about their bytes.
 *
 * The same lesson as the sweep above, arrived at from the other side. Cache
 * policy used to read a *shape* - `-[a-z0-9]{8}\.(js|css)` under `assets/` -
 * and any eight-letter word satisfies it, so `stripe-checkout.js` and
 * `hero-carousel.js` were served `immutable` for a year while
 * `google-analytics.js` escaped only because "analytics" is nine characters.
 * The bundler is the only thing that knows which names it hashed, so it says
 * so here instead of leaving the server to guess.
 *
 * Absent, malformed, or written by a borgo that recorded no hashes: the empty
 * set, which spends a conditional request per asset and pins nothing. Nothing
 * may be pinned on the strength of a file we cannot prove the origin of.
 */
export function readBuildOutputs(path = inventoryPath): BuildOutputs {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { dir?: unknown; hashed?: unknown };
    // the directory travels with the list: without it the server would be back
    // to recognising an output by the shape of its path
    if (typeof parsed.dir !== "string" || !parsed.dir) return NO_BUILD_OUTPUTS;
    const entries = parsed.hashed;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return NO_BUILD_OUTPUTS;
    const sizes = new Map<string, number>();
    for (const [name, size] of Object.entries(entries as Record<string, unknown>)) {
      // keys are filenames inside dir. anything carrying a separator describes
      // some other file, and is dropped rather than reasoned about
      if (!name || name.includes("/") || name.includes("\\")) continue;
      // zero is dropped, not stored. A recorded length of 0 would pin *any*
      // empty file at that name, because every empty file matches it - the
      // length check would carry no information for exactly the case where a
      // truncated or half-written file is what is on disk. The cost is a real
      // output losing its year: a style.scss holding only a comment compiles
      // to 0 bytes and its hashed url revalidates forever, spending a
      // bodyless 304 on nothing rather than being cached.
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) continue;
      sizes.set(name, size);
    }
    return sizes.size ? { dir: parsed.dir, sizes } : NO_BUILD_OUTPUTS;
  } catch {
    return NO_BUILD_OUTPUTS;
  }
}

/**
 * What this build called each of the names a document is written against.
 *
 * Read from the build's own record for the same reason the sizes above are:
 * the emitted name is `client-6j5pq722.js` and no rule over the directory
 * listing can tell that apart from an app's own `client-widget.js`. A name
 * that is absent, or that describes some other directory, falls back to the
 * literal the document already carries - the pre-hash behaviour, which
 * revalidates and works, rather than a guess that might 404.
 */
export function readAssetNames(path = inventoryPath): AssetNames {
  const names: AssetNames = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown };
    const entries = parsed.entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return names;
    for (const logical of LOGICAL_ASSETS) {
      const name = (entries as Record<string, unknown>)[logical];
      if (typeof name !== "string" || !name) continue;
      if (name.includes("/") || name.includes("\\")) continue;
      names[logical] = name;
    }
  } catch {}
  return names;
}

/**
 * The recorded names that are not on disk, which is what `borgo start` asks
 * before serving a tree it did not build.
 *
 * Every name the record hands the document, not just the entry: `.borgo/` from
 * one build beside a `public/assets/` from another - a partial deploy, or a
 * COPY that missed the css - leaves a record naming files that are not there,
 * and the server would boot healthy and serve a dead url until someone
 * rebuilt by hand. A missing entry is a blank page, a missing stylesheet an
 * unstyled one; both are permanent, and rebuilding only costs the build.
 *
 * With no record at all, the plain entry name stands in: an app upgrading from
 * a borgo that hashed nothing still has its build recognised.
 */
export type AssetProblem = { name: string; why: string };

/**
 * Every name the last build recorded, checked as a file rather than as a path.
 *
 * `existsSync` answers a question nobody asked. A directory exists. A file
 * truncated to nothing exists - and an empty entry point is the worst of the
 * three, because the server answers it 204 with a zero-length body, which is a
 * success: no 404, no error page, no line in any log, and a document that never
 * hydrates. Measured on a real tree before this checked lengths.
 *
 * The set is the record's own `files[]`, not the three logical names. The
 * document only ever names the entry and the stylesheet, but the entry imports
 * the chunks beside it, and a chunk that is missing takes hydration down just
 * as completely while `client.js` sits there looking healthy.
 *
 * Zero length condemns a `.js` outright - the bundler does not emit empty
 * javascript. Anything else is condemned for it only when the record vouches
 * for a length it no longer has: a style.scss holding nothing but variables
 * really does compile to zero bytes, and a build must not spend every boot
 * rebuilding a file that is exactly what it was written to be.
 */
export function unusableBuiltAssets(
  names: AssetNames = readAssetNames(),
  inventory: string[] | null = readBuildInventory(),
  outputs: BuildOutputs = readBuildOutputs(),
  dir = outDir,
): AssetProblem[] {
  const wanted = new Set([...Object.values({ "client.js": "client.js", ...names }), ...(inventory ?? [])]);
  const problems: AssetProblem[] = [];
  for (const name of [...wanted].sort()) {
    const recorded = outputs.dir === dir ? outputs.sizes.get(name) : undefined;
    let stat;
    try {
      stat = statSync(`${dir}/${name}`);
    } catch {
      problems.push({ name, why: "is missing" });
      continue;
    }
    if (!stat.isFile()) {
      problems.push({ name, why: "is not a file" });
    } else if (stat.size === 0 && (name.endsWith(".js") || recorded)) {
      problems.push({ name, why: "is empty" });
    } else if (recorded && stat.size !== recorded) {
      problems.push({ name, why: `is ${stat.size} bytes where the build recorded ${recorded}` });
    }
  }
  return problems;
}

// the names alone, for callers that only need to know which files failed
export function missingBuiltAssets(
  names: AssetNames = readAssetNames(),
  inventory: string[] | null = readBuildInventory(),
  outputs: BuildOutputs = readBuildOutputs(),
): string[] {
  return unusableBuiltAssets(names, inventory, outputs).map((p) => p.name);
}

/**
 * Why a production boot has to build, in the operator's words, or nothing.
 *
 * The reasons and the decision come from here together: a boot that announces
 * one cause and rebuilds for another sends whoever reads it to the wrong file.
 */
export function buildReasons(names: AssetNames = readAssetNames()): string[] {
  const why: string[] = [];
  const bad = unusableBuiltAssets(names);
  if (bad.length) {
    // a partial deploy can leave every name broken at once, and a boot line
    // naming seventeen files is a boot line nobody reads
    const shown = bad.slice(0, 3).map((p) => `${p.name} ${p.why}`);
    if (bad.length > shown.length) shown.push(`and ${bad.length - shown.length} more`);
    why.push(`in public/assets, ${shown.join(", ")}`);
  }
  if (!existsSync(`${genDir}/routes.gen.tsx`)) why.push("there is no route manifest here");
  if (buildLeftUnfinished()) why.push("the last build here did not finish");
  return why;
}

// what `borgo start` asks before serving a tree it did not build. Doubt
// resolves toward rebuilding: the cost is one build, and the alternative is a
// document naming files that are not there, permanently and with no error.
export const needsBuild = (dev: boolean, names: AssetNames = readAssetNames()): boolean =>
  dev || buildReasons(names).length > 0;

/**
 * Which emitted file each logical name became, read off the emitted names.
 *
 * The bundler reports artifacts, not which entrypoint produced them, so the
 * two entries are recognised by the only thing that is borgo's own: the stem
 * it asked bun to name them after.
 */
export function entryOutputNames(files: readonly string[]): AssetNames {
  const names: AssetNames = {};
  for (const file of files) {
    const match = file.match(/^(islands-client|client)(?:-[^.]+)?\.js$/);
    if (match) names[`${match[1]}.js`] = file;
  }
  return names;
}

// 64-bit wyhash, base36, last eight characters - the same shape bun gives a
// chunk, so a stylesheet's url reads like everything else in the directory
const contentHash = (bytes: ArrayBuffer): string =>
  Bun.hash(bytes).toString(36).padStart(8, "0").slice(-8);

/**
 * The stylesheet's emitted name: content-hashed in production, plain in dev.
 *
 * The stylesheet is not a bundler artifact, so nothing else names it by
 * content - and the entry bundle's year would be a poor trade if the
 * stylesheet beside it still spent a round trip per navigation.
 *
 * A build that compiled no css at all (a tailwind app built without
 * `--tailwind`) keeps the name the last one emitted, which is the file still
 * sitting in the output directory. Renaming rather than copying: two files
 * with the same bytes under different names is the state where the sweep
 * deletes the one the document is using.
 *
 * `wrote` is whether this build compiled that plain style.css. A build that did
 * not must not rename it: the file would be one nobody produced, moved to a
 * name nobody asked for, and recorded as this build's own output - which is the
 * next build's licence to delete it.
 */
export async function emittedStylesheet(
  dev: boolean,
  previous: string | undefined,
  dir = outDir,
  wrote = true,
): Promise<string | null> {
  const plain = `${dir}/style.css`;
  if (wrote && existsSync(plain)) {
    if (dev) return "style.css";
    const name = `style-${contentHash(await Bun.file(plain).arrayBuffer())}.css`;
    if (name !== "style.css") renameSync(plain, `${dir}/${name}`);
    return name;
  }
  return previous && existsSync(`${dir}/${previous}`) ? previous : null;
}

/**
 * The byte length of each name, measured off the disk the build just wrote.
 *
 * Measured rather than taken from `BuildArtifact.size`, because
 * renameUnsafeChunks rewrites the import strings inside a chunk after the
 * bundler reported it - so the artifact's size is the size of a file that no
 * longer exists. A name that cannot be stat'd is simply left out and is
 * therefore never pinned.
 */
export function recordedOutputSizes(dir: string, names: readonly string[]): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const name of names) {
    try {
      // an empty output is not vouched for: see readBuildOutputs
      const { size } = statSync(`${dir}/${name}`);
      if (size > 0) sizes[name] = size;
    } catch {}
  }
  return sizes;
}

export async function writeBuildInventory(
  files: string[],
  vouched: { dir: string; sizes: Record<string, number> } | null = null,
  path = inventoryPath,
  entries: AssetNames = {},
) {
  const hashed: Record<string, number> = {};
  for (const name of Object.keys(vouched?.sizes ?? {}).sort()) hashed[name] = vouched!.sizes[name];
  const body = { files: [...new Set(files)].sort(), dir: vouched?.dir ?? "", hashed, entries };
  await Bun.write(path, JSON.stringify(body) + "\n");
}

/**
 * Whether the bundler put this artifact's own content hash into its name.
 *
 * Not "does the name look hashed". `Bun.build` reports a content hash for
 * every artifact, and a dev build names its entry points `[name].[ext]` - so
 * `client.js` carries a hash that is nowhere in its filename and is
 * emphatically not cacheable forever. The name is a promise only when it
 * actually contains the hash of the bytes behind it, which is a thing a word
 * cannot accidentally be.
 */
export const nameCarriesHash = (file: string, hash: string | null): boolean =>
  hash !== null && hash !== "" && basename(file).includes(hash);

/**
 * Which of a bundle's outputs may be cached forever, by name.
 *
 * `renamedTo` maps an artifact's path to where it actually landed:
 * renameUnsafeChunks moves the files bun could not name, and the name that
 * ends up in a url is the one a cache will ask about. The hash survives that
 * rename, so a renamed chunk stays cacheable.
 */
export const hashedOutputNames = (
  outputs: readonly { path: string; hash: string | null }[],
  renamedTo: (path: string) => string = (p) => p,
): string[] =>
  outputs
    .map((o) => ({ file: basename(renamedTo(o.path).replaceAll("\\", "/")), hash: o.hash }))
    .filter((o) => nameCarriesHash(o.file, o.hash))
    .map((o) => o.file);

/**
 * Whether the sweep may delete `file`.
 *
 * `owned` is what a build wrote and is free to remove; `keep` is what the
 * build now running has just written and must not remove. Precompressed
 * siblings are always the build's own and always stale by the time it runs
 * again - dev writes none, and a production rebuild only rewrites a `.gz` that
 * came out smaller than the source - so they go with either.
 */
export function isSweepable(file: string, owned: Set<string>, keep: Set<string> = new Set()): boolean {
  const sibling = file.match(/^(.*)\.(gz|br)$/);
  if (sibling) {
    const base = sibling[1];
    return base === "style.css" || owned.has(base) || keep.has(base);
  }
  return owned.has(file) && !keep.has(file);
}

// hashed chunk names change between builds, so the stale ones and their
// precompressed siblings go once the new build has written. Only the build's
// own output: this directory is also where an app drops an analytics snippet
// or a vendored widget, and those used to be deleted here with no warning.
//
// no inventory (an app upgrading from a borgo that never wrote one) means the
// hashed chunks of that last build cannot be identified, so they are left
// alone: a stale chunk nobody imports is dead weight, a deleted app file is
// not recoverable. The build now finishing records its own, and the sweep
// after it is exact.
export function sweepBuildOutput(
  dir: string,
  inventory: string[] | null = readBuildInventory(),
  keep: Iterable<string> = [],
): string[] {
  if (!existsSync(dir)) return [];
  const owned = new Set([...FIXED_OUTPUT, ...(inventory ?? [])]);
  const kept = new Set(keep);
  const removed: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!isSweepable(file, owned, kept)) continue;
    rmSync(`${dir}/${file}`, { force: true });
    removed.push(file);
  }
  return removed;
}

// bun leaves the "[name]" token literal for a chunk it cannot name, which
// puts brackets in a url path: legal, but s3, some cdns and some proxies
// mangle them, and a chunk that 404s takes hydration down with it. rename
// those files and rewrite the imports that point at them.
export async function renameUnsafeChunks(paths: string[]): Promise<Map<string, string>> {
  const renamed = new Map<string, string>();
  for (const path of paths) {
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const dir = path.slice(0, slash + 1);
    const file = path.slice(slash + 1);
    if (!/[[\]]/.test(file)) continue;
    const safe = file.replace(/\[name\]/g, "chunk").replace(/[[\]]/g, "");
    renameSync(path, dir + safe);
    renamed.set(path, dir + safe);
  }
  if (!renamed.size) return renamed;

  // the old name is a literal string inside whatever imported it
  const swaps = [...renamed].map(([from, to]) => [basename(from), basename(to)] as const);
  for (const path of paths) {
    const current = renamed.get(path) ?? path;
    if (!current.endsWith(".js")) continue;
    const before = readFileSync(current, "utf8");
    let after = before;
    for (const [from, to] of swaps) after = after.replaceAll(from, to);
    if (after !== before) writeFileSync(current, after);
  }
  return renamed;
}

// what the bundler substitutes into the client bundle. BORGO_STATIC is how the
// runtime learns it is being built for `borgo export`: a static host has no
// ?__borgo=props endpoint, it answers the document for that url with a 200 the
// runtime cannot parse, so the props path has to be compiled out rather than
// tried and caught.
export function buildDefine(dev: boolean, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
    "process.env.BORGO_STATIC": JSON.stringify(env.BORGO_STATIC === "1" ? "1" : "0"),
  };
}

// one bundler log line, framed like the rest of the cli. bun reports the file
// and the position separately (and sometimes not at all), which is why the
// location is assembled rather than printed from the message.
export function formatBuildLog(log: unknown): string {
  const message = log instanceof Error ? log.message : String(log);
  const position = (log as { position?: { file?: string; line?: number; column?: number } }).position;
  const file = position?.file?.replaceAll("\\", "/");
  if (!file) return message;
  const at = position?.line ? `:${position.line}${position.column ? `:${position.column}` : ""}` : "";
  return `${file}${at} ${g.dot} ${message}`;
}

/**
 * A bundle that did not build.
 *
 * `Bun.build` reports failure two ways and borgo used to notice neither: with
 * `throw: true` (the default) an AggregateError escapes as a raw trace with no
 * borgo framing, and with the result checked by hand `result.success` was
 * simply never read - so a failed build fell through to writing
 * `.borgo/build-mode = production` over the tree it had just emptied.
 */
export class BundleFailed extends Error {
  readonly details: string[];
  constructor(logs: readonly unknown[]) {
    const details = logs.map(formatBuildLog);
    super(`the client bundle failed to build${details.length ? `:\n${details.join("\n")}` : ""}`);
    this.name = "BundleFailed";
    this.details = details;
  }
}

// whether the operator asked for the stack. `--debug` is read off the whole
// argv by cli.ts, like --tailwind; the variable is for everything that reaches
// a build without a command line (the dev server's own rebuilds, a test).
export const debugEnabled = (
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean => argv.includes("--debug") || env.BORGO_DEBUG === "1";

// the chain of `cause`s an error carries, which is where the real reason lives
// once anything has wrapped it
function causeChain(error: unknown): string[] {
  const chain: string[] = [];
  let current: unknown = (error as { cause?: unknown })?.cause;
  while (current && chain.length < 4) {
    chain.push(current instanceof Error ? current.message : String(current));
    current = (current as { cause?: unknown })?.cause;
  }
  return chain;
}

/**
 * Any failure a build can end in, printed as a borgo failure.
 *
 * `BundleFailed` had a handler and nothing else did, so every other way a build
 * dies - a sass parse error, an EACCES on public/assets, a tailwind plugin
 * throwing, an ENOSPC - escaped as a raw v8 trace with borgo's own source
 * comments quoted inside it. The trace is the one thing there that names no
 * file of the operator's, and it hides the one line that does.
 *
 * The stack is not lost, only moved behind `--debug`: the operator who needs it
 * is the one who already read the message and wants more.
 */
export function reportBuildFailure(error: unknown, debug = debugEnabled()): void {
  if (error instanceof BundleFailed) {
    console.error(`\n  ${c.red(g.err)} the client bundle failed to build`);
    for (const detail of error.details) console.error(`    ${detail}`);
    console.error(`  ${c.dim(`${g.dot} public/assets still holds the last build that worked`)}\n`);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n  ${c.red(g.err)} ${message}`);
  for (const cause of causeChain(error)) console.error(`    ${c.dim(`caused by ${g.dot}`)} ${cause}`);
  // an fs error names the path it failed on and nothing else does
  const path = (error as { path?: unknown }).path;
  if (typeof path === "string") console.error(`    ${c.dim(`at ${g.dot}`)} ${path.replaceAll("\\", "/")}`);
  const stack = error instanceof Error ? error.stack : null;
  if (debug && stack) console.error(`\n${stack}`);
  else if (stack) console.error(`  ${c.dim(`${g.dot} run it again with --debug for the stack`)}`);
  console.error("");
}

export async function buildAssets(dev = false): Promise<BuildResult> {
  if (dev) void loadBabelRefresh();
  const { hasIslands } = await generateManifest(dev);
  const lastNames = readAssetNames();
  const wroteCss = await compileCss(dev);
  const stylesheet = await emittedStylesheet(dev, lastNames["style.css"], outDir, wroteCss);

  // read before the bundle runs, swept after it succeeds: the sweep used to go
  // first, so one parse error left public/assets holding nothing but style.css
  // - client.js, every chunk, precache.json and all their precompressed
  // siblings gone - and the last good build with them
  const previous = readBuildInventory();

  const define = buildDefine(dev);
  const result = await Bun.build({
    entrypoints: [
      `${genDir}/client.tsx`,
      ...(hasIslands ? [`${genDir}/islands-client.tsx`] : []),
    ],
    outdir: outDir,
    splitting: true,
    minify: !dev,
    // dev keeps the entry name fixed: the shell is resolved once when the dev
    // server boots, and a rebuild that moved the name would leave every open
    // document asking for a bundle that is gone
    naming: { entry: dev ? "[name].[ext]" : "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]" },
    define,
    plugins: [appTranspile(define, dev)],
    // borgo frames the failure itself: bun's own throw is an AggregateError
    // whose message is a bare trace, printed where every other borgo failure
    // has a mark, a file and a line
    throw: false,
  });
  if (!result.success) throw new BundleFailed(result.logs);
  const renamed = await renameUnsafeChunks(result.outputs.map((o) => o.path));
  const outPath = (p: string) => renamed.get(p) ?? p;
  const assets = result.outputs.map((o) => ({ path: outPath(o.path), kind: o.kind, size: o.size }));

  // now that the new output is on disk, the previous build's is stale: sweep
  // by inventory, never by shape, and never a name this build just wrote
  const named = (p: string) => p.replaceAll("\\", "/").split("/").pop()!;
  const emitted = assets.map((a) => named(a.path));
  // the stylesheet comes from compileCss, not from the bundler, so it is named
  // here and swept, recorded and vouched for alongside the bundler's own
  const written = stylesheet ? [...emitted, stylesheet] : emitted;
  // recorded here because this is the only place that knows what the bundler
  // hashed; every consumer downstream reads the list instead of guessing
  const hashed = hashedOutputNames(result.outputs, outPath);
  if (stylesheet && stylesheet !== "style.css") hashed.push(stylesheet);
  // which name each url in the app's index.html became. Both directions cost:
  // a document naming what the build no longer emits is a blank page, and a
  // name that does not move when the bytes do hands a year of cache to stale
  // ones.
  //
  // entry-point artifacts only: splitting also emits a shared chunk named
  // client-<hash>.js, and a document sent to that one hydrates nothing
  const names = entryOutputNames(
    assets.filter((a) => a.kind === "entry-point").map((a) => named(a.path)),
  );
  if (stylesheet) names["style.css"] = stylesheet;
  sweepBuildOutput(outDir, previous, written);

  // prod only: the hashed asset list a service worker can precache; the
  // stamp changes whenever any listed content does
  if (!dev) {
    const files = result.outputs
      .filter((o) => o.path.endsWith(".js"))
      .map((o) => "/assets/" + outPath(o.path).replaceAll("\\", "/").split("/").pop());
    // the emitted name, not style.css: cache.addAll rejects as a whole on one
    // missing url, and an install that never completes is a worker that can
    // never replace the one already holding the previous deploy
    if (stylesheet) files.push(`/assets/${stylesheet}`);
    files.sort();
    const stamp = await precacheStamp(outDir, files);
    await Bun.write(`${outDir}/precache.json`, JSON.stringify({ stamp, assets: files }));
    // the stamp goes into the worker's own body too: a byte-identical sw.js is
    // a worker the browser never reinstalls, so install (which fills the cache)
    // and activate (which prunes the old ones) would never run again after the
    // first deploy, and every later deploy's assets would be shadowed by the
    // first one's for as long as the site data lives
    stampWorkerFile(stamp);
  }

  // prod only: emit .gz/.br siblings once here instead of compressing on
  // every request; dev skips the cost and serves identity
  if (!dev) await precompressAssets(outDir);

  // After precompression, because a sibling's length does not exist until it
  // has been written and the server verifies whichever representation it is
  // about to send - the .br and .gz go out under the same url and are pinned
  // by the same directive, so they have to be vouched for the same way. Names
  // that were not written (dev, or a file compression did not shrink) are not
  // stat'able and are simply left out, which makes them unpinnable.
  //
  // A failure between the sweep above and this write leaves the previous
  // build's inventory in place: it names files that are gone, which pins
  // nothing and sweeps nothing that still exists, and the next successful
  // build replaces it. The directory travels with the sizes so the server
  // matches the whole path, never a folder that happens to be spelled "assets".
  const vouchable = hashed.flatMap((name) => [name, `${name}.gz`, `${name}.br`]);
  await writeBuildInventory(
    written,
    { dir: outDir, sizes: recordedOutputSizes(outDir, vouchable) },
    inventoryPath,
    names,
  );
  await Bun.write(buildModePath, buildModeFor(dev));
  // every byte this build promises is on disk: the tree is a finished build
  // again, and the next boot has nothing to inherit from this one
  clearBuildMark();

  // after the build has committed, and inside a catch it can never escape: a
  // reading of the source tree must not be able to fail a build that produced
  // its output. dev runs it too - that is the machine the spelling looks right
  // on, and the only one the author is watching
  try {
    warnAssetCase();
  } catch {}

  // dev: page chunks carry an injected marker, so the fast-refresh channel
  // can tell the browser which chunk file belongs to which page
  const chunkMap: Record<string, string> = {};
  if (dev) {
    for (const output of result.outputs) {
      // the file may have been renamed out from under this path above
      const path = outPath(output.path);
      if (!path.endsWith(".js")) continue;
      const text = await Bun.file(path).text();
      for (const m of text.matchAll(/borgo-page:([^"\\]+)/g)) {
        chunkMap[m[1]] = "/assets/" + path.replaceAll("\\", "/").split("/").pop();
      }
    }
  }
  return { assets, chunkMap, names };
}

// full react-refresh instrumentation: the babel plugin emits $RefreshReg$
// registrations and $RefreshSig$ hook signatures, so a body edit keeps state
// and a hook edit remounts just that component, like next. runs on the bun
// transpiler's output (plain js), dev builds only.
let babelRefresh: {
  transformSync: typeof import("@babel/core").transformSync;
  plugin: unknown;
} | null = null;

async function loadBabelRefresh() {
  if (babelRefresh) return babelRefresh;
  const babel = await import("@babel/core");
  const mod = (await import("react-refresh/babel")) as { default?: unknown };
  babelRefresh = { transformSync: babel.transformSync, plugin: mod.default ?? mod };
  return babelRefresh;
}

export function refreshWrap(js: string, moduleId: string) {
  const id = JSON.stringify(moduleId);
  return (
    `var $borgoPrevReg = globalThis.$RefreshReg$, $borgoPrevSig = globalThis.$RefreshSig$;\n` +
    `globalThis.$RefreshReg$ = (type, name) => globalThis.$RefreshRuntime$ && globalThis.$RefreshRuntime$.register(type, ${id} + "#" + name);\n` +
    `globalThis.$RefreshSig$ = () => globalThis.$RefreshRuntime$ ? globalThis.$RefreshRuntime$.createSignatureFunctionForTransform() : (type) => type;\n` +
    js +
    `\nglobalThis.$RefreshReg$ = $borgoPrevReg; globalThis.$RefreshSig$ = $borgoPrevSig;\n`
  );
}

export async function refreshTransform(js: string, moduleId: string): Promise<string> {
  const { transformSync, plugin } = await loadBabelRefresh();
  const out = transformSync(js, {
    configFile: false,
    babelrc: false,
    compact: false,
    plugins: [[plugin, { skipEnvCheck: true }]],
  });
  const code = out?.code;
  if (!code || !/\$Refresh(Reg|Sig)\$/.test(code)) return js;
  return refreshWrap(code, moduleId);
}

// pages are rewritten for the client build with their loader and action
// eliminated, so server-only code and its imports never reach the browser.
// in dev every app module additionally gets react-refresh registration, and
// page modules a marker identifying their output chunk.
function appTranspile(define: Record<string, string>, dev: boolean): import("bun").BunPlugin {
  const cwd = process.cwd() + sep;
  const pagesDir = join(process.cwd(), "pages") + sep;
  const pageTranspiler = new Bun.Transpiler({
    loader: "tsx",
    exports: { eliminate: ["loader", "action", "prerender", "prerenderPaths"] },
    trimUnusedImports: true,
    treeShaking: true,
    autoImportJSX: true,
    define,
  });
  const plainTranspiler = new Bun.Transpiler({ loader: "tsx", autoImportJSX: true, define });
  const tsTranspiler = new Bun.Transpiler({ loader: "ts", define });
  return {
    name: "borgo-app-transpile",
    setup(build) {
      // .ts modules matter in dev too: custom hooks must carry signatures, or
      // react-refresh force-remounts every component that uses them
      build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
        if (!args.path.startsWith(cwd) || args.path.includes("node_modules")) return undefined;
        const rel = args.path.slice(cwd.length).replaceAll("\\", "/");
        if (rel.startsWith(".borgo/")) return undefined;
        const isPage = args.path.startsWith(pagesDir);
        if (!isPage && !dev) return undefined;
        const source = await Bun.file(args.path).text();
        const transpiler = isPage ? pageTranspiler : rel.endsWith(".tsx") ? plainTranspiler : tsTranspiler;
        let js = transpiler.transformSync(source);
        if (dev) {
          js = await refreshTransform(js, rel);
          if (isPage) js += `\nglobalThis[${JSON.stringify("borgo-page:" + rel.slice("pages/".length))}] = 1;\n`;
        }
        return { contents: js, loader: "js" };
      });
    },
  };
}
