import { expect, test, type Page } from "@playwright/test";
import { csrfHeader } from "./csrf";

// register -> account -> logout -> login exercises the full auth loop:
// go handlers set and clear the session, the front server forwards the
// cookies, the loader guard redirects, and csrf protects the forms
test("register, protected page, logout, login round trip", async ({ page }) => {
  const username = `user${Date.now()}`;
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/account");
  await expect(page).toHaveURL(/\/login$/);

  await page.goto("/register");
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', "pw123456");
  await page.click("form button");
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.locator("main strong")).toHaveText(username);

  await page.click("form button"); // log out
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login$/);

  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', "pw123456");
  await page.click("form button");
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.locator("main strong")).toHaveText(username);

  // csrf hydration must be clean: a token mismatch would log a react error
  expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);
});

test("wrong password re-renders with an error", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="username"]', "nobody");
  await page.fill('input[name="password"]', "wrong");
  await page.click("form button");
  await expect(page.locator(".error")).toHaveText("wrong username or password");
});

async function login(page: Page, username: string) {
  await page.goto("/register");
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', "pw123456");
  await page.click("form button");
  await expect(page).toHaveURL(/\/account$/);
}

test("the nav shows the session state and logs out from it", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header nav .session")).toHaveText("login");

  const username = `nav${Date.now()}`;
  await login(page, username);
  await page.goto("/");
  const session = page.locator("header nav .session");
  await expect(session).toContainText(`ciao ${username}`);

  await session.locator("button").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("header nav .session")).toHaveText("login");
});

test("clearing the whole list is 401 for visitors, api and ui alike", async ({ page }) => {
  // the layout asks /api/me only after hydration, so awaiting it means the
  // click below lands on a live react tree
  const hydrated = page.waitForResponse("**/api/me");
  await page.goto("/");
  await hydrated;

  // with the token: the request reaches go, which refuses it for want of a
  // session. this used to be a bare delete, which now never gets that far -
  // the csrf check answers first, and the 401 it was asserting would silently
  // have become a 403 that proves nothing about Authed
  const anon = await page.request.delete("/api/tasks", { headers: await csrfHeader(page) });
  expect(anon.status()).toBe(401);

  await page.click(".clear-all");
  await expect(page.getByTestId("clear-error")).toHaveText("log in to clear all tasks");
});

test("a forged post without the csrf token is rejected", async ({ page }) => {
  await login(page, `csrf${Date.now()}`);

  // page.request shares the browser's cookies (session + csrf) but sends no
  // token field - exactly what a cross-origin form post looks like
  const forged = await page.request.post("/", {
    form: { title: "forged task" },
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(403);

  const wrongToken = await page.request.post("/", {
    form: { title: "forged task", __borgo_csrf: "0000feed" },
    maxRedirects: 0,
  });
  expect(wrongToken.status()).toBe(403);

  // the real form carries the hidden field and passes
  const title = `csrf ok ${Date.now()}`;
  await page.goto("/");
  await page.fill('input[name="title"]', title);
  await page.click("form button");
  await expect(page.locator("li", { hasText: title })).toBeVisible();

  const { tasks } = await (await page.request.get("/api/tasks")).json();
  const created = tasks.find((t: { title: string }) => t.title === title);
  await page.request.delete(`/api/tasks/${created.ID}`, { headers: await csrfHeader(page) });
});

test("an /api mutation without the csrf header is rejected", async ({ page }) => {
  await login(page, `apicsrf${Date.now()}`);
  const title = `api csrf ${Date.now()}`;

  // same jar, same cookies, no header: the shape a same-site attacker's
  // request has, and the front server answers before go ever hears about it
  const forged = await page.request.post("/api/tasks", {
    data: { title, body: "" },
  });
  expect(forged.status()).toBe(403);

  const wrongToken = await page.request.post("/api/tasks", {
    data: { title, body: "" },
    headers: { "X-CSRF-Token": "0000feed" },
  });
  expect(wrongToken.status()).toBe(403);

  // nothing was created by either
  const { tasks } = await (await page.request.get("/api/tasks")).json();
  expect(tasks.some((t: { title: string }) => t.title === title)).toBe(false);

  // and a get is never checked, header or no header
  expect((await page.request.get("/api/me")).status()).toBe(200);

  // the same post with the token goes through, and cleans up after itself
  const allowed = await page.request.post("/api/tasks", {
    data: { title, body: "" },
    headers: await csrfHeader(page),
  });
  expect(allowed.status()).toBe(201);
  const { task } = await allowed.json();
  await page.request.delete(`/api/tasks/${task.ID}`, { headers: await csrfHeader(page) });
});
