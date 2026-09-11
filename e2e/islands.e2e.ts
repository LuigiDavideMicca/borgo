import { expect, test } from "@playwright/test";

test("islands hydrate independently on a hydrate=false page", async ({ page }) => {
  await page.goto("/islands");

  // both entries are named after their content, so the assertion is on which
  // entry the page loads, not on a spelling
  const scripts = await page.$$eval("script[src]", (els) => els.map((e) => e.getAttribute("src")));
  expect(scripts.filter((s) => /^\/assets\/client-.*\.js$/.test(s ?? ""))).toEqual([]);
  expect(scripts.filter((s) => /^\/assets\/islands-client-.*\.js$/.test(s ?? ""))).toHaveLength(1);

  // the page itself never hydrates: no props script
  expect(await page.evaluate(() => "__PROPS__" in window)).toBe(false);

  // eager island is interactive
  const counters = page.locator("[data-testid=count]");
  await page.locator("button", { hasText: "+1" }).first().click();
  await expect(counters.first()).toHaveText("6");

  // visible island hydrates only when scrolled into view
  await expect(counters.nth(1)).toHaveText("0");
  await page.locator("[data-borgo-client=visible]").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.locator("button", { hasText: "+1" }).nth(1).click();
  await expect(counters.nth(1)).toHaveText("1");
});

// hunting round 2: an island name the manifest does not know (a stale
// deploy mid-session serves markup for an island the fresh client bundle
// lost) must cost that island alone - static markup stays, the rest of the
// page hydrates, and nothing throws
test("an unknown island marker is skipped without taking the page down", async ({ page }) => {
  await page.addInitScript(() => {
    const plant = () => {
      const root = document.getElementById("root");
      if (!root) return requestAnimationFrame(plant);
      const ghost = document.createElement("div");
      ghost.setAttribute("data-borgo-island", "GhostFromOldDeploy");
      ghost.textContent = "stale markup";
      root.appendChild(ghost);
    };
    requestAnimationFrame(plant);
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/islands");
  // the REAL island still hydrates beside the ghost
  await page.click("[data-borgo-island] button");
  await expect(page.locator("[data-borgo-island] button").first()).toContainText("1");
  await expect(page.locator('[data-borgo-island="GhostFromOldDeploy"]')).toHaveText("stale markup");
  expect(errors).toEqual([]);
});
