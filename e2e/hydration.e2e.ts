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
