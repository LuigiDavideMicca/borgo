import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { makeApiClient } from "./api";
import { buildAssets, reportBuildFailure } from "./build";
import { banner, c, fmtMs, g } from "./colors";
import { inHiddenDirectory, isHiddenAsset } from "./compress";
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

// a _404 page exports as 404.html even when no regular page is exportable
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

// every one of these is a legal url character that outputPath decodes straight
// back before mkdir: an ISO timestamp param exports on linux and dies with
// EINVAL on windows
const WINDOWS_ILLEGAL = /["*:<>?|\u0000-\u001f]/;
// reserved with or without an extension
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function unsafeParamReason(raw: string): string | null {
  if (/[\\/]/.test(raw)) return "contains a path separator";
  // a dot segment would climb out of dist/site
  if (raw === "." || raw === "..") return `is the dot segment "${raw}"`;
  const illegal = raw.match(WINDOWS_ILLEGAL);
  if (illegal) {
    const shown = illegal[0] < " " ? `\\u${illegal[0].charCodeAt(0).toString(16).padStart(4, "0")}` : illegal[0];
    return `contains "${shown}", which windows does not allow in a path`;
  }
  if (WINDOWS_RESERVED.test(raw)) return `is "${raw}", a reserved windows device name`;
  // windows strips both silently: the page would 404 on the host that serves it
  if (/[. ]$/.test(raw)) return "ends in a dot or a space, which windows strips from a path";
  return null;
}

// a param that cannot survive the round trip back to a directory name is
// rejected here, where the message can name the route and the param
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

// segments decode on disk (posts/citt%C3%A0 -> posts/città): static servers
// decode the request path before the filesystem, an encoded dir name would 404
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

// BORGO_STATIC compiles the ?__borgo=props path out of the bundle: a static
// host answers that url with the html document and a 200, so res.json() throws
// and every link degrades to a full reload. BORGO_CSP off because a csp is a
// header no static host ships, while its nonce would be frozen into every
// <script>: a permanent public nonce allows exactly what an injected script can
// copy off the page. No csp means no nonce minted at all, react's included.
export function markStaticExport(env: NodeJS.ProcessEnv = process.env) {
  env.BORGO_STATIC = "1";
  env.BORGO_CSP = "0";
}

// per-request values that cannot ship as a file: a <CsrfField /> token with
// no cookie to match is a dead form that looks like a working one. Asked of
// the bytes, never of the route module - the tag may come from a layout or a
// component three packages deep. `<` is escaped in text (react) and in props
// (scriptJson), so only a real tag can match.
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

// closing one listener before asking for the next lets the os hand out the
// same port twice
export async function freePorts(count: number): Promise<number[]> {
  const servers: Array<import("node:net").Server> = [];
  for (let i = 0; i < count; i++) servers.push(await listenFree());
  const ports = servers.map((s) => (s.address() as { port: number }).port);
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  return ports;
}

// the same two predicates as serveAsset: a dotfile borgo start refuses must
// not reach dist/site either, or the 404 masks the exposure
export const isExportedFile = (rel: string): boolean => {
  const url = `/${rel.replaceAll("\\", "/")}`;
  return !isHiddenAsset(url) && !inHiddenDirectory(url);
};

// judged as the prefix it will be: `.git` refused whole, `.well-known` at the
// root goes through
const isExportedDirectory = (rel: string): boolean =>
  rel === "" || !inHiddenDirectory(`/${rel.replaceAll("\\", "/")}/`);

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export function copyPublic(src: string, dest: string): void {
  cpSync(src, dest, {
    recursive: true,
    filter: (path) => {
      const rel = relative(src, path);
      return isDirectory(path) ? isExportedDirectory(rel) : isExportedFile(rel);
    },
  });
}

// a file plus its .gz/.br siblings is one asset; an orphan .gz/.br is its own
export function countAssets(dir: string): { assets: number; precompressed: number } {
  let assets = 0;
  let precompressed = 0;
  const files = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    if (isExportedFile(relative(dir, file))) files.add(file);
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

// windows releases an image only after the process is gone, which lags its
// exit: retried. Never throws - it runs from a finally, where an exception
// would replace the failure the export was already reporting
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
  // a shell API_URL would send loaders to the real api mid-export
  delete process.env.API_URL;
  process.env.BORGO_RELOAD = "1"; // quiet startup lines from the servers

  let apiProc: import("bun").Subprocess | null = null;
  // named before the build: a build that dies partway still leaves the file
  let apiBin: string | null = null;

  let failures = 0;
  // staged beside dist/site and swapped in only once every page rendered: a
  // run that fails on page four must not publish three pages and a valid
  // index.html, a site with a hole nobody can see from outside
  const outDir = "dist/site";
  const stageDir = `dist/.site-staged-${process.pid}`;
  try {
    if (needApi) {
      // dist/ may be running under borgo start, and windows locks executing binaries
      apiBin = `.borgo/export-${goBinName()}`;
      const goBuild = Bun.spawn(["go", "build", "-o", apiBin, "."], { stdout: "inherit", stderr: "inherit" });
      if ((await goBuild.exited) !== 0) {
        console.error(`  ${c.red(g.err)} go build failed`);
        return 1;
      }
      // a mutated process.env does not reliably reach children
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

    const pages: Array<{ path: string; route: Route }> = [];
    for (const { route, dynamic } of plans) {
      if (!dynamic) {
        pages.push({ path: route.pattern, route });
        continue;
      }
      const sets = await route.module.prerenderPaths!({ api, apiUrl });
      for (const params of sets) pages.push({ path: fillPattern(route.pattern, params), route });
    }

    // the real front server renders: an export is byte-identical to ssr
    const { serve } = await import("./server");
    await serve({ dev: false });

    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });

    let written = 0;
    const failed: string[] = [];
    // refused for what they carry, not for failing to render
    const refused: string[] = [];
    // two pages carrying the same residue explain it once
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
    // 404.html is what static hosts serve for unknown paths, by name
    let wrote404 = false;
    if (export404) {
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

    let assets = 0;
    let precompressed = 0;
    if (existsSync("public")) {
      ({ assets, precompressed } = countAssets("public"));
      if (!failures) copyPublic("public", stageDir);
    }

    // only now: what is in dist/site is the last export that rendered whole
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
    // once, and only when a page was refused: per page it would bury itself
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
    // an operator who set a csp has to be told it is not in these files
    console.log(
      `  ${c.dim(`${g.dot} the csp is a response header, so it is not in these files ${g.dot} set it on your static host${hadCsp ? ` (BORGO_CSP was set here and does not ship)` : ""}`)}`,
    );
    // public/assets now holds a bundle with the props endpoint compiled out;
    // `borgo start` reads .borgo/build-mode and rebuilds rather than serve it
    console.log(
      `  ${c.dim(`${g.dot} public/assets now holds the export build ${g.dot} borgo start rebuilds it for production`)}\n`,
    );
  } finally {
    apiProc?.kill();
    await apiProc?.exited;
    // a successful run renamed it away; anything else left a half-rendered tree
    rmSync(stageDir, { recursive: true, force: true });
    // beside the kill, not on the happy path: a failed export must not leave
    // the 21 MB api binary behind either
    if (apiBin) await removeScratchBin(apiBin);
  }
  return failures ? 1 : 0;
}
