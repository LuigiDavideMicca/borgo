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

// which build last wrote public/assets: an export build has the props endpoint
// compiled out, so served by `borgo start` every navigation is a full reload
export type BuildMode = "dev" | "production" | "export";

export function buildModeFor(dev: boolean, env: NodeJS.ProcessEnv = process.env): BuildMode {
  if (dev) return "dev";
  return env.BORGO_STATIC === "1" ? "export" : "production";
}

// `recorded`: a stamp is on disk but says nothing borgo writes (empty, truncated, `DEV`)
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

// only a stamp that says "production" is served; doubt rebuilds. An unreadable
// stamp is what a half-copied `.borgo` looks like, and the price is one build
export function rebuildBeforeServing(read: BuildModeRead = readBuildMode()): string | null {
  if (read.mode === "production") return null;
  if (read.mode === "dev") return "public/assets holds a dev build";
  if (read.mode === "export") return "public/assets holds a static export build";
  return read.recorded
    ? `${buildModePath} does not say which build public/assets holds`
    : "nothing here records which build public/assets holds";
}

const incompletePath = `${genDir}/build-incomplete`;

export function markBuildStarted(path = incompletePath) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${new Date().toISOString()}\n`);
}

export function clearBuildMark(path = incompletePath) {
  rmSync(path, { force: true });
}

// generateManifest writes routes.gen.tsx before anything can fail, so without
// this mark a failed build erases the evidence it was needed and the next boot
// serves the previous public/assets without a word
export function buildLeftUnfinished(path = incompletePath): boolean {
  return existsSync(path);
}

const dynamicSegments = (pattern: string) =>
  pattern.split("/").filter((s) => s.startsWith(":")).length;

// paths the front server answers before the route table is consulted
const RESERVED_PREFIXES: Array<[string, string]> = [
  ["/api/", "proxied to the go api"],
  ["/__borgo/", "borgo's own dev and push endpoints"],
];
const RESERVED_PATHS: Array<[string, string]> = [
  ["/ws", "the websocket endpoint"],
  ["/healthz", "the health probe"],
];
// the same function the server's switches use, not the variable name: /metrics
// is only claimed with BORGO_METRICS=1
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

// printed wherever a route table is about to be believed: `borgo start` on a
// pre-built tree never reaches generateManifest
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

// the hydrate export is read without executing the page, so comments, string
// literals and regex literals (quotes that are not quotes) must be told apart
type Scan = { code: string; strings: Array<[number, number]> };

// a `/` starts a regex after an operator, an opener, a statement end or these keywords
const REGEX_BEFORE = /(?:^|[^\p{L}\p{N}_$])(return|typeof|instanceof|in|of|case|do|else|yield|await|void|delete|new|throw)$/u;

function regexCanStart(tail: string): boolean {
  if (!tail) return true;
  if ("(,=:[!&|?{};+-*%~^<>".includes(tail[tail.length - 1])) return true;
  return REGEX_BEFORE.test(tail);
}

export function scanCode(source: string): Scan {
  // split(""), not [...source]: code units, the indices indexOf and lastIndex speak
  const chars = source.split("");
  const strings: Array<[number, number]> = [];
  // blanked, not removed: offsets and line anchors must keep their meaning
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < chars.length; k++) if (chars[k] !== "\n") chars[k] = " ";
  };
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
        // an unterminated ' or " is an apostrophe in jsx text (<p>don't</p>):
        // run to the next quote, it would swallow a real export
        if (source[i] === "\n" && ch !== "`") break;
        i++;
      }
      if (!closed && ch !== "`") {
        i = start + 1;
        push(ch);
        continue;
      }
      // nothing inside a ${...} can be a top-level export: the whole literal is one span
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

// anchored to the start of a line: an `export` is a top-level statement
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

// `/logo.png` for `public/Logo.png` is served on windows and macos and 404 on
// linux. Reported only when the exact spelling misses and a folded one hits:
// a reference matching nothing is a route, an api path or a runtime name
export type CaseMismatch = { ref: string; onDisk: string[]; source: string };

