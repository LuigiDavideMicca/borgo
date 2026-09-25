import { expect, test } from "@playwright/test";

// middleware.ts guards /account in the example app, and the account page's
// loader no longer guards itself - so every redirect below is the
// middleware's, and a door it failed to cover shows up as something else: the
// document rendering with no session, props coming back empty, the logout
// action running. The unit suite pins the order in serve()'s source; this is
// the same claim against the real front, render service and runtime.

test("the document door: an anonymous visit is redirected before the loader runs", async ({ request }) => {
  const res = await request.get("/account", { maxRedirects: 0 });
  expect(res.status()).toBe(303);
  expect(res.headers().location).toBe("/login");
});

test("the props door: a client navigation receives the redirect it can follow", async ({ request }) => {
  const res = await request.get("/account?__borgo=props");
  expect(await res.json()).toEqual({ redirect: "/login" });
});

test("the action door: an enhanced post is refused before the action runs", async ({ request }) => {
  const res = await request.post("/account", {
    headers: { "x-borgo-action": "1", "content-type": "application/x-www-form-urlencoded" },
    data: "",
  });
  expect(res.headers()["x-borgo"]).toBe("action");
  // the logout action would have answered { redirect: "/" }
  expect(await res.json()).toEqual({ redirect: "/login" });
});

test("a plain post is redirected like a visit", async ({ request }) => {
  const res = await request.post("/account", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    data: "",
    maxRedirects: 0,
  });
  expect(res.status()).toBe(303);
  expect(res.headers().location).toBe("/login");
});

test("a client navigation to a guarded page lands on the login page", async ({ page }) => {
  await page.goto("/");
  // wait for hydration: the runtime, not a full load, has to follow the redirect
  await expect(page.locator("header nav")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __stayed?: boolean }).__stayed = true;
  });
  await page.click('a[href="/account"]');
  await expect(page).toHaveURL(/\/login$/);
});

test("a signed-in visit goes through, with the headers next() added", async ({ page }) => {
  const username = `guarded${Date.now()}`;
  await page.goto("/register");
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="email"]', username + "@example.test");
  await page.fill('input[name="password"]', "pw123456");
  await page.click("form button");
  await expect(page).toHaveURL(/\/account$/);

  const res = await page.request.get("/account", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(res.headers()["x-account-guard"]).toBe("middleware.ts");
  expect(await res.text()).toContain(username);
});
