import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchRoute, type PageModule, type Route } from "../src/router";
import { runAction, type ActionOptions, type RouteMatch } from "../src/util";
import { buildDefine } from "../src/build";

// THE HALF action-413-dom.test.ts SAID IT COULD NOT SEE.
//
// happy-dom runs the runtime's code, not a browser's: whether Chrome paints the
// overlay, and whether the form really keeps its text with no document load in
// between, is only known by asking Chrome. This file does. The runtime is
// bundled the way borgo bundles it, served over real http with the real 413,
// and Chromium is driven through playwright.
//
// Driven from node, not from here: playwright talks to the browser over stdio
// fds 3 and 4, which bun does not open on windows - `chromium.launch()` under
// bun never connects and never fails, it waits. Whether a browser can launch at
// all is measured once below, at load, and decides the skip; nothing about the
// machine is assumed.

const CAP = 64;
const ROOT = join(import.meta.dir, "..", "..", "..");
const ENTRY = join(import.meta.dir, "fixtures", "action-413-browser-entry.ts");

const route = (pattern: string, module: Partial<PageModule>): Route => ({
  pattern,
  file: pattern.slice(1) + ".tsx",
  module: { default: () => null, ...module } as PageModule,
  layouts: [],
});

const actionOptions = (maxBody: number): ActionOptions => ({
  dev: false,
  apiUrl: "http://api.test/api",
  serverError: null,
  csrfRejects: async () => false,
  maxBody,
  apiFor: () => ({}) as never,
  runLoader: async () => ({ loaded: true }),
  renderPage: async () => new Response("doc", { headers: { "Content-Type": "text/html" } }),
  sendJson: (_req, value, init) => Response.json(value, init),
  renderOverlay: () => "overlay",
  onError: () => {},
});

const serverRoutes = [route("/form", { action: async () => ({ saved: true }) })];

const page = `<!doctype html><html><body><div id="root"></div>
<form method="post" action="/form"><input name="title" value=""><button type="submit">save</button></form>
<script type="module" src="/client.js"></script></body></html>`;

// what the driver does in the browser and reports back, as one json line
const driver = `
import { chromium } from "@playwright/test";
const [mode, url] = process.argv.slice(2);
const out = (v) => { process.stdout.write(JSON.stringify(v) + "\\n"); };
let browser;
try {
  browser = await chromium.launch({ headless: true, timeout: 20000 });
  if (mode === "probe") { out({ ok: true, version: browser.version() }); await browser.close(); process.exit(0); }
  const page = await browser.newPage();
  let loads = 0;
  page.on("load", () => { loads++; });
  await page.goto(url);
  await page.waitForFunction(() => window.__hydrated === true);
  const loadsBeforeSubmit = loads;
  const typed = "the report I spent an hour on " + "y".repeat(${CAP * 4});
  await page.fill('input[name="title"]', typed);
  await page.click('button[type="submit"]');
  const overlay = page.locator("#borgo-overlay");
  await overlay.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(300);
  out({
    ok: true,
    overlayVisible: await overlay.isVisible(),
    overlayText: await overlay.innerText(),
    url: page.url(),
    loadsDuringSubmit: loads - loadsBeforeSubmit,
    inputValue: await page.inputValue('input[name="title"]'),
    typed,
  });
  await browser.close();
} catch (e) {
  out({ ok: false, error: String(e).split("\\n")[0] });
  await browser?.close();
  process.exit(1);
}
`;

const dir = mkdtempSync(join(tmpdir(), "borgo-413-browser-"));
const driverPath = join(ROOT, ".action-413-driver.mjs");

const drive = async (mode: string, url = "") => {
  writeFileSync(driverPath, driver);
  const proc = Bun.spawn(["node", driverPath, mode, url], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 45000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  await proc.exited;
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `driver said nothing usable: ${stdout}${stderr}`.slice(0, 500) };
  }
};

const probe = await drive("probe").catch((e) => ({ ok: false, error: String(e) }));
const chromiumAvailable = probe.ok === true;
if (!chromiumAvailable) console.warn(`chromium unavailable, browser test skipped: ${probe.error}`);

let front: ReturnType<typeof Bun.serve>;
let client = "";

beforeAll(async () => {
  if (!chromiumAvailable) return;
  const built = await Bun.build({
    entrypoints: [ENTRY],
    target: "browser",
    define: buildDefine(false),
    throw: false,
  });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  client = await built.outputs[0]!.text();

  front = Bun.serve({
    port: 0,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    development: false,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/client.js") return new Response(client, { headers: { "Content-Type": "text/javascript" } });
      if (req.method === "GET" && url.pathname === "/form") return new Response(page, { headers: { "Content-Type": "text/html" } });
      const target: RouteMatch | null = matchRoute(url.pathname, serverRoutes);
      const answered = await runAction(req, target, actionOptions(CAP));
      return answered ?? new Response("no action", { status: 405 });
    },
  });
});

afterAll(() => {
  front?.stop(true);
  rmSync(dir, { recursive: true, force: true });
  rmSync(driverPath, { force: true });
});

describe("what Chrome shows for an oversized enhanced submit", () => {
  test.skipIf(!chromiumAvailable)("the overlay is painted, the page never navigates, the text is still there", async () => {
    const url = `http://127.0.0.1:${front.port}/form`;
    const seen = await drive("run", url);
    expect(seen.error).toBeUndefined();
    expect(seen.overlayVisible).toBe(true);
    expect(String(seen.overlayText)).toContain("submission too large");
    expect(String(seen.overlayText)).toContain(`BORGO_MAX_BODY=${CAP}`);
    expect(seen.url).toBe(url);
    expect(seen.loadsDuringSubmit).toBe(0);
    expect(seen.inputValue).toBe(seen.typed);
  });
});
