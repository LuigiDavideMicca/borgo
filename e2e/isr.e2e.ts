import { expect, test } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// these tests run in their own serial project: every other spec that touches
// tasks fires RevalidateTag("news") from the go api, and a parallel worker
// dropping the cache between two asserted hits is a flake, not a finding

type Res = { status: () => number; headers: () => Record<string, string>; text: () => Promise<string> };

// native fetch responses expose properties, playwright's expose methods; the
// restart test uses fetch (its server is not the configured baseURL), so it
// adapts to the shape everything here reads
const asRes = (r: Response): Res => ({
  status: () => r.status,
  headers: () => Object.fromEntries([...r.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])),
  text: () => r.text(),
});

const stampOf = (html: string) => {
  const m = /<time data-testid="rendered-at">([^<]+)<\/time>/.exec(html);
  expect(m, "the news page carries no render stamp").not.toBeNull();
  return m![1];
};

const snap = async (res: Res) => {
  expect(res.status()).toBe(200);
  return { state: res.headers()["x-borgo-cache"], stamp: stampOf(await res.text()) };
};

// the cache may be warm, cold or stale from a previous run (persistence plus
// reuseExistingServer), so tests start from a proven steady state: two
// consecutive hits with the same stamp
async function settleHit(get: () => Promise<Res>) {
  const deadline = Date.now() + 20_000;
  let last = await snap(await get());
  for (;;) {
    const next = await snap(await get());
    if (last.state === "hit" && next.state === "hit" && last.stamp === next.stamp) return next;
    if (Date.now() > deadline) throw new Error(`/news never settled on a hit (last: ${next.state})`);
    last = next;
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("a cached page replays the same render until the go api drops the tag", async ({ request }) => {
  const settled = await snap(await request.get("/news"));
  expect(["miss", "hit", "stale"]).toContain(settled.state);
  const cached = await settleHit(() => request.get("/news"));

  const created = await request.post("/api/tasks", {
    data: { title: `isr probe ${Date.now()}`, body: "" },
  });
  expect(created.status()).toBe(201);
  const { task } = await created.json();

  // RevalidateTag rides the push channel, so the drop is asynchronous: poll
  // until the stamp moves instead of asserting the very next response
  const deadline = Date.now() + 15_000;
  let fresh = await snap(await request.get("/news"));
  while (fresh.stamp === cached.stamp) {
    if (Date.now() > deadline) throw new Error("RevalidateTag never reached the front server");
    await new Promise((r) => setTimeout(r, 250));
    fresh = await snap(await request.get("/news"));
  }
  expect(fresh.stamp).not.toBe(cached.stamp);

  await request.delete(`/api/tasks/${task.ID}`);
});

// production pages carry a csp nonce; a cached copy must re-mint it per
// replay, never freeze one for everyone - the render stamp proves the copy
// is shared while the nonce proves the security header is not
test("two replays of one cached copy carry two different csp nonces", async ({ request }) => {
  await settleHit(() => request.get("/news"));
  const nonceOf = (h: Record<string, string>) =>
    /'nonce-([^']+)'/.exec(h["content-security-policy"] ?? "")?.[1];
  const first = await request.get("/news");
  const second = await request.get("/news");
  const a = nonceOf(first.headers());
  const b = nonceOf(second.headers());
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();
  expect(a).not.toBe(b);
  // the body agrees with its own header, or the scripts would not run
  expect(await first.text()).toContain(`nonce="${a}"`);
});

// the copy is shared by construction - rendered as nobody - so a logged-in
// visitor gets the same bytes as everyone, and nothing personal comes back
test("a request carrying cookies gets the shared copy, nothing personal attached", async ({ request }) => {
  const cached = await settleHit(() => request.get("/news"));
  const res = await request.get("/news", { headers: { cookie: "session=whoever" } });
  expect(res.status()).toBe(200);
  expect(res.headers()["x-borgo-cache"]).toBe("hit");
  expect(stampOf(await res.text())).toBe(cached.stamp);
  expect(res.headers()["set-cookie"]).toBeUndefined();
});

test("pages without a revalidate export are untouched", async ({ request }) => {
  const res = await request.get("/about");
  expect(res.status()).toBe(200);
  expect(res.headers()["x-borgo-cache"]).toBeUndefined();
});

// a restart with the same build must come back warm: same stamp, no re-render.
// this needs its own instance - killing the shared webServer is not an option -
// with its own cache dir, or it would trade pages with the :3400 server
test("a restarted server serves the persisted copy of the page", async ({}, testInfo) => {
  testInfo.setTimeout(240_000);
  const appDir = join(process.cwd(), "examples", "tasks");
  const base = "http://localhost:3420";
  const cacheDir = mkdtempSync(join(tmpdir(), "borgo-isr-"));
  const env = {
    ...process.env,
    PORT: "3420",
    API_PORT: "3921",
    DB_PATH: "e2e-isr.db",
    BORGO_CACHE_DIR: cacheDir,
  };

  const boot = async (): Promise<ChildProcess> => {
    const child = spawn("bun", ["run", "start"], {
      cwd: appDir,
      shell: process.platform === "win32",
      stdio: "ignore",
      env,
    });
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        const res = await fetch(base + "/news", { signal: AbortSignal.timeout(1_000) });
        if (res.ok) return child;
      } catch {}
      if (Date.now() > deadline) throw new Error("isr prod server never became ready");
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  const down = async (child: ChildProcess) => {
    if (child.pid) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill("SIGINT");
    }
    // the port must actually free up before the second boot claims it
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await fetch(base + "/news", { signal: AbortSignal.timeout(1_000) });
      } catch {
        return;
      }
      if (Date.now() > deadline) throw new Error("port 3420 never freed after the kill");
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  let server = await boot();
  try {
    const cached = await settleHit(async () => asRes(await fetch(base + "/news")));

    // saving is fire-and-forget behind the response: wait for the meta file
    // to land before pulling the plug
    const saved = Date.now() + 10_000;
    while (!readdirSync(cacheDir).some((f) => f.endsWith(".json"))) {
      if (Date.now() > saved) throw new Error("the cached page never reached the disk");
      await new Promise((r) => setTimeout(r, 250));
    }

    await down(server);
    server = await boot();

    const after = await snap(asRes(await fetch(base + "/news")));
    // a slow runner can cross the revalidate window between the two boots, in
    // which case the copy is served stale - either way it is the same render,
    // which is what proves the disk round-trip
    expect(["hit", "stale"]).toContain(after.state);
    expect(after.stamp).toBe(cached.stamp);
  } finally {
    await down(server);
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(join(appDir, "e2e-isr.db"), { force: true });
  }
});