// the lookbehind refuses `https://cdn/x/Logo.png` and `./logo.png`
const ASSET_REF = /(?<![\p{L}\p{N}.:/_-])\/[\p{L}\p{N}._~%@+-]+(?:\/[\p{L}\p{N}._~%@+-]+)*\.[\p{L}\p{N}]{1,8}/gu;

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const TEXT_EXT = new Set([".html", ".css", ".scss", ".json", ".webmanifest"]);
// at any depth: a linked workspace puts a node_modules under a package
const SKIP_DIRS = new Set(["node_modules", "dist"]);
// the bundler's own output cannot diverge from itself
const SKIP_PATHS = new Set(["public/assets"]);
const MAX_SOURCE_BYTES = 512 * 1024;

// in code only string literals count: a path in a comment or a regex is not a reference
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

// `Style.scss` compiles on windows; on linux cssSource finds no source, the
// build drops the stylesheet, exits 0 and the site ships unstyled
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

// a miscased import is NOT always a loud linux build failure (measured): an
// `import()` inside a loader/action/prerender is stripped with the export by
// `trimUnusedImports`, the build is green, and the loader run from source
// throws ENOENT per request; a `hydrate = false` page or `_500.tsx` is never
// bundled either. Same narrowness as the asset rule: only exact-miss, folded-hit
const IMPORT_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".scss"];

