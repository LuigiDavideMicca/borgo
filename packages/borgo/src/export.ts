// borgo export: prerenders every statically exportable route into a plain
// dist/site/ of html files + assets, servable by any static file server.
// exportable means: no loader, or `export const prerender = true` (the loader
// runs once now, against a temporary api process); dynamic-param routes need
// `export const prerenderPaths` returning the param sets.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeApiClient } from "./api";
import { buildAssets, reportBuildFailure } from "./build";
import { banner, c, fmtMs, g } from "./colors";
import { isHiddenAsset } from "./compress";
import { CSRF_COOKIE, CSRF_FIELD } from "./index";
import type { Route } from "./router";
import { goBinName, runBorgogen } from "./util";

type ExportModule = Route["module"];

export type ExportPlan = {
  plans: Array<{ route: Route; dynamic: boolean }>;
  skipped: Array<{ pattern: string; reason: string }>;
  needApi: boolean;
  export404: boolean;
};

// pure partition of the route table, unit-testable without a build. a _404
// page exports as 404.html even when no regular page is exportable
export function planExport(routes: Route[], notFound: Route | null = null): ExportPlan {
  const plan: ExportPlan = { plans: [], skipped: [], needApi: false, export404: false };
  for (const route of routes) {
    const module = route.module as ExportModule;
    const dynamic = route.pattern.includes(":");
    if (module.loader && module.prerender !== true) {
      plan.skipped.push({ pattern: route.pattern, reason: "has a loader without `export const prerender = true`" });
      continue;
    }
    if (dynamic && typeof module.prerenderPaths !== "function") {
      plan.skipped.push({ pattern: route.pattern, reason: "dynamic params without `export const prerenderPaths`" });
      continue;
    }
    if (module.loader || module.prerenderPaths) plan.needApi = true;
    plan.plans.push({ route, dynamic });
  }
  const notFoundModule = notFound?.module as ExportModule | undefined;
  if (notFoundModule) {
    plan.export404 = !notFoundModule.loader || notFoundModule.prerender === true;
    if (!plan.export404) {
      plan.skipped.push({ pattern: "404", reason: "has a loader without `export const prerender = true`" });
    } else if (notFoundModule.loader) {
      plan.needApi = true;
    }
  }
  return plan;
}

// characters windows refuses in a path component. every one of them is a legal
// url character that encodeURIComponent happily escapes, and outputPath decodes
// the segment straight back before mkdir - so an ISO timestamp param
// ("2024-01-01T00:00:00Z") exports fine on linux and dies with EINVAL on
// windows, which is the worst possible place to find out.
const WINDOWS_ILLEGAL = /["*:<>?|\u0000-\u001f]/;
// and the device names, which are reserved with or without an extension
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// null for a usable param, otherwise why it cannot become a directory
export function unsafeParamReason(raw: string): string | null {
  if (/[\\/]/.test(raw)) return "contains a path separator";
  // outputPath turns each segment into a directory, so a dot segment would
  // climb out of dist/site and write an index.html somewhere else entirely
  if (raw === "." || raw === "..") return `is the dot segment "${raw}"`;
  const illegal = raw.match(WINDOWS_ILLEGAL);
  if (illegal) {
    const shown = illegal[0] < " " ? `\\u${illegal[0].charCodeAt(0).toString(16).padStart(4, "0")}` : illegal[0];
    return `contains "${shown}", which windows does not allow in a path`;
  }
  if (WINDOWS_RESERVED.test(raw)) return `is "${raw}", a reserved windows device name`;
  // windows silently strips both, so the directory would not be the one the
  // url names and the page would 404 on the host that serves it
  if (/[. ]$/.test(raw)) return "ends in a dot or a space, which windows strips from a path";
  return null;
}

// the result is a url path (fed to fetch), so params are encoded; a param that
// cannot survive the round trip back to a directory name is rejected here,
// where the message can name the route and the param
export function fillPattern(pattern: string, params: Record<string, string | number>): string {
  return pattern.replace(/:(\w+)/g, (_, name) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`prerenderPaths for ${pattern}: missing param "${name}"`);
    }
    const raw = String(value);
    const reason = unsafeParamReason(raw);
    if (reason) {
      throw new Error(`prerenderPaths for ${pattern}: param "${name}" ${reason}`);
    }
    return encodeURIComponent(raw);
  });
}

