import { expect, test } from "@playwright/test";

test("a task created elsewhere appears live over sse", async ({ page, request }) => {
  const title = `sse test ${Date.now()}`;
  await page.goto("/");
  await page.waitForTimeout(500); // let the EventSource connect

  const res = await request.post("/api/tasks", { data: { title } });
  const { task } = await res.json();

  await expect(page.locator("li", { hasText: title })).toBeVisible({ timeout: 5000 });
  await request.delete(`/api/tasks/${task.ID}`);
  await expect(page.locator("li", { hasText: title })).toHaveCount(0, { timeout: 5000 });
});
