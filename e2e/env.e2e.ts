import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const appDir = join(process.cwd(), "examples", "tasks");
const assetsDir = join(appDir, "public", "assets");

// "tasks-e2e" is planted by the webServer and is NOT the schema's default on
// purpose: asserting the default cannot tell a shipped define from a browser
// fallback that happens to agree - a mutation dropping the define survived
// exactly that way once
test("the typed client value renders on the server and survives hydration", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-name")).toHaveText("tasks-e2e");
  // interact to prove the tree hydrated with env in it - a client-side env
  // failure would have crashed hydration before this click could work
  await page.fill('input[name="title"]', "env probe");
  await expect(page.locator('input[name="title"]')).toHaveValue("env probe");
});

test("the wall: client values are in the bundle, server values never are", () => {
  const js = readdirSync(assetsDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(assetsDir, f), "utf8"))
    .join("\n");
  // the define landed: the planted VALUE is in the shipped code - the name
  // alone also rides in as the schema declaration, so it proves nothing
  expect(js).toContain("tasks-e2e");
  // the sentinel the webServer planted in a server variable is not
  expect(js).not.toContain("borgo-env-server-sentinel-7f3a");
});

test("a malformed variable refuses the boot by name, before anything binds", () => {
  const proc = spawnSync("bun", ["run", "start"], {
    cwd: appDir,
    shell: process.platform === "win32",
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PORT: "3440",
      API_PORT: "3941",
      HTTP_TIMEOUT_MS: "banana",
    },
  });
  expect(proc.status).not.toBe(0);
  const out = `${proc.stdout}\n${proc.stderr}`;
  expect(out).toContain("HTTP_TIMEOUT_MS");
  expect(out).toContain("expected a number");
});
