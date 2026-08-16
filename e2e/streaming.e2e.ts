import { expect, test } from "@playwright/test";

test("suspense content streams into the initial response", async ({ request }) => {
  const res = await request.get("/slow");
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain("Streaming SSR");
  expect(html).toContain("this paragraph streamed in after the shell");
});

test("the streamed section is visible in the browser", async ({ page }) => {
  await page.goto("/slow");
  await expect(page.locator(".streamed")).toHaveText("this paragraph streamed in after the shell", {
    timeout: 10_000,
  });
});
