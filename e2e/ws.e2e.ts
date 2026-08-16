import { expect, test } from "@playwright/test";

test("websocket topics: presence, two-tab relay, go push", async ({ context, request }) => {
  const tab1 = await context.newPage();
  const tab2 = await context.newPage();
  await tab1.goto("/live");
  await tab2.goto("/live");

  await expect(tab1.getByTestId("presence")).toHaveText("2 tabs connected");
  await expect(tab2.getByTestId("presence")).toHaveText("2 tabs connected");

  // browser -> browser
  const message = `hello ${Date.now()}`;
  await tab1.fill("form input", message);
  await tab1.click("form button");
  await expect(tab2.getByTestId("log")).toContainText(message);

  // go -> both tabs via borgo.Push
  const title = `ws push ${Date.now()}`;
  const res = await request.post("/api/tasks", { data: { title } });
  const { task } = await res.json();
  await expect(tab1.getByTestId("log")).toContainText(`task "${title}" created`);
  await expect(tab2.getByTestId("log")).toContainText(`task "${title}" created`);
  await request.delete(`/api/tasks/${task.ID}`);

  // presence updates when a tab leaves
  await tab2.close();
  await expect(tab1.getByTestId("presence")).toHaveText("1 tab connected");
});