// "/" -> index.html, "/about" -> about/index.html: the directory style every
// static server resolves without configuration. segments decode on disk
// (posts/citt%C3%A0 -> posts/città): static servers decode the request path
// before hitting the filesystem, an encoded dir name would 404
export function outputPath(path: string): string {
  if (path === "/") return "index.html";
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const dir = path.replace(/^\/+/, "").replace(/\/+$/, "").split("/").map(decode).join("/");
  return `${dir}/index.html`;
}

// the client bundle an export ships must not ask for ?__borgo=props: a static
// host answers that url with the page's own html document and a 200, so res.ok
// passes, res.json() throws, and the runtime falls back to a full reload -
// after having downloaded the document twice, once per link, and a third time
// for every link a pointer merely crossed (prefetch caches the doomed promise).
// buildDefine turns this into a literal in the bundle, so the whole path is
// compiled out rather than tried and caught.
//
// AND THE CSP GOES OFF, because a csp is a response HEADER. A static host
// serves the file, not the header borgo would have written, so no policy ever
// governs an exported page - but the nonce minted for that policy was written
// into every <script> in the file. Measured on a real dist/site: six documents,
// six different `nonce="..."`, one per fetch, frozen. A nonce printed in the
// document, the same for every visitor and permanent, is not a nonce: a
// `script-src 'nonce-<that>'` allows exactly what an injected script can copy
// off the page it was injected into. Rendering with no csp means no nonce is
// minted at all - by react for its suspense scripts either - and the policy is
// left where a static site can actually have one, in the host's header config.
export function markStaticExport(env: NodeJS.ProcessEnv = process.env) {
  env.BORGO_STATIC = "1";
  env.BORGO_CSP = "0";
}

// A value minted for one request cannot be published as a file. `<CsrfField />`
// renders the token that has to match a borgo_csrf cookie, and a static host
// sets no cookies: what ships is one constant string, identical for every
// visitor, checked against nothing. The form is not weakly protected, it is
// dead - and a page that ships a dead form looks exactly like a page that works.
//
// ASKED OF THE BYTES ABOUT TO BE WRITTEN, NEVER OF THE ROUTE MODULE. A
// `<CsrfField />` can come from a layout, an island, a conditional or a
// component three packages deep; the module tells you nothing, and the file is
// the thing that ships. `<` is escaped in text (react) and in props
// (scriptJson's <), so a tag can only match a real tag - page content
// about csrf cannot trip these.
//
// `what` names it on the page's own line, which stays short enough to read;
// `why` is printed once at the end, for the residues actually found.
export type Residue = { what: string; why: string[] };

const RESIDUE: Array<Residue & { test: RegExp }> = [
  {
    test: new RegExp(`<input\\b[^>]*\\bname="${CSRF_FIELD}"`),
    what: "a <CsrfField /> token",
    why: [
      `the token is only ever checked against a ${CSRF_COOKIE} cookie, and a static host sets none: what ships is one constant, and the form is inert`,
      "<CsrfField /> guards a borgo action, and a static export runs no actions: drop the form, or serve that page with borgo start",
      `a form posting anywhere else needs no <CsrfField /> ${g.dot} check your layouts too, they render into every page`,
    ],
  },
  {
    test: /<(?:script|style)\b[^>]*\snonce="/i,
    what: "a csp nonce",
    why: [
      "the header that would name the nonce does not ship with the file, so the value is public, permanent, and allows whatever can read the page",
      "borgo export renders with no csp for exactly that reason: set the policy on your static host",
    ],
  },
];

// what this document carries that only meant something to the request that
// produced it; empty when the file can be published as it is
export function requestResidue(html: string): Residue[] {
  return RESIDUE.filter((r) => r.test.test(html)).map(({ what, why }) => ({ what, why }));
}

export const residueMessage = (residue: Residue[]) =>
  `cannot be exported ${g.dot} it carries ${residue.map((r) => r.what).join(" and ")}`;

const listenFree = () =>
  new Promise<import("node:net").Server>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(server));
  });

