import { expect, test, type APIRequestContext } from "@playwright/test";

async function seedTasks(request: APIRequestContext, prefix: string, count: number) {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const res = await request.post("/api/tasks", { data: { title: `${prefix} ${i}` } });
    ids.push((await res.json()).task.ID);
  }
  return ids;
}

async function deleteTasks(request: APIRequestContext, ids: number[]) {
  for (const id of ids) await request.delete(`/api/tasks/${id}`);
}

test("viewport links prefetch their route chunk without interaction", async ({ page }) => {
  const chunk = page.waitForRequest(/\/assets\/(slow|hydration)-\w+\.js/, { timeout: 10_000 });
  await page.goto("/");
  await chunk;
});

test("hover prefetches props once and the click consumes them", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(300);

  const propsRequests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/slow?__borgo=props")) propsRequests.push(r.url());
  });

  await page.hover('nav a[href="/slow"]');
  await expect.poll(() => propsRequests.length, { timeout: 5000 }).toBe(1);

  await page.evaluate(() => ((window as any).__stayed = true));
  await page.click('nav a[href="/slow"]');
  await expect(page.locator("h1")).toHaveText("Streaming SSR");
  expect(new URL(page.url()).pathname).toBe("/slow");
  expect(propsRequests.length).toBe(1); // cached props were reused
  expect(await page.evaluate(() => (window as any).__stayed)).toBe(true); // no reload
});

test("scroll position restores on back and forward", async ({ page, request }) => {
  const ids = await seedTasks(request, "nav seed", 25);
  try {
    await page.goto("/");
    // the home page live-updates its task list over sse, so other workers can
    // shrink it mid-test; if the page is short at the moment of the restore,
    // the browser clamps scrollTo(300) and the exact match fails. pin the
    // height so it cannot depend on the shared database - the style tag
    // survives client-side navigations (same document). And no scroll
    // anchoring: other workers insert and delete tasks above the viewport the
    // whole time, and chrome then moves scrollY to keep the content still - a
    // browser feature this test is not about, which moved a correctly restored
    // 357 to 300 while the assertion waited
    await page.addStyleTag({ content: "main { min-height: 3000px; } html { overflow-anchor: none; }" });
    await page.evaluate(() => scrollTo(0, 300));
    await page.waitForTimeout(300);

    const visibleHref = await page.evaluate(() => {
      const links = [...document.querySelectorAll('ul a[href^="/tasks/"]')];
      const hit = links.find((a) => {
        const r = a.getBoundingClientRect();
        return r.top > 0 && r.bottom < innerHeight;
      });
      return hit?.getAttribute("href");
    });
    expect(visibleHref).toBeTruthy();

    // under cpu saturation the scroll writes land late and a history move can
    // briefly destroy the execution context, so poll every position
    const scrollY = () => page.evaluate(() => window.scrollY).catch(() => NaN);

    // read from outside the page, before the click: if anything in the page
    // moved the position on its way out, the restore brings back that value
    // and this still fails, which is the point
    const before = await scrollY();
    expect(before).toBeGreaterThan(0);
    // a dispatched click, no pointer: a pointer click lets the test runner
    // scroll the page for actionability first, and once the position was
    // already 0 before the click (seen once in an instrumented run, never
    // reproduced) - the runtime then saved 0 and restored 0 correctly
    await page.locator(`ul a[href="${visibleHref}"]`).dispatchEvent("click");
    await expect(page.locator("a", { hasText: "Back home" })).toBeVisible();
    await expect.poll(scrollY, { timeout: 15_000 }).toBe(0);

    await page.goBack();
    await expect.poll(scrollY, { timeout: 15_000 }).toBe(before);

    await page.goForward();
    await expect.poll(scrollY, { timeout: 15_000 }).toBeLessThan(5);
  } finally {
    await deleteTasks(request, ids);
  }
});

// going back renders the destination only when its props arrive, and until
// then the page being left is still on screen and still scrollable. A scroll
// of that page in the meantime must be saved as its own position: saved under
// the destination's key, it is what the restore reads back
test("a scroll while going back does not overwrite the position the page returns to", async ({ page, request }) => {
  const ids = await seedTasks(request, "back race seed", 25);
  try {
    await page.goto("/");
    await page.addStyleTag({ content: "main { min-height: 3000px; } html { overflow-anchor: none; }" });
    await page.evaluate(() => scrollTo(0, 300));
    // the debounced save lands
    await page.waitForTimeout(300);
    const href = await page.evaluate(() => {
      const links = [...document.querySelectorAll('ul a[href^="/tasks/"]')];
      const hit = links.find((a) => {
        const r = a.getBoundingClientRect();
        return r.top > 0 && r.bottom < innerHeight;
      });
      return hit?.getAttribute("href");
    });
    expect(href).toBeTruthy();
    const scrollY = () => page.evaluate(() => window.scrollY).catch(() => NaN);

    // a dispatched click: no pointer, so nothing scrolls the page before it
    await page.locator(`ul a[href="${href}"]`).dispatchEvent("click");
    await expect(page.locator("a", { hasText: "Back home" })).toBeVisible();
    await expect.poll(scrollY, { timeout: 15_000 }).toBe(0);

    // hold the props of the page going back to
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/\?__borgo=props/, async (route) => {
      await held;
      await route.continue();
    });
    await page.evaluate(() => history.back());
    await page.waitForURL((url) => url.pathname === "/");
    // the detail page, still on screen, scrolls and its debounced save fires
    await page.evaluate(() => scrollTo(0, 800));
    await page.waitForTimeout(400);
    release();

    await expect(page.locator("h1")).toHaveText("Tasks");
    await expect.poll(scrollY, { timeout: 15_000 }).toBe(300);
  } finally {
    await page.unroute(/\/\?__borgo=props/);
    await deleteTasks(request, ids);
  }
});

test("a second navigation wins over a slower first one", async ({ page }) => {
  // must start on a hydrated page: hydrate=false pages have no client nav
  await page.goto("/");
  await page.waitForTimeout(300);
  // hold the first navigation's props fetch so the second finishes first
  await page.route(/\/slow\?.*__borgo=props/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });

  await page.click('nav a[href="/slow"]');
  await page.click('nav a[href="/"]');
  await expect(page.locator("h1")).toHaveText("Tasks");

  // the delayed response lands now: it must not render /slow over home
  await page.waitForTimeout(1200);
  await expect(page.locator("h1")).toHaveText("Tasks");
  expect(new URL(page.url()).pathname).toBe("/");
});

test("head updates on client navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Tasks · borgo");
  await page.click('nav a[href="/slow"]');
  await expect(page).toHaveTitle("Streaming · borgo tasks");
});

// hunting round 2: third-party code clobbering history.state (dropping the
// __borgo scroll key) must degrade to a top-scroll, never a crash or a page
// rendered for the wrong url
test("a clobbered history.state degrades to top-scroll, not a crash", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.click('a[href="/about"]');
  await expect(page.locator("h1")).toHaveText("About");
  // an analytics script replacing state wholesale, key gone
  await page.evaluate(() => history.replaceState({ theirOwn: true }, ""));
  await page.goBack();
  // the right page renders for the url, whatever the state carried
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("h1")).not.toHaveText("About");
  expect(errors).toEqual([]);
});
