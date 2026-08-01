import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";

const appDir = join(process.cwd(), "examples", "tasks");
const cli = join(process.cwd(), "packages", "borgo", "src", "cli.ts");

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

test("borgo doctor reports a healthy example app", async () => {
  // the suite's own servers hold the e2e ports; doctor gets free ones
  const [port, apiPort] = [await freePort(), await freePort()];
  // borgogen ran during the suite's build, so the types are fresh
  const result = spawnSync("bun", [cli, "doctor"], {
    cwd: appDir,
    shell: process.platform === "win32",
    encoding: "utf8",
    env: { ...process.env, PORT: String(port), API_PORT: String(apiPort), NO_COLOR: "1" },
  });

  const out = result.stdout;
  expect(out).toContain("doctor");
  expect(out).toContain("bun");
  expect(out).toContain("go1.");
  expect(out).toContain(`port ${port} (front)`);
  expect(out).toContain(`port ${apiPort} (api)`);
  expect(out).toContain("api types");
  expect(out).toContain("node_modules");
  expect(out).toContain("borgo-framework");
  // the count grows as checks are added; what matters is that none failed
  expect(out).toMatch(/all \d+ checks passed/);
  expect(result.status).toBe(0);
});

test("borgo doctor fails with exit 1 when a port is taken", async () => {
  const port = await freePort();
  const apiPort = await freePort();
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen({ port, host: "127.0.0.1" }, resolve));
  try {
    const result = spawnSync("bun", [cli, "doctor"], {
      cwd: appDir,
      shell: process.platform === "win32",
      encoding: "utf8",
      env: { ...process.env, PORT: String(port), API_PORT: String(apiPort), NO_COLOR: "1" },
    });
    expect(result.stdout).toContain(`port ${port} (front)`);
    expect(result.stdout).toContain("in use");
    expect(result.stdout).toMatch(/1 of \d+ checks failed/);
    expect(result.status).toBe(1);
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});