// every listener stays open until all ports are picked: closing one before
// asking for the next lets the os hand out the same port twice
export async function freePorts(count: number): Promise<number[]> {
  const servers: Array<import("node:net").Server> = [];
  for (let i = 0; i < count; i++) servers.push(await listenFree());
  const ports = servers.map((s) => (s.address() as { port: number }).port);
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  return ports;
}

// what serveAsset would answer 200 to, through its own predicate: a dotfile
// borgo start refuses must not reach dist/site either, or the 404 masks the
// exposure. On the file, never on a directory: public/.well-known/ goes whole.
export const isExportedFile = (path: string): boolean => !isHiddenAsset(path);

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export function copyPublic(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true, filter: (path) => isDirectory(path) || isExportedFile(path) });
}

// a file plus its .gz/.br siblings is one asset; an orphan .gz/.br with no
// base file next to it counts as an asset in its own right
export function countAssets(dir: string): { assets: number; precompressed: number } {
  let assets = 0;
  let precompressed = 0;
  const files = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && isExportedFile(entry.name)) files.add(join(entry.parentPath, entry.name));
  }
  for (const file of files) {
    const m = file.match(/\.(gz|br)$/);
    if (m && files.has(file.slice(0, -m[0].length))) precompressed++;
    else assets++;
  }
  return { assets, precompressed };
}

export function exportSummary(pages: number, wrote404: boolean, assets: number, precompressed: number): string {
  const parts = [`${pages} pages`, ...(wrote404 ? ["404.html"] : []), `${assets} assets`];
  const variants = precompressed ? ` (with ${precompressed} precompressed variants)` : "";
  return `exported ${parts.join(" + ")}${variants}`;
}

// Windows releases an image only once the process is gone, and that lags the
// process's own exit, so a refusal is retried rather than thrown.
//
// It never throws. This runs from a finally, where an exception replaces
// whatever the export was already reporting - a page that failed to render
// would surface as an EPERM on a file the operator never asked about. A binary
// that outlives its removal is said out loud instead.
export async function removeScratchBin(
  bin: string,
  attempts = 20,
  wait = 50,
  say: (line: string) => void = console.log,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(bin, { force: true });
      return true;
    } catch {
      await Bun.sleep(wait);
    }
  }
  say(`  ${c.dim(`${g.dot} could not remove ${bin} ${g.dot} it is safe to delete`)}`);
  return false;
}

