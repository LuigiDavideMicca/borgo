import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// The live gate of session revocation: two devices signed in as one user, one
// of them logs out everywhere, and the other - which logged out of nothing and
// still holds its cookie - has no session on its very next request. The unit
// suite pins CheckSession in the go package; this is the same claim against
// the real front, the render service and a browser's cookies.

async function signIn(page: Page, path: "/register" | "/login", username: string) {
  await page.goto(path);
  await page.fill('input[name="username"]', username);
  if (path === "/register") await page.fill('input[name="email"]', username.replace(/[^a-z0-9]/gi, "") + "@example.test");
  await page.fill('input[name="password"]', "pw123456");
  await page.click("form button");
  await expect(page).toHaveURL(/\/account$/);
}

async function csrfToken(context: BrowserContext) {
  const cookie = (await context.cookies()).find((c) => c.name === "borgo_csrf");
  expect(cookie, "the page render issues a csrf cookie").toBeTruthy();
  return cookie!.value;
}

test("logging out everywhere ends the other device's session on its next request", async ({ browser }) => {
  // a comma, a slash and a space: none of them may sit in a topic, and the
  // user's topic is keyed by id so the name never has to
  const username = `revoked ${Date.now()}, a/b`;
  const laptop = await browser.newContext();
  const phone = await browser.newContext();
  try {
    const onLaptop = await laptop.newPage();
    const onPhone = await phone.newPage();
    await signIn(onLaptop, "/register", username);
    await signIn(onPhone, "/login", username);
    expect((await onPhone.request.get("/api/me")).status()).toBe(200);

    // the phone's tab sits on /account, holding the user's own topic
    // (user:<id>, admitted by CanSubscribe for this session alone)
    await expect(onPhone).toHaveURL(/\/account$/);
    const res = await onLaptop.request.post("/api/logout-everywhere", {
      headers: { "X-CSRF-Token": await csrfToken(laptop) },
    });
    expect(res.status()).toBe(204);
    // ...and is told at once, over the typed "signed-out" event, before it
    // makes any request of its own
    await expect(onPhone).toHaveURL(/\/login\?signed-out=\d+$/, { timeout: 10_000 });

    // the phone did nothing and kept its cookie: the revocation is decided
    // when the session is read, not by rewriting anyone's cookie
    expect((await phone.cookies()).some((c) => c.name === "borgo_session")).toBe(true);
    // ...and on its next request, through every door, it has no session
    expect((await onPhone.request.get("/api/me")).status()).toBe(401);
    const doc = await onPhone.request.get("/account", { maxRedirects: 0 });
    expect(doc.status()).toBe(303);
    expect(doc.headers().location).toBe("/login");
    expect(await (await onPhone.request.get("/account?__borgo=props")).json()).toEqual({ redirect: "/login" });

    // signing in again issues a session after the cutoff, and it works
    await signIn(onPhone, "/login", username);
    expect((await onPhone.request.get("/api/me")).status()).toBe(200);
  } finally {
    await laptop.close();
    await phone.close();
  }
});

// the device whose socket was down when the event went out: its redial
// carries the revoked session, the relay refuses the topic for good, and the
// page leaves on that refusal instead of sitting on a dead account
test("a device that missed the signed-out event leaves when its redial is refused", async ({ browser }) => {
  // the redial backs off, doubling from a second: room for a slow runner
  test.setTimeout(60_000);
  const username = `missed${Date.now()}`;
  const laptop = await browser.newContext();
  const phone = await browser.newContext();
  try {
    const onLaptop = await laptop.newPage();
    const onPhone = await phone.newPage();
    await signIn(onLaptop, "/register", username);
    let down = true;
    await onPhone.routeWebSocket(/\/ws\?/, (ws) => {
      if (down) ws.close();
      else ws.connectToServer();
    });
    await signIn(onPhone, "/login", username);
    const res = await onLaptop.request.post("/api/logout-everywhere", {
      headers: { "X-CSRF-Token": await csrfToken(laptop) },
    });
    expect(res.status()).toBe(204);
    down = false;
    await expect(onPhone).toHaveURL(/\/login$/, { timeout: 40_000 });
  } finally {
    await laptop.close();
    await phone.close();
  }
});
