import { expect, test } from "@playwright/test";

// a file from the browser to a go handler: a multipart form posted to the
// page's action, handed to the api through the typed client as a FormData,
// read there with borgo.BindMultipart, and its type sniffed from the bytes
test("a file uploaded through a form reaches the go route, typed by its bytes", async ({ page }) => {
  await page.goto("/attach");
  await page.fill('input[name="note"]', "a screenshot");
  // a PNG signature under a name and a type that lie about it
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  await page.setInputFiles('input[name="file"]', { name: "notes.txt", mimeType: "text/plain", buffer: png });
  await page.click("form button");
  await expect(page.getByTestId("attached")).toHaveText("notes.txt · 12 bytes · image/png · a screenshot");
});

test("a form posted with no file is answered by the action, not the api", async ({ page }) => {
  await page.goto("/attach");
  await page.click("form button");
  await expect(page.locator(".error")).toHaveText("choose a file");
});