export async function exportSite(): Promise<number> {
  const t0 = performance.now();
  console.log(`\n  ${banner("export")}\n`);

  if (!(await runBorgogen())) return 1;
  const hadCsp = process.env.BORGO_CSP !== undefined;
  markStaticExport();
  try {
    await buildAssets(false);
  } catch (error) {
    // every way the build can fail, not just the bundler's: an export that
    // dies on a sass error or a missing --tailwind is still an export that
    // must not print a v8 trace and must not go on to render pages
    reportBuildFailure(error);
    return 1;
  }

  const manifest = pathToFileURL(join(process.cwd(), ".borgo/routes.gen.tsx")).href;
  const { routes, notFound } = (await import(manifest)) as {
    routes: Route[];
    notFound: Route | null;
  };
  const { plans, skipped, needApi, export404 } = planExport(routes, notFound);

  if (plans.length === 0 && !export404) {
    for (const s of skipped) {
      console.log(`  ${c.dim(g.dot)} ${s.pattern.padEnd(16)} ${c.dim(`skipped ${g.dot} ${s.reason}`)}`);
    }
    console.log(`\n  ${c.red(g.err)} nothing is exportable\n`);
    return 1;
  }

  const [apiPort, frontPort] = await freePorts(2);
  process.env.API_PORT = String(apiPort);
  process.env.PORT = String(frontPort);
  // a shell API_URL (split deployment) would send loaders to the real api
  // mid-export; the export always talks to its own ephemeral one
  delete process.env.API_URL;
  process.env.BORGO_RELOAD = "1"; // quiet startup lines from the servers

  // loaders and prerenderPaths run for real, so they get a real api: the
  // binary is built and spawned on an ephemeral port, and killed at the end
  let apiProc: import("bun").Subprocess | null = null;
  // named before the build, never after: `go build -o` writes the file it was
  // told to write, and a build that dies partway still leaves one
  let apiBin: string | null = null;

  let failures = 0;
  // rendered beside the published directory and moved onto it at the end,
  // because dist/site is what CI uploads. Deleting it first meant a run that
  // failed on page four published the three pages it had managed plus a valid
  // index.html - a site that looks complete, with a hole in it, and no way to
  // tell from the outside. The previous export stays up until this one has
  // rendered every page it planned.
  const outDir = "dist/site";
  const stageDir = `dist/.site-staged-${process.pid}`;
  try {
    if (needApi) {
      // a scratch binary: dist/ may be running under borgo start right now,
      // and windows locks executing binaries against overwrite
      apiBin = `.borgo/export-${goBinName()}`;
      const goBuild = Bun.spawn(["go", "build", "-o", apiBin, "."], { stdout: "inherit", stderr: "inherit" });
      if ((await goBuild.exited) !== 0) {
        console.error(`  ${c.red(g.err)} go build failed`);
        return 1;
      }
      // explicit env: a mutated process.env does not reliably reach children
      apiProc = Bun.spawn([apiBin], {
        stdout: "ignore",
        stderr: "inherit",
        env: { ...process.env, API_PORT: String(apiPort), PORT: String(frontPort) },
      });
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          await fetch(`http://localhost:${apiPort}/`, { signal: AbortSignal.timeout(1_000) });
          break;
        } catch {}
        if (Date.now() > deadline) {
          console.error(`  ${c.red(g.err)} api never answered on :${apiPort}`);
          return 1;
        }
        await Bun.sleep(100);
      }
    }

    const apiUrl = `http://localhost:${apiPort}/api`;
    const api = makeApiClient(`http://localhost:${apiPort}`);

    // expand dynamic routes now that the api answers
    const pages: Array<{ path: string; route: Route }> = [];
    for (const { route, dynamic } of plans) {
      if (!dynamic) {
        pages.push({ path: route.pattern, route });
        continue;
      }
      const sets = await route.module.prerenderPaths!({ api, apiUrl });
      for (const params of sets) pages.push({ path: fillPattern(route.pattern, params), route });
    }

    // the real front server renders, so an export is byte-identical to ssr
    const { serve } = await import("./server");
    await serve({ dev: false });

    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });

    let written = 0;
    const failed: string[] = [];
    // pages refused for what they carry, not for failing to render: they get
    // their own closing note, since the fix is in the page and not in the run
    const refused: string[] = [];
    // keyed by `what`, so two pages carrying the same residue explain it once
    const refusedWhy = new Map<string, string[]>();
    const noteRefusal = (path: string, residue: Residue[]) => {
      refused.push(path);
      for (const r of residue) refusedWhy.set(r.what, r.why);
      return new Error(residueMessage(residue));
    };
    for (const { path, route } of pages) {
      const zeroJs = route.module.hydrate === false && !route.islands;
      const target = join(stageDir, outputPath(path));
      try {
        const res = await fetch(`http://localhost:${frontPort}${path}`);
        if (!res.ok) throw new Error(`responded ${res.status}`);
        const html = await res.text();
        const residue = requestResidue(html);
        if (residue.length) throw noteRefusal(path, residue);
        mkdirSync(dirname(target), { recursive: true });
        await Bun.write(target, html);
        written++;
        const rel = join(outDir, outputPath(path)).replaceAll("\\", "/");
        const note = zeroJs ? ` ${g.dot} zero js` : "";
        console.log(`  ${c.sage(g.ok)} ${path.padEnd(16)} ${c.dim(`${g.arrow} ${rel}${note}`)}`);
      } catch (error) {
        failures++;
        failed.push(path);
        console.log(`  ${c.red(g.err)} ${path.padEnd(16)} ${error instanceof Error ? error.message : error}`);
      }
    }
    // a _404 page exports as 404.html, the file static hosts serve for unknown
    // paths (nginx error_page, most static hosting picks it up by name); it is
    // its own line item, not one of the pages
    let wrote404 = false;
    if (export404) {
      // any unmatched path renders the _404 page with a 404 status
      try {
        const res = await fetch(`http://localhost:${frontPort}/__borgo-export-404-probe`);
        if (res.status !== 404) throw new Error(`responded ${res.status}`);
        const html = await res.text();
        const residue = requestResidue(html);
        if (residue.length) throw noteRefusal("404", residue);
        await Bun.write(join(stageDir, "404.html"), html);
        wrote404 = true;
        console.log(
          `  ${c.sage(g.ok)} ${"404".padEnd(16)} ${c.dim(`${g.arrow} ${outDir}/404.html ${g.dot} wire it as your host's error page`)}`,
        );
      } catch (error) {
        failures++;
        failed.push("404");
        console.log(`  ${c.red(g.err)} ${"404".padEnd(16)} ${error instanceof Error ? error.message : error}`);
      }
    }
    for (const s of skipped) {
      console.log(`  ${c.dim(g.dot)} ${s.pattern.padEnd(16)} ${c.dim(`skipped ${g.dot} ${s.reason}`)}`);
    }

    // assets ride along, precompressed siblings included, so hydrated pages
    // find their chunks next to the html
    let assets = 0;
    let precompressed = 0;
    if (existsSync("public")) {
      ({ assets, precompressed } = countAssets("public"));
      // only onto a staging directory that is going to be published
      if (!failures) copyPublic("public", stageDir);
    }

    // the swap, and only now: a partial render is not published under the name
    // a deploy step reads. What is already in dist/site is the last export that
    // rendered whole, which is a site that works.
    if (!failures) {
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(dirname(outDir), { recursive: true });
      renameSync(stageDir, outDir);
    }

    const mark = failures ? c.red(g.err) : c.sage(g.ok);
    const where = failures ? `${g.dot} not published` : `${g.arrow} dist/site`;
    console.log(
      `\n  ${mark} ${exportSummary(written, wrote404, assets, precompressed)} ${where} in ${c.bold(fmtMs(performance.now() - t0))}`,
    );
    if (failures) {
      console.log(`  ${c.red(g.err)} ${failures} page(s) failed to export: ${failed.join(", ")}`);
      console.log(
        `  ${c.dim(`${g.dot} nothing was published ${g.dot} dist/site still holds the last export that rendered whole`)}`,
      );
    }
    // said once, and only when a page was actually refused: the fix is in the
    // page, not in the run, and repeating it per page buries it
    if (refused.length) {
      console.log(
        `\n  ${c.red(g.err)} ${refused.join(", ")} ${refused.length > 1 ? "carry" : "carries"} a value that only meant something to the request that rendered it, and an exported page is one file served to everyone.`,
      );
      for (const [what, why] of refusedWhy) {
        console.log(`  ${c.dim(`${g.dot} ${what}:`)}`);
        for (const line of why) console.log(`    ${c.dim(`${g.dot} ${line}`)}`);
      }
    }
    console.log(
      `  ${c.dim(`${g.dot} a static export serves pages only: actions, sse and websocket topics need borgo start`)}`,
    );
    // BORGO_CSP is overridden by markStaticExport, so an operator who set one
    // has to be told their policy is not in these files - it never could be
    console.log(
      `  ${c.dim(`${g.dot} the csp is a response header, so it is not in these files ${g.dot} set it on your static host${hadCsp ? ` (BORGO_CSP was set here and does not ship)` : ""}`)}`,
    );
    // the export rebuilt public/assets with the props endpoint compiled out of
    // the bundle. `.borgo/build-mode` now says so, and `borgo start` rebuilds
    // rather than serving a bundle that reloads the document on every link.
    console.log(
      `  ${c.dim(`${g.dot} public/assets now holds the export build ${g.dot} borgo start rebuilds it for production`)}\n`,
    );
  } finally {
    apiProc?.kill();
    await apiProc?.exited;
    // a successful run renamed it away; anything else leaves a half-rendered
    // tree in dist/ that nothing will ever read again
    rmSync(stageDir, { recursive: true, force: true });
    // and the 21 MB the api ran from, which nothing removed at all: the binary
    // was built, spawned, killed, and left. Measured on examples/tasks,
    // .borgo/export-api.exe, 21,217,280 bytes, two weeks stale; reproduced in a
    // scratch copy on both paths, since a failed export left it exactly as a
    // whole one did. What a command builds to work, it removes even when it
    // fails - so this is here, beside the kill, and not on the happy path.
    if (apiBin) await removeScratchBin(apiBin);
  }
  return failures ? 1 : 0;
}
