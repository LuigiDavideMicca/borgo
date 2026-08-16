import { expect, test } from "@playwright/test";

test("unknown routes render the custom 404 page with status 404", async ({ page }) => {
  const response = await page.goto("/definitely/not/here");
  expect(response?.status()).toBe(404);
  await expect(page.locator("h1")).toHaveText("404");
  await expect(page.locator("main")).toContainText("Nothing lives at this address");
  // the custom page goes through the layout chain
  await expect(page.locator("header .brand")).toBeVisible();
});

test("api 404s pass through the proxy untouched", async ({ request }) => {
  const res = await request.get("/api/tasks/999999");
  expect(res.status()).toBe(404);
});
