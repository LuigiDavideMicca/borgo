import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { extname, join } from "node:path";

const appDir = join(process.cwd(), "examples", "tasks");
const cli = join(process.cwd(), "packages", "borgo", "src", "cli.ts");
const siteDir = join(appDir, "dist", "site");

const staticPage = join(appDir, "pages", "exp-static.tsx");
const dataPage = join(appDir, "pages", "exp-data.tsx");
const dynDir = join(appDir, "pages", "exp-dyn");
const dynPage = join(dynDir, "[id].tsx");

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

let statik: http.Server;
let base: string;
let out: string;

test.beforeAll(async () => {
  test.setTimeout(240_000);

  writeFileSync(
    staticPage,
    [
      "export const hydrate = false;",
      "",
      "export default function ExpStatic() {",
      "  return <main><h1>EXP-STATIC-MARKER</h1></main>;",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    dataPage,
    [
      'import { useEffect } from "react";',
      'import type { LoaderContext } from "borgo-framework";',
      "",
      "export const prerender = true;",
      "",
      "export async function loader({ api }: LoaderContext) {",
      '  const { tasks } = await api("GET /api/tasks");',
      '  return { count: tasks.length, stamp: "EXP-DATA-MARKER" };',
      "}",
      "",
      "export default function ExpData({ count, stamp }: { count: number; stamp: string }) {",
      "  useEffect(() => {",
      '    document.body.dataset.expHydrated = "1";',
      "  }, []);",
      "  return (",
      "    <main>",
      "      <h1>{stamp}</h1>",
      '      <p data-testid="count">{count} tasks at export time</p>',
      "    </main>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );
  mkdirSync(dynDir, { recursive: true });
  writeFileSync(
    dynPage,
    [
      'import type { LoaderContext } from "borgo-framework";',
      "",
      "export const hydrate = false;",
      "export const prerender = true;",
      'export const prerenderPaths = () => [{ id: "1" }, { id: "2" }];',
      "",
      "export async function loader({ params }: LoaderContext) {",
      "  return { id: params.id };",
      "}",
      "",
      "export default function ExpDyn({ id }: { id: string }) {",
      "  return <main><h1>EXP-DYN-{id}</h1></main>;",
      "}",
      "",
    ].join("\n"),
  );

  const result = spawnSync("bun", [cli, "export"], {
    cwd: appDir,
    shell: process.platform === "win32",
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, DB_PATH: "e2e-export.db", NO_COLOR: "1" },
  });
  out = result.stdout;
  expect(result.status).toBe(0);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".json": "application/json",
  };
  statik = http
    .createServer((req, res) => {
      const url = new URL(req.url ?? "/", base);
      let path = join(siteDir, decodeURIComponent(url.pathname));
      if (!existsSync(path) || statSync(path).isDirectory()) path = join(path, "index.html");
      if (!existsSync(path)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
      createReadStream(path).pipe(res);
    })
    .listen(port);
});

test.afterAll(async () => {
  statik?.closeAllConnections();
  await new Promise((resolve) => statik?.close(resolve));
  for (const f of [staticPage, dataPage]) rmSync(f, { force: true });
  rmSync(dynDir, { recursive: true, force: true });
  rmSync(join(appDir, "e2e-export.db"), { force: true });
  // the generated route manifest still imports the pages just deleted, and it
  // is real input to the next build, not a scratch file. Left stale, the
  // example stops typechecking and `borgo start` dies on a module resolution
  // error, in a working tree nobody touched. Regenerating it is what a save
  // under `borgo dev` would have done. Through the CLI, not by importing
  // build.ts: this spec runs on node, and build.ts imports `bun`.
  const regen = spawnSync("bun", [cli, "build"], { cwd: appDir, encoding: "utf8", shell: true });
  if (regen.status !== 0) {
    throw new Error(`could not regenerate the route manifest:\n${regen.stdout}\n${regen.stderr}`);
  }
});

test("export writes the exportable pages and explains the skips", () => {
  expect(out).toContain("/exp-static");
  expect(out).toContain("/exp-data");
  expect(out).toContain("/exp-dyn/1");
  expect(out).toContain("/exp-dyn/2");
  expect(out).toContain("zero js");
  expect(out).toMatch(/\/ +skipped . has a loader without `export const prerender = true`/);
  expect(out).toContain("actions, sse and websocket topics need borgo start");

  expect(existsSync(join(siteDir, "exp-static", "index.html"))).toBe(true);
  expect(existsSync(join(siteDir, "exp-dyn", "2", "index.html"))).toBe(true);
  // an exported page names content-hashed assets, and a static host has
  // nothing to resolve a name with: whatever the html says must be on disk
  const html = readFileSync(join(siteDir, "exp-data", "index.html"), "utf8");
  const urls = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  expect(urls.some((u) => /\/assets\/client-.*\.js$/.test(u))).toBe(true);
  for (const url of urls) {
    expect(existsSync(join(siteDir, url.slice(1))), url).toBe(true);
  }
  // the compressed siblings ride along
  const entry = urls.find((u) => /\/assets\/client-.*\.js$/.test(u))!;
  expect(existsSync(join(siteDir, entry.slice(1) + ".gz"))).toBe(true);
});

test("a _404 page exports as 404.html for static hosts", () => {
  expect(out).toContain("404.html");
  const html = readFileSync(join(siteDir, "404.html"), "utf8");
  expect(html).toContain("Nothing lives at this address");
});

test("the summary lists 404.html apart and counts assets logically", () => {
  const summary = out.match(/exported (\d+) pages \+ 404\.html \+ (\d+) assets \(with (\d+) precompressed variants\)/);
  expect(summary).not.toBeNull();
  // the page count is exactly the per-page lines, 404.html not among them
  const pageLines = out.match(/dist\/site\/(?!404\.html).*index\.html/g) ?? [];
  expect(Number(summary![1])).toBe(pageLines.length);
  // logical assets exclude the .gz/.br siblings, which are reported once
  expect(Number(summary![3])).toBeGreaterThan(0);
});

test("a hydrate=false page exports with zero javascript", async ({ page }) => {
  const html = readFileSync(join(siteDir, "exp-static", "index.html"), "utf8");
  expect(html).toContain("EXP-STATIC-MARKER");
  expect(html).not.toContain("<script");

  await page.goto(`${base}/exp-static`);
  await expect(page.locator("h1")).toHaveText("EXP-STATIC-MARKER");
  expect(await page.locator("script").count()).toBe(0);
});

test("a prerendered loader page hydrates against the exported props", async ({ page }) => {
  await page.goto(`${base}/exp-data`);
  await expect(page.locator("h1")).toHaveText("EXP-DATA-MARKER");
  await expect(page.getByTestId("count")).toHaveText("0 tasks at export time");
  await page.waitForFunction(() => document.body.dataset.expHydrated === "1");
});

test("prerenderPaths expands dynamic routes", async ({ page }) => {
  await page.goto(`${base}/exp-dyn/2`);
  await expect(page.locator("h1")).toHaveText("EXP-DYN-2");
});
