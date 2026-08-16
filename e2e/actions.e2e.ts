import { expect, test } from "@playwright/test";

test("form action creates a task and post/redirect/gets home", async ({ page, request }) => {
  const title = `action test ${Date.now()}`;
  await page.goto("/");
  await page.fill('input[name="title"]', title);
  await page.click("form button");

  await expect(page.locator("li", { hasText: title })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");

  const { tasks } = await (await request.get("/api/tasks")).json();
  const created = tasks.find((t: { title: string }) => t.title === title);
  expect(created).toBeTruthy();
  await request.delete(`/api/tasks/${created.ID}`);
});

test("action validation errors re-render with actionData", async ({ page }) => {
  await page.goto("/");
  await page.fill('input[name="title"]', "");
  await page.click("form button");
  await expect(page.locator(".error")).toHaveText("give the task a title");
  expect(new URL(page.url()).pathname).toBe("/");
});

test("enhanced submit re-renders in place, no full page load", async ({ page, request }) => {
  const title = `enhanced ${Date.now()}`;
  await page.goto("/");
  await page.evaluate(() => {
    (window as unknown as { __stayed?: boolean }).__stayed = true;
  });
  await page.fill('input[name="title"]', title);
  await page.click("form button");

  await expect(page.locator("li", { hasText: title })).toBeVisible();
  // a native submit would have torn the page down and lost the marker
  expect(await page.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed)).toBe(
    true,
  );

  const { tasks } = await (await request.get("/api/tasks")).json();
  const created = tasks.find((t: { title: string }) => t.title === title);
  await request.delete(`/api/tasks/${created.ID}`);
});

test("a crashing action surfaces the error document, not a silent reload", async ({ page }) => {
  await page.goto("/");
  // a title past the 1MB bind cap makes the go api answer 413, the action
  // throw, and the enhanced submit must swap in the 500 document
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[name="title"]');
    if (input) input.value = "x".repeat(1_050_000);
  });
  await page.click("form button");
  await expect(page.locator("body")).toContainText(/something broke|internal server error/i);
});

test("an enhanced post to a page without an action answers a marked 405", async ({ page }) => {
  await page.goto("/about");
  const res = await page.request.post("/about", {
    form: { anything: "1" },
    headers: { "X-Borgo-Action": "1" },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(405);
  expect(res.headers()["x-borgo"]).toBe("action");
});

test("csrf protects anonymous posts once the token cookie exists", async ({ page }) => {
  // no login: just visiting mints the borgo_csrf cookie; a forged post
  // without the field must be rejected even without a session (login csrf)
  await page.goto("/");
  const forged = await page.request.post("/", {
    form: { title: "anon forged" },
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(403);
});

test("validation error render also keeps the page instance", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    (window as unknown as { __stayed?: boolean }).__stayed = true;
  });
  await page.fill('input[name="title"]', "");
  await page.click("form button");
  await expect(page.locator(".error")).toHaveText("give the task a title");
  expect(await page.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed)).toBe(
    true,
  );
});
