import { Glob } from "bun";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, sep } from "node:path";
import { c, g } from "./colors";
import { NO_BUILD_OUTPUTS, precompressAssets, type BuildOutputs } from "./compress";
import { stampWorkerFile } from "./pwa";
import { filePathToPattern } from "./router";
import { metricsEnabled } from "./util";

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

export function assetsBuildMode(): BuildMode | null {
  try {
    const mode = readFileSync(buildModePath, "utf8").trim();
    return mode === "dev" || mode === "production" || mode === "export" ? mode : null;
  } catch {
    return null;
  }
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

// islands are detected by the <Island marker in the page (or layout) source,
// like hydrate: read statically, without executing the page
const islandRe = /<Island[\s/>]/;

export async function generateManifest(dev = false) {
  if (!existsSync("pages")) {
    throw new Error("no pages/ directory here - run borgo from the app root (the folder holding pages/)");
  }
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
export type BuildResult = { assets: Asset[]; chunkMap: Record<string, string> };

// the cache key a service worker hangs its precache on, so it must move
// whenever any listed byte does. names alone are not enough: chunks are
// content-hashed but the entry points (client.js, islands-client.js) and
// style.css keep stable names, and a change confined to one of them - a layout
// edit lands in client.js - would leave the stamp, and every cache keyed on
// it, pinned to yesterday's bundle
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

// the emitted stylesheet and its precompressed siblings, dropped when the
// previous build's css outlives the file it came from: still served, still
// recompressed, still listed in precache.json, forever.
//
// the orphan test is made HERE rather than by the caller. A tailwind app whose
// build was launched without --tailwind (`borgo export` never got the flag)
// reaches this with no style.scss and a perfectly live style.css entry beside
// it, and public/assets is gitignored by every template - deleting the app's
// only stylesheet there is not recoverable. Returns whether it deleted.
function dropStylesheet(): boolean {
  if (cssSource() !== null) return false;
  for (const suffix of ["", ".gz", ".br"]) {
    rmSync(`${outDir}/style.css${suffix}`, { force: true });
  }
  return true;
}

export async function compileCss(dev = false) {
  if (process.env.BORGO_TAILWIND === "1") return compileTailwind(dev);
  // a deleted or renamed style.scss - and the scss -> tailwind switch, which
  // leaves BORGO_TAILWIND unset on the build that removed the scss - must take
  // the stylesheet it produced with it
  if (!existsSync("style.scss")) {
    if (dropStylesheet()) return;
    // tailwind is opt-in by flag, never by detection, so this build cannot
    // compile it - but it must not delete it either, and silence here reads
    // as "the stylesheet is stale" on the next page load
    console.warn(
      `  ${c.terracotta(g.change)} style.css is the app's stylesheet but this command ran without ` +
        `${c.bold("--tailwind")} ${c.dim(`${g.dot} public/assets/style.css left as the last build wrote it`)}`,
    );
    return;
  }
  const sass = await import("sass-embedded");
  const css = await sass.compileAsync("style.scss", { style: dev ? "expanded" : "compressed" });
  await Bun.write(`${outDir}/style.css`, css.css);
}

// the names borgo writes on every build, whatever the app looks like. the
// hashed chunks are NOT guessable and are not guessed: they come from the
// inventory below.
const FIXED_OUTPUT = ["client.js", "islands-client.js", "precache.json"];

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
      // truncated or half-written file is what is on disk. An empty output
      // that revalidates forever costs a 304 on nothing.
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) continue;
      sizes.set(name, size);
    }
    return sizes.size ? { dir: parsed.dir, sizes } : NO_BUILD_OUTPUTS;
  } catch {
    return NO_BUILD_OUTPUTS;
  }
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
) {
  const hashed: Record<string, number> = {};
  for (const name of Object.keys(vouched?.sizes ?? {}).sort()) hashed[name] = vouched!.sizes[name];
  const body = { files: [...new Set(files)].sort(), dir: vouched?.dir ?? "", hashed };
  await Bun.write(path, JSON.stringify(body) + "\n");
}

/**
 * Whether the bundler put this artifact's own content hash into its name.
 *
 * Not "does the name look hashed". `Bun.build` reports a content hash for
 * every artifact, including the entry points - borgo names those `[name].[ext]`
 * on purpose, so `client.js` carries a hash that is nowhere in its filename and
 * is emphatically not cacheable forever. The name is a promise only when it
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

export async function buildAssets(dev = false): Promise<BuildResult> {
  if (dev) void loadBabelRefresh();
  const { hasIslands } = await generateManifest(dev);
  await compileCss(dev);

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
    naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]" },
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
  // recorded here because this is the only place that knows what the bundler
  // hashed; every consumer downstream reads the list instead of guessing
  const hashed = hashedOutputNames(result.outputs, outPath);
  sweepBuildOutput(outDir, previous, emitted);

  // prod only: the hashed asset list a service worker can precache; the
  // stamp changes whenever any listed content does
  if (!dev) {
    const files = result.outputs
      .filter((o) => o.path.endsWith(".js"))
      .map((o) => "/assets/" + outPath(o.path).replaceAll("\\", "/").split("/").pop());
    if (existsSync(`${outDir}/style.css`)) files.push("/assets/style.css");
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
  await writeBuildInventory(emitted, {
    dir: outDir,
    sizes: recordedOutputSizes(outDir, vouchable),
  });
  await Bun.write(buildModePath, buildModeFor(dev));

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
  return { assets, chunkMap };
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
