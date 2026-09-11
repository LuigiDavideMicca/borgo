import { expect, test } from "@playwright/test";

test("hydrate=false pages ship zero javascript", async ({ page }) => {
  await page.goto("/about");
  expect(await page.$$eval("script", (els) => els.length)).toBe(0);
  await expect(page.locator("h1")).toHaveText("About");
});

test("hydrate=visible defers the page chunk until the marker scrolls in", async ({ page }) => {
  const chunkRequests: string[] = [];
  page.on("request", (r) => {
    if (/\/assets\/hydration-\w+\.js/.test(r.url())) chunkRequests.push(r.url());
  });

  await page.goto("/hydration");
  await page.waitForTimeout(500);
  expect(chunkRequests.length).toBe(0);

  await page.locator("[data-borgo-visible]").scrollIntoViewIfNeeded();
  await expect.poll(() => chunkRequests.length, { timeout: 5000 }).toBe(1);

  await page.click("section button");
  await expect(page.locator("section button")).toContainText("clicked 1 time");
});

// hunting round 2: the marker that never becomes visible must degrade to a
// working no-js page - links navigate the classic way, nothing hangs, no
// retry loop. the observer just keeps waiting, which is the safe direction
test("a visible-marker that never scrolls in leaves a working no-js page", async ({ page }) => {
  await page.addInitScript(() => {
    const hide = () => {
      const el = document.querySelector("[data-borgo-visible]") as HTMLElement | null;
      if (el) el.style.display = "none";
      else requestAnimationFrame(hide);
    };
    requestAnimationFrame(hide);
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/hydration");
  await page.waitForTimeout(800);
  // never hydrated: a link click is a full navigation, not an spa swap
  await Promise.all([page.waitForEvent("load"), page.click('a[href="/about"]')]);
  await expect(page.locator("h1")).toHaveText("About");
  expect(errors).toEqual([]);
});
