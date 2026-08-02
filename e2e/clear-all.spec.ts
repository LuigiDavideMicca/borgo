import { expect, test } from "@playwright/test";
import { csrfHeader } from "./csrf";

// wipes the whole task list, so it runs in its own project after the
// parallel app specs instead of racing them
test("a logged-in user clears all tasks, over the api and from the button", async ({ page }) => {
  const username = `clear${Date.now()}`;
  await page.goto("/register");
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', "pw123456");
  await page.click("form button");
  await expect(page).toHaveURL(/\/account$/);

  await page.goto("/");
  const title = `clear me ${Date.now()}`;
  await page.fill('input[name="title"]', title);
  await page.click("form button");
  await expect(page.locator("li", { hasText: title })).toBeVisible();

  // the header is what the page's own apiFetch attaches; page.request carries
  // the same cookie jar, so it has to attach it too
  const res = await page.request.delete("/api/tasks", { headers: await csrfHeader(page) });
  expect(res.status()).toBe(200);
  const { cleared } = await res.json();
  expect(cleared).toBeGreaterThan(0);

  await page.fill('input[name="title"]', `${title} again`);
  await page.click("form button");
  await expect(page.locator("li", { hasText: "again" })).toBeVisible();
  // the nav greets only once hydrated, so the button click lands on react
  await expect(page.locator("header nav .session")).toContainText(`ciao ${username}`);
  await page.click(".clear-all");
  await expect(page.locator("main ul li")).toHaveCount(0);
});
