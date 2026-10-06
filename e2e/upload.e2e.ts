import { expect, test, type Page } from "@playwright/test";

// writing to the server's disk is for signed-in users: the page and the route
// both say so
async function signUp(page: Page) {
  const username = `uploader${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  await page.goto("/register");
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="email"]', username + "@example.test");
  await page.fill('input[name="password"]', "pw123456");
  await page.click("form button");
  await expect(page).toHaveURL(/\/account$/);
}

test("the upload page and its route turn away a visitor with no session", async ({ page }) => {
  const doc = await page.request.get("/attach", { maxRedirects: 0 });
  expect(doc.status()).toBe(303);
  expect(doc.headers().location).toBe("/login");
  // no cookie of borgo's at all: past the csrf guard, stopped by Authed
  const res = await page.request.post("/api/attachments", { multipart: { note: "n", file: { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") } } });
  expect(res.status()).toBe(401);
});

// a file from the browser to a go handler: a multipart form posted to the
// page's action, handed to the api through the typed client as a FormData,
// read there with borgo.BindMultipart, and its type sniffed from the bytes
test("a file uploaded through a form reaches the go route, typed by its bytes", async ({ page }) => {
  await signUp(page);
  await page.goto("/attach");
  await page.fill('input[name="note"]', "a screenshot");
  // a PNG signature under a name and a type that lie about it
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  await page.setInputFiles('input[name="file"]', { name: "notes.txt", mimeType: "text/plain", buffer: png });
  await page.click("form button");
  await expect(page.getByTestId("attached")).toHaveText("notes.txt · 12 bytes · image/png · a screenshot");
});

test("a form posted with no file is answered by the action, not the api", async ({ page }) => {
  await signUp(page);
  await page.goto("/attach");
  await page.click("form button");
  await expect(page.locator(".error")).toHaveText("choose a file");
});