// `from` covers import and `export ... from`; bare `import` the side-effect form
const SPEC_PATTERNS = [
  /\bfrom\s*(["'])([^"'\n]+)\1/g,
  /\bimport\s*(["'])([^"'\n]+)\1/g,
  /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
  /\brequire\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
];

// relative specifiers only: bare ones resolve through node_modules, a
// different mechanism. A keyword inside a string is generated code's text
// (borgo's own manifests), not this file's import
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

// segment by segment: `./helper` must match `helper.ts`, `helper.tsx` and a
// `helper/` directory alike. Every folded hit, sorted: `Helper.ts` and
// `helper.ts` can sit side by side on a case-sensitive checkout
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
      // above the app root: nothing read, nothing known
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

// Bun.build does not know `new URL("./x.png", import.meta.url)` in any
// configuration - measured on bun 1.3.14 in six: the string survives untouched,
// the file is neither emitted nor copied, so it is a 404 under /assets/ after a
// green build, and under ssr a file:// path. Do not read the sources for this:
// colors.ts uses the pattern correctly on the server. Only what survived into
// public/assets is checked, against what public/ holds, so `../logo.svg` is
// silent. Pages never bundled (`hydrate = false`, `_500.tsx`) are invisible
// here; `redactLocalPaths` in server.ts closes that half at render time
export type UnservedRef = { spec: string; url: string; from: string };

// minifier-tolerant, anchored on `import.meta.url`, which nothing can rename
const RUNTIME_URL_REF =
  /new\s+URL\s*\(\s*(["'])(\.{1,2}\/[^"'\n]*)\1\s*,\s*import\s*\.\s*meta\s*\.\s*url\s*\)/g;

export function runtimeUrlRefs(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(RUNTIME_URL_REF)) found.push(match[2]);
  return found;
}

// `import.meta.dir + "/x.png"`: ssr renders the native on-disk path, the
// browser renders "undefined/x.png". Only when concatenated: `typeof
// import.meta.dir` is a bun-or-browser discriminator that works
const META_PATH_CONCAT =
  /(?:\+\s*import\s*\.\s*meta\s*\.\s*(?:dir|path)\b|import\s*\.\s*meta\s*\.\s*(?:dir|path)\s*\+)/g;

export function metaPathConcats(source: string): number {
  let n = 0;
  for (const _ of source.matchAll(META_PATH_CONCAT)) n++;
  return n;
}

// `import.meta.url` in a chunk is that chunk's url, so relative specifiers resolve against this
const ASSET_BASE = "/assets/";

export function unservedRuntimeUrls(
  bundles: Iterable<{ name: string; source: string }>,
  served: Iterable<string>,
  base = ASSET_BASE,
): UnservedRef[] {
  const urls = new Set(served);
  const found: UnservedRef[] = [];
  const seen = new Set<string>();
  for (const { name, source } of bundles) {
    for (const spec of runtimeUrlRefs(source)) {
      let url: string;
      try {
        // the host is arbitrary: only the path is compared
        url = new URL(spec, `http://borgo${base}${name}`).pathname;
      } catch {
        continue;
      }
      if (urls.has(url)) continue;
      const key = `${name}\0${spec}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ spec, url, from: name });
    }
  }
  return found.sort((a, b) => a.from.localeCompare(b.from) || a.spec.localeCompare(b.spec));
}

// from disk, not the build result: one shape after a build and on a tree that already holds one
export function bundleSources(dir = outDir): Array<{ name: string; source: string }> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const bundles: Array<{ name: string; source: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    try {
      bundles.push({ name: entry.name, source: readFileSync(join(dir, entry.name), "utf8") });
    } catch {}
  }
  return bundles.sort((a, b) => a.name.localeCompare(b.name));
}

// `kind: "asset"` is exact: the stylesheet is compiled outside the bundler, so
// an asset output exists only because a source imported a file
export function bundledAssetNames(
  outputs: Iterable<{ kind: string; path: string }>,
): string[] {
  const names: string[] = [];
  for (const { kind, path } of outputs) {
    if (kind !== "asset") continue;
    const name = path.replaceAll("\\", "/").split("/").pop()!;
    if (name.endsWith(".map")) continue;
    names.push(name);
  }
  return names.sort();
}

// fatal, not a warning, because none of the three forms works anywhere: an
// emitted `./x-<hash>.png` resolves against the document, not /assets/ (404
// from every route, measured), emitted css is linked by nothing, and the ssr
// pass writes the machine's absolute path into every served document
export type ChannelFault =
  | { kind: "emitted"; name: string }
  | { kind: "url"; from: string; spec: string; url: string }
  | { kind: "dir"; from: string };

export function assetChannelFaults(
  bundles: Iterable<{ name: string; source: string }>,
  served: Iterable<string>,
  emitted: readonly string[] = [],
): ChannelFault[] {
  const faults: ChannelFault[] = [];
  for (const name of emitted) faults.push({ kind: "emitted", name });
  for (const ref of unservedRuntimeUrls(bundles, served)) {
    faults.push({ kind: "url", from: ref.from, spec: ref.spec, url: ref.url });
  }
  for (const { name, source } of bundles) {
    if (metaPathConcats(source)) faults.push({ kind: "dir", from: name });
  }
  return faults;
}

// one wording for the refusal and for the report on a tree already built
export function channelLines(faults: readonly ChannelFault[]): string[] {
  return faults.map((fault) => {
    if (fault.kind === "emitted") {
      return (
        `an import made the bundler write ${c.bold(`public/assets/${fault.name}`)}, which no document points at ` +
        `${g.dot} the url in the bundle resolves against the page, not /assets/: put the file in public/ and name it absolutely`
      );
    }
    if (fault.kind === "dir") {
      return (
        `assets/${fault.from} builds a url out of ${c.bold("import.meta.dir")}, which the browser has not got ` +
        `${g.dot} it is "undefined/..." there and the path on disk in the server-rendered html: put the file in public/ and name it absolutely`
      );
    }
    return (
      `assets/${fault.from} asks the browser for ${c.bold(fault.url)}, and public/ holds no such file ` +
      `${g.dot} new URL(${fault.spec}, import.meta.url) emits nothing: 404 everywhere, and ssr renders the path on disk`
    );
  });
}

// thrown before clearBuildMark(): the tree keeps its mark, so the next `borgo
// start` rebuilds and refuses again instead of serving the leak
export class AssetChannelRefused extends Error {
  readonly lines: string[];
  constructor(faults: readonly ChannelFault[]) {
    super(
      `${faults.length} reference${faults.length === 1 ? "" : "s"} to a file beside its own source - ` +
        "borgo serves public/, and this build would have shipped a url nobody answers " +
        "and the path of this machine inside the rendered html",
    );
    this.name = "AssetChannelRefused";
    this.lines = channelLines(faults);
  }
}

const SHOWN = 10;

// printed, never thrown: these findings work on the author's machine, unlike
// the channel faults. The last line states what was not read
export function warnAssetCase(root = ".", pub = join(root, "public")): number {
  const served = publicAssetUrls(pub);
  const mismatches = caseOnlyMismatches(collectAssetRefs(root), served);
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
    `  ${c.dim(`${g.dot} read: literal absolute paths in html, ts/tsx/js, css/scss and json, and relative import specifiers in ts/tsx/js ${g.dot} not read: a relative url inside a string (<img src="./x.png">, fetch("./x.json")), a url or a specifier built at runtime, a bare package specifier, @import inside css, or a path that comes from the api ${g.dot} a file referenced beside its own source is not warned about at all: assetChannelFaults refuses the build over it`)}`,
  );
  return total;
}

// read statically, like hydrate
const islandRe = /<Island[\s/>]/;

export async function generateManifest(dev = false) {
  if (!existsSync("pages")) {
    throw new Error("no pages/ directory here - run borgo from the app root (the folder holding pages/)");
  }
  // before the first generated file: that is what a later boot mistakes for a finished build
  markBuildStarted();
  const files = [...new Glob("**/*.tsx").scanSync("pages")]
    .map((f) => f.replaceAll("\\", "/"))
    .sort();

  const special = (f: string) => f.split("/").pop()!.startsWith("_");

  const sources = new Map<string, string>();
  for (const f of files) sources.set(f, await Bun.file(`pages/${f}`).text());

  // a full basename: `endsWith("_layout.tsx")` made pages/post_layout.tsx a
  // phantom layout importing "../pages/post/_layout"
  const layoutDirs = files
    .filter((f) => f === "_layout.tsx" || f.endsWith("/_layout.tsx"))
    .map((f) => f.slice(0, -"_layout.tsx".length).replace(/\/$/, ""));

  const layoutsFor = (file: string) => {
    const parts = file.split("/").slice(0, -1);
    const chain: string[] = [];
    for (let i = 0; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (layoutDirs.includes(dir)) chain.push(dir);
    }
    return chain;
  };

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

  // hydrate=false pages ship no js at all
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

  // registered eagerly: island code rides with the entry, client="visible" defers only the hydration
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

  // the refresh runtime must install itself before react loads: its own module, imported first
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

  // react is imported from inside the app and handed to the runtime, so a
  // linked borgo checkout never brings a second copy into the bundle
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

  // for hydrate=false pages that use islands: hydrates the island markers only
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

// hashed over content, not names: a dev build names its entries client.js and
// islands-client.js whatever they contain, and the precache is keyed on this
export async function precacheStamp(dir: string, files: string[]): Promise<string> {
  let payload = "";
  for (const file of files) {
    const path = `${dir}/${file.replace(/^\/assets\//, "")}`;
    const bytes = await Bun.file(path).arrayBuffer();
    payload += `${file}:${Bun.hash(bytes)}|`;
  }
  return String(Bun.hash(payload));
}

// the postcss plugin, not @tailwindcss/cli (which drags @parcel/watcher and its
// blocked postinstall): in-process, a rebuild goes from ~300ms to ~15ms.
// Loaded from the app, so the app's tailwind version runs
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
  // apps scaffolded before 0.21 only have the cli
  if (!pluginPath || !postcssPath) {
    if (!existsSync("node_modules/@tailwindcss/cli")) {
      throw new Error(
        "--tailwind needs tailwind in the app: bun add -d tailwindcss @tailwindcss/postcss postcss",
      );
    }
    const args = ["x", "@tailwindcss/cli", "-i", "style.css", "-o", `${outDir}/style.css`];
    if (!dev) args.push("--minify");
    // tailwind logs its banner to stderr even on success: only the exit code decides
    const proc = Bun.spawn(["bun", ...args], { stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) throw new Error(`tailwind failed:\n${stderr.trim()}`);
    return;
  }

  // the processor is where the speedup lives; `optimize` is fixed at
  // construction, so a mode flip rebuilds it
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

// null, and only null, means the emitted stylesheet has no source left and is an orphan
export function cssSource(dir = "."): "scss" | "css" | null {
  if (existsSync(join(dir, "style.scss"))) return "scss";
  if (existsSync(join(dir, "style.css"))) return "css";
  return null;
}

function stylesheetOnDisk(dir = outDir): string | null {
  const emitted = readAssetNames()["style.css"];
  if (emitted && existsSync(`${dir}/${emitted}`)) return emitted;
  return existsSync(`${dir}/style.css`) ? "style.css" : null;
}

// only names the build's own inventory claims: without a record the file is
// not provably borgo's and stays (public/assets is gitignored, so it cannot be restored)
function dropStylesheet(inventory: string[] | null = readBuildInventory()): string[] {
  const owned = new Set(inventory ?? []);
  // the content-named one too, or the orphan stays under the name still being served
  const emitted = readAssetNames()["style.css"];
  const removed: string[] = [];
  for (const name of new Set([...(emitted ? [emitted] : []), "style.css"])) {
    if (!owned.has(name)) continue;
    for (const suffix of ["", ".gz", ".br"]) rmSync(`${outDir}/${name}${suffix}`, { force: true });
    removed.push(name);
  }
  return removed;
}

// true only if this build compiled the stylesheet: what it did not write it must not rename or record
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
  // also the scss -> tailwind switch, whose first build runs without BORGO_TAILWIND
  if (cssSource() === null) {
    for (const name of dropStylesheet()) {
      console.warn(
        `  ${c.terracotta(g.change)} public/assets/${name} dropped ` +
          `${c.dim(`${g.dot} the app has no style.scss or style.css left to compile`)}`,
      );
    }
    return false;
  }
  // tailwind is opt-in by flag, never by detection: not compiled, not deleted, and said
  const kept = stylesheetOnDisk();
  if (!kept) {
    // on a clean clone there is no last build to leave: nothing recovers without the flag
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

// hashed chunks are not guessed: they come from the inventory. client.js and
// islands-client.js are what a dev build, or a pre-content-naming borgo, left
const FIXED_OUTPUT = ["client.js", "islands-client.js", "precache.json"];

// the names index.html is written against: an author never types a hash, the server resolves at boot
export const LOGICAL_ASSETS = ["client.js", "islands-client.js", "style.css"] as const;

// recorded, never inferred from a shape: `analytics-9f8e7d6c.js` is an app's
// file that looks exactly like a chunk
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

// only the bundler knows which names it hashed: `stripe-checkout.js` matches
// any eight-letter shape. Absent or malformed record: the empty set, which
// pins nothing and spends a conditional request per asset
export function readBuildOutputs(path = inventoryPath): BuildOutputs {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { dir?: unknown; hashed?: unknown };
    // without the directory the server is back to recognising an output by its path's shape
    if (typeof parsed.dir !== "string" || !parsed.dir) return NO_BUILD_OUTPUTS;
    const entries = parsed.hashed;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return NO_BUILD_OUTPUTS;
    const sizes = new Map<string, number>();
    for (const [name, size] of Object.entries(entries as Record<string, unknown>)) {
      if (!name || name.includes("/") || name.includes("\\")) continue;
      // a recorded 0 would pin any truncated file at that name; the cost is a
      // legitimately empty stylesheet revalidating forever
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) continue;
      sizes.set(name, size);
    }
    return sizes.size ? { dir: parsed.dir, sizes } : NO_BUILD_OUTPUTS;
  } catch {
    return NO_BUILD_OUTPUTS;
  }
}

// absent or foreign names fall back to the literal the document carries,
// which revalidates and works, rather than a guess that might 404
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

export type AssetProblem = { name: string; why: string };

// not existsSync: a directory exists, a truncated file exists, and an empty
// entry is served 204 - a success with a document that never hydrates
// (measured). Every recorded file, not the logical three: a missing chunk
// takes hydration down while client.js looks healthy. Zero bytes condemns a
// .js outright; anything else only when the record vouches for another
// length, since a scss of only variables really compiles to nothing
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

export function missingBuiltAssets(
  names: AssetNames = readAssetNames(),
  inventory: string[] | null = readBuildInventory(),
  outputs: BuildOutputs = readBuildOutputs(),
): string[] {
  return unusableBuiltAssets(names, inventory, outputs).map((p) => p.name);
}

// reasons and decision from one place: a boot that announces one cause and
// rebuilds for another sends the reader to the wrong file
export function buildReasons(names: AssetNames = readAssetNames()): string[] {
  const why: string[] = [];
  const bad = unusableBuiltAssets(names);
  if (bad.length) {
    // a partial deploy breaks every name at once; a line naming seventeen files is not read
    const shown = bad.slice(0, 3).map((p) => `${p.name} ${p.why}`);
    if (bad.length > shown.length) shown.push(`and ${bad.length - shown.length} more`);
    why.push(`in public/assets, ${shown.join(", ")}`);
  }
  if (!existsSync(`${genDir}/routes.gen.tsx`)) why.push("there is no route manifest here");
  if (buildLeftUnfinished()) why.push("the last build here did not finish");
  return why;
}

// doubt resolves toward rebuilding: the cost is one build
export const needsBuild = (dev: boolean, names: AssetNames = readAssetNames()): boolean =>
  dev || buildReasons(names).length > 0;

// the bundler reports artifacts, not which entrypoint produced them: the stem is all that is borgo's own
export function entryOutputNames(files: readonly string[]): AssetNames {
  const names: AssetNames = {};
  for (const file of files) {
    const match = file.match(/^(islands-client|client)(?:-[^.]+)?\.js$/);
    if (match) names[`${match[1]}.js`] = file;
  }
  return names;
}

// the same shape bun gives a chunk
const contentHash = (bytes: ArrayBuffer): string =>
  Bun.hash(bytes).toString(36).padStart(8, "0").slice(-8);

// renamed, not copied: two files with the same bytes under different names is
// the state where the sweep deletes the one the document uses. A build that
// did not write style.css must not rename it: recording it as its own output
// is the next build's licence to delete it
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

// from disk, not `BuildArtifact.size`: renameUnsafeChunks rewrites import
// strings inside a chunk after the bundler reported it
export function recordedOutputSizes(dir: string, names: readonly string[]): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const name of names) {
    try {
      // see readBuildOutputs
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

// Bun.build reports a hash for every artifact, dev `client.js` included: the
// name is a promise only when it actually contains it
export const nameCarriesHash = (file: string, hash: string | null): boolean =>
  hash !== null && hash !== "" && basename(file).includes(hash);

// `renamedTo`: the name a cache asks about is where renameUnsafeChunks put the file
export const hashedOutputNames = (
  outputs: readonly { path: string; hash: string | null }[],
  renamedTo: (path: string) => string = (p) => p,
): string[] =>
  outputs
    .map((o) => ({ file: basename(renamedTo(o.path).replaceAll("\\", "/")), hash: o.hash }))
    .filter((o) => nameCarriesHash(o.file, o.hash))
    .map((o) => o.file);

// `owned` a build wrote, `keep` this build just wrote. Precompressed siblings
// are always stale by the next run (dev writes none, production only rewrites
// one that came out smaller), so they go with either
export function isSweepable(file: string, owned: Set<string>, keep: Set<string> = new Set()): boolean {
  const sibling = file.match(/^(.*)\.(gz|br)$/);
  if (sibling) {
    const base = sibling[1];
    return base === "style.css" || owned.has(base) || keep.has(base);
  }
  return owned.has(file) && !keep.has(file);
}

// only the build's own output: the directory also holds the app's vendored
// files. With no inventory the last build's chunks are left alone - a stale
// chunk is dead weight, a deleted app file is not recoverable
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

// bun leaves the "[name]" token literal for a chunk it cannot name; brackets
// in a url path are legal, but s3, some cdns and some proxies mangle them
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

// BORGO_STATIC compiles the props path out: a static host answers
// ?__borgo=props with the document and a 200, so it cannot be tried and caught
export function buildDefine(dev: boolean, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
    "process.env.BORGO_STATIC": JSON.stringify(env.BORGO_STATIC === "1" ? "1" : "0"),
  };
}

// bun reports file and position separately, and sometimes not at all
export function formatBuildLog(log: unknown): string {
  const message = log instanceof Error ? log.message : String(log);
  const position = (log as { position?: { file?: string; line?: number; column?: number } }).position;
  const file = position?.file?.replaceAll("\\", "/");
  if (!file) return message;
  const at = position?.line ? `:${position.line}${position.column ? `:${position.column}` : ""}` : "";
  return `${file}${at} ${g.dot} ${message}`;
}

export class BundleFailed extends Error {
  readonly details: string[];
  constructor(logs: readonly unknown[]) {
    const details = logs.map(formatBuildLog);
    super(`the client bundle failed to build${details.length ? `:\n${details.join("\n")}` : ""}`);
    this.name = "BundleFailed";
    this.details = details;
  }
}

// off the whole argv, like --tailwind in cli.ts; the variable is for builds
// without a command line (the dev server's own rebuilds, a test)
export const debugEnabled = (
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean => argv.includes("--debug") || env.BORGO_DEBUG === "1";

function causeChain(error: unknown): string[] {
  const chain: string[] = [];
  let current: unknown = (error as { cause?: unknown })?.cause;
  while (current && chain.length < 4) {
    chain.push(current instanceof Error ? current.message : String(current));
    current = (current as { cause?: unknown })?.cause;
  }
  return chain;
}

// every failure, not just BundleFailed: a sass error or an EACCES escaped as
// a raw v8 trace, the one thing that names no file of the operator's
export function reportBuildFailure(error: unknown, debug = debugEnabled()): void {
  if (error instanceof AssetChannelRefused) {
    console.error(`\n  ${c.red(g.err)} ${error.message}`);
    for (const line of error.lines) console.error(`    ${c.red(g.err)} ${line}`);
    console.error(
      `  ${c.dim(`${g.dot} this tree is left marked unfinished, so the next boot rebuilds it rather than serving it`)}\n`,
    );
    return;
  }
  if (error instanceof BundleFailed) {
    console.error(`\n  ${c.red(g.err)} the client bundle failed to build`);
    for (const detail of error.details) console.error(`    ${detail}`);
    console.error(`  ${c.dim(`${g.dot} public/assets still holds the last build that worked`)}\n`);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n  ${c.red(g.err)} ${message}`);
  for (const cause of causeChain(error)) console.error(`    ${c.dim(`caused by ${g.dot}`)} ${cause}`);
  // an fs error carries the path it failed on
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

  // read before the bundle, swept after it succeeds: swept first, one parse
  // error took the last good build with it
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
    // dev keeps the entry name fixed: the shell is resolved once at boot
    naming: { entry: dev ? "[name].[ext]" : "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]" },
    define,
    plugins: [appTranspile(define, dev)],
    // bun's own throw is an AggregateError whose message is a bare trace
    throw: false,
  });
  if (!result.success) throw new BundleFailed(result.logs);
  const renamed = await renameUnsafeChunks(result.outputs.map((o) => o.path));
  const outPath = (p: string) => renamed.get(p) ?? p;
  const assets = result.outputs.map((o) => ({ path: outPath(o.path), kind: o.kind, size: o.size }));

  const named = (p: string) => p.replaceAll("\\", "/").split("/").pop()!;
  const emitted = assets.map((a) => named(a.path));
  // the stylesheet is not the bundler's: swept, recorded and vouched for alongside its output
  const written = stylesheet ? [...emitted, stylesheet] : emitted;
  const hashed = hashedOutputNames(result.outputs, outPath);
  if (stylesheet && stylesheet !== "style.css") hashed.push(stylesheet);
  // entry-point artifacts only: splitting also emits a shared chunk named
  // client-<hash>.js, and a document sent to that one hydrates nothing
  const names = entryOutputNames(
    assets.filter((a) => a.kind === "entry-point").map((a) => named(a.path)),
  );
  if (stylesheet) names["style.css"] = stylesheet;
  sweepBuildOutput(outDir, previous, written);

  if (!dev) {
    const files = result.outputs
      .filter((o) => o.path.endsWith(".js"))
      .map((o) => "/assets/" + outPath(o.path).replaceAll("\\", "/").split("/").pop());
    // the emitted name: cache.addAll rejects as a whole on one missing url, and
    // a worker that never installs never replaces the one holding the previous deploy
    if (stylesheet) files.push(`/assets/${stylesheet}`);
    files.sort();
    const stamp = await precacheStamp(outDir, files);
    await Bun.write(`${outDir}/precache.json`, JSON.stringify({ stamp, assets: files }));
    // into the worker's body too: a byte-identical sw.js is never reinstalled,
    // so install and activate would never run again after the first deploy
    stampWorkerFile(stamp);
  }

  if (!dev) await precompressAssets(outDir);

  // after precompression: .br and .gz go out under the same url and the same
  // directive, so they are vouched for the same way; unwritten siblings are not
  // stat'able and stay unpinnable. A failure before this write leaves the old
  // inventory, which names files that are gone: pins nothing, sweeps nothing
  const vouchable = hashed.flatMap((name) => [name, `${name}.gz`, `${name}.br`]);
  await writeBuildInventory(
    written,
    { dir: outDir, sizes: recordedOutputSizes(outDir, vouchable) },
    inventoryPath,
    names,
  );
  await Bun.write(buildModePath, buildModeFor(dev));

  // before the mark comes off, so a refused build is rebuilt by the next boot, not served
  const faults = assetChannelFaults(bundleSources(outDir), publicAssetUrls("public"), bundledAssetNames(assets));
  if (faults.length) throw new AssetChannelRefused(faults);

  clearBuildMark();

  // after the build has committed and inside a catch: reading the source tree
  // must not fail a build that produced its output. Dev too: that is the
  // machine the spelling looks right on
  try {
    warnAssetCase(".", "public");
  } catch {}

  // the injected marker tells the fast-refresh channel which chunk belongs to which page
  const chunkMap: Record<string, string> = {};
  if (dev) {
    for (const output of result.outputs) {
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

// the babel plugin's $RefreshSig$ signatures are what let a hook edit remount
// only that component; runs on the bun transpiler's plain-js output
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
      // .ts too: a custom hook without a signature force-remounts every component using it
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
