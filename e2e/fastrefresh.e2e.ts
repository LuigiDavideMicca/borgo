import { expect, test } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const appDir = join(process.cwd(), "examples", "tasks");
const pageFile = join(appDir, "pages", "hydration.tsx");
const cssFile = join(appDir, "style.scss");
const layoutFile = join(appDir, "pages", "_layout.tsx");
const refreshFile = join(appDir, "pages", "refresh.tsx");
const hookFile = join(appDir, "lib", "use-counter.ts");
const pingFile = join(appDir, "api", "ping.go");
const base = "http://localhost:3410";

let server: ChildProcess;
const originals = new Map<string, string>();

function snapshot(path: string) {
  originals.set(path, readFileSync(path, "utf8"));
}

function restoreAll() {
  for (const [path, content] of originals) writeFileSync(path, content);
}

// restore a file and wait until the dev server serves the restored content
async function settle(path: string, contains: string) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const res = await fetch(base + path);
      if (res.ok && (await res.text()).includes(contains)) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`dev server did not settle on ${path}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// restore files, sit out the debounced server restart the writes trigger,
// then wait for the server to come back; settling on content alone can pass
// before the restart even begins
async function resetPlayground(...files: string[]) {
  for (const f of files) writeFileSync(f, originals.get(f)!);
  await new Promise((r) => setTimeout(r, 3_000));
  await settle("/refresh", "MARKER-0");
}

// the refresh page sets window.__hydrated from an effect; interacting before
// hydration loses clicks and lets hydration reset the input
async function openRefreshPage(page: import("@playwright/test").Page) {
  await page.goto(base + "/refresh");
  try {
    await page.waitForFunction(() => (window as any).__hydrated, undefined, { timeout: 15_000 });
  } catch {
    await page.reload();
    await page.waitForFunction(() => (window as any).__hydrated, undefined, { timeout: 30_000 });
  }
  // never edit before the dev channel is open: an update sent while the
  // socket is still connecting is silently lost on slow runners
  await page.waitForFunction(() => (window as any).__borgoDevConnected, undefined, { timeout: 30_000 });
  await page.evaluate(() => ((window as any).__stayed = true));
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  for (const f of [pageFile, cssFile, layoutFile, refreshFile, hookFile, pingFile]) snapshot(f);
  // a dev server from a previous worker still winding down would answer the
  // readiness probe below and poison every test against a stale process
  const freeDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fetch(base + "/", { signal: AbortSignal.timeout(1_000) });
    } catch {
      break;
    }
    if (Date.now() > freeDeadline) throw new Error("port 3410 is still held by a previous dev server");
    await new Promise((r) => setTimeout(r, 250));
  }
  const { openSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const logFd = openSync(joinPath(tmpdir(), "borgo-devserver-e2e.log"), "a");
  server = spawn("bun", ["run", "dev"], {
    cwd: appDir,
    shell: process.platform === "win32",
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, PORT: "3410", API_PORT: "3911", DB_PATH: "e2e-dev.db" },
  });
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await fetch(base + "/hydration");
      if (res.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("dev server never became ready");
    await new Promise((r) => setTimeout(r, 500));
  }
});

// kill first, restore after: restoring while the watcher is alive respawns
// the front server mid-teardown, and the kill's process-tree snapshot misses
// it — the orphan keeps the port and poisons the next worker
test.afterAll(async () => {
  if (server?.pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"]);
    } else {
      server.kill("SIGINT");
    }
    if (server.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 15_000);
        server.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  restoreAll();
});

test("component edits fast-refresh and keep state", async ({ page }) => {
  await page.goto(base + "/hydration");
  await page.evaluate(() => ((window as any).__stayed = true));

  await page.locator("[data-borgo-visible]").scrollIntoViewIfNeeded();
  // clicks before deferred hydration lands are silently lost
  await page.waitForFunction(() => (window as any).__hydrated, undefined, { timeout: 30_000 });
  for (let i = 0; i < 3; i++) await page.click("section button");
  await expect(page.locator("section button")).toContainText("clicked 3 times");

  writeFileSync(
    pageFile,
    originals.get(pageFile)!.replace("<h2>Now hydrated</h2>", "<h2>Now hydrated — EDITED</h2>"),
  );

  await expect(page.locator("section h2")).toHaveText("Now hydrated — EDITED", { timeout: 15_000 });
  await expect(page.locator("section button")).toContainText("clicked 3 times");
  expect(await page.evaluate(() => (window as any).__stayed)).toBe(true);
});

test("css edits hot-swap without a reload", async ({ page }) => {
  await page.goto(base + "/hydration");
  await page.evaluate(() => ((window as any).__stayed = true));

  writeFileSync(cssFile, originals.get(cssFile)! + "\nh1 { letter-spacing: 3px; }\n");
  await expect
    .poll(
      () => page.evaluate(() => getComputedStyle(document.querySelector("h1")!).letterSpacing),
      { timeout: 15_000 },
    )
    .toBe("3px");
  expect(await page.evaluate(() => (window as any).__stayed)).toBe(true);
  writeFileSync(cssFile, originals.get(cssFile)!);
});

test("five consecutive component edits each hot-apply without a reload", async ({ page }) => {
  test.setTimeout(180_000);
  await resetPlayground(refreshFile);
  await openRefreshPage(page);
  await page.fill("input", "preserved");

  for (let i = 1; i <= 5; i++) {
    writeFileSync(refreshFile, readFileSync(refreshFile, "utf8").replace(/MARKER-\d+/, `MARKER-${i}`));
    await expect(page.locator("[data-marker]")).toHaveText(`MARKER-${i}`, { timeout: 30_000 });
  }
  expect(await page.evaluate(() => (window as any).__stayed)).toBe(true);
  await expect(page.locator("input")).toHaveValue("preserved");
});

test("adding and removing a hook remounts the component, no reload, no overlay", async ({ page }) => {
  test.setTimeout(180_000);
  const original = originals.get(refreshFile)!;
  await resetPlayground(refreshFile);
  await openRefreshPage(page);
  await page.fill("input", "will-reset");

  writeFileSync(
    refreshFile,
    original
      .replace(
        'const [text, setText] = useState("");',
        'const [text, setText] = useState("");\n  const [extra] = useState("EXTRA-STATE");',
      )
      .replace(
        "<h1>Fast refresh playground</h1>",
        "<h1>Fast refresh playground</h1>\n      <p data-extra>{extra}</p>",
      ),
  );
  await expect(page.locator("[data-extra]")).toHaveText("EXTRA-STATE", { timeout: 30_000 });
  expect(await page.evaluate(() => (window as any).__stayed)).toBe(true);
  await expect(page.locator("input")).toHaveValue("");
  await expect(page.locator("#borgo-overlay")).toHaveCount(0);
  await page.click("button");
  await expect(page.locator("button")).toContainText("count 1");

  writeFileSync(refreshFile, original);
  await expect(page.locator("[data-extra]")).toHaveCount(0, { timeout: 30_000 });
  expect(await page.evaluate(() => (window as any).__stayed)).toBe(true);
  await expect(page.locator("#borgo-overlay")).toHaveCount(0);
  await page.click("button");
  await expect(page.locator("button")).toContainText("count 1");
});

test("custom hook body edit hot-applies and keeps dependent state", async ({ page }) => {
  test.setTimeout(180_000);
  await resetPlayground(refreshFile, hookFile);
  await openRefreshPage(page);
  await page.click("button");
  await page.click("button");
  await expect(page.locator("button")).toContainText("count 2");

  writeFileSync(hookFile, originals.get(hookFile)!.replace("setCount((c) => c + 1)", "setCount((c) => c + 10)"));
  // the edit hot-applies with state intact: a click starts jumping by ten
  let prev = 2;
  let current = 2;
  await expect
    .poll(
      async () => {
        await page.click("button");
        const text = await page.locator("button").textContent();
        current = Number(text?.match(/count (\d+)/)?.[1] ?? Number.NaN);
        const delta = current - prev;
        prev = current;
        return delta;
      },
      { timeout: 30_000 },
    )
    .toBe(10);
  // preserved state: 2 + the plain clicks + at least one ten-step; a remount
  // would have restarted from zero and landed exactly on ten
  expect(current).toBeGreaterThanOrEqual(12);
  expect(await page.evaluate(() => (window as any).__stayed)).toBe(true);
});

test("hook edits inside a custom hook remount dependents cleanly", async ({ page }) => {
  test.setTimeout(180_000);
  await resetPlayground(refreshFile, hookFile);
  await openRefreshPage(page);
  await page.click("button");
  await page.click("button");
  await expect(page.locator("button")).toContainText("count 2");

  writeFileSync(
    hookFile,
    originals.get(hookFile)!.replace(
      "const [count, setCount] = useState(0);",
      "const [count, setCount] = useState(0);\n  const [flag] = useState(false);\n  void flag;",
    ),
  );
  await expect(page.locator("button")).toContainText("count 0", { timeout: 30_000 });
  expect(await page.evaluate(() => (window as any).__stayed)).toBe(true);
  await expect(page.locator("#borgo-overlay")).toHaveCount(0);
  await page.click("button");
  await expect(page.locator("button")).toContainText("count 1");
});

test("go edits reload exactly once each, only after the api answers", async ({ page }) => {
  test.setTimeout(180_000);
  writeFileSync(pingFile, originals.get(pingFile)!);
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const res = await fetch(base + "/api/ping");
      if (res.ok && (await res.json()).pong === "v1") break;
    } catch {}
    if (Date.now() > deadline) throw new Error("api did not settle on v1");
    await new Promise((r) => setTimeout(r, 500));
  }

  await page.addInitScript(() => {
    sessionStorage.setItem("loads", String(Number(sessionStorage.getItem("loads") || 0) + 1));
  });
  await page.goto(base + "/refresh");
  // the reload under test can destroy the execution context mid-evaluate
  const loads = () => page.evaluate(() => Number(sessionStorage.getItem("loads"))).catch(() => -1);
  const ping = () => page.evaluate(async () => (await (await fetch("/api/ping")).json()).pong);
  expect(await ping()).toBe("v1");

  for (const v of ["v2", "v3"]) {
    const before = await loads();
    writeFileSync(pingFile, readFileSync(pingFile, "utf8").replace(/Pong: "v\d"/, `Pong: "${v}"`));
    await expect.poll(loads, { timeout: 90_000 }).toBe(before + 1);
    expect(await ping()).toBe(v);
    await page.waitForTimeout(2_000);
    expect(await loads()).toBe(before + 1);
  }
});

test("a go syntax error mid-edit keeps the previous api serving, a fix recovers", async () => {
  test.setTimeout(180_000);
  writeFileSync(pingFile, originals.get(pingFile)!);
  const pong = async () => {
    try {
      const res = await fetch(base + "/api/ping");
      return res.ok ? (await res.json()).pong : null;
    } catch {
      return null;
    }
  };
  await expect.poll(pong, { timeout: 90_000 }).toBe("v1");

  // a half-typed file must not take the api down
  writeFileSync(pingFile, originals.get(pingFile)! + "\nfunc broken( {\n");
  await new Promise((r) => setTimeout(r, 8_000));
  expect(await pong()).toBe("v1");

  writeFileSync(pingFile, originals.get(pingFile)!.replace('Pong: "v1"', 'Pong: "v9"'));
  await expect.poll(pong, { timeout: 90_000 }).toBe("v9");
  writeFileSync(pingFile, originals.get(pingFile)!);
  await expect.poll(pong, { timeout: 90_000 }).toBe("v1");
});

test("layout edits fall back to a full reload", async ({ page }) => {
  await page.goto(base + "/");
  await page.waitForFunction(() => (window as any).__borgoDevConnected, undefined, { timeout: 30_000 });
  await page.evaluate(() => ((window as any).__stayed = true));

  writeFileSync(
    layoutFile,
    originals.get(layoutFile)!.replace(
      "demo app for the borgo framework",
      "demo app for the borgo framework — edited",
    ),
  );

  await expect(page.locator("footer")).toContainText("framework — edited", { timeout: 20_000 });
  // the reload that carried the new footer may still be settling (or a
  // deduped second reload lands late); evaluating mid-navigation destroys
  // the execution context, so poll instead of asserting once
  await expect
    .poll(
      () => page.evaluate(() => (window as any).__stayed).catch(() => "navigating"),
      { timeout: 15_000 },
    )
    .toBeUndefined();
  writeFileSync(layoutFile, originals.get(layoutFile)!);
});
