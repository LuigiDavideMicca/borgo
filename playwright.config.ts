import { defineConfig } from "@playwright/test";

// the "app" project runs against a production build of examples/tasks; the
// "dev" project (fast refresh) starts its own dev server from the spec and
// runs after, so the two builds never race over public/assets
export default defineConfig({
  testDir: "e2e",
  // .e2e.ts, not .spec.ts: `bun test` with no arguments collects *.spec.ts
  // anywhere under the repo, so these files used to load under bun's runner and
  // die 17 times on "Playwright Test did not expect test() to be called here" -
  // a red that meant "wrong command", indistinguishable from a real one. Bun's
  // discovery patterns are *.test.*, *_test.*, *.spec.* and *_spec.*, so this
  // extension is out of its reach while staying in Playwright's. e2e/reach.test.ts
  // keeps a stray .spec.ts from quietly putting them back.
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  projects: [
    {
      name: "app",
      testIgnore: /fastrefresh|export|clear-all|isr/,
      use: { baseURL: "http://localhost:3400" },
    },
    // clear-all wipes the shared task list, so it waits for the parallel
    // app specs instead of racing their fixtures
    {
      name: "clear-all",
      testMatch: /clear-all/,
      dependencies: ["app"],
      use: { baseURL: "http://localhost:3400" },
    },
    // isr asserts cache hits by render stamp, and any parallel spec that
    // writes a task drops the news page mid-assert, so it runs alone
    {
      name: "isr",
      testMatch: /isr/,
      dependencies: ["clear-all"],
      use: { baseURL: "http://localhost:3400" },
    },
    {
      name: "dev",
      testMatch: /fastrefresh/,
      dependencies: ["isr"],
      use: { baseURL: "http://localhost:3410" },
    },
    // export rebuilds the example's production assets and adds scratch pages,
    // so it runs last, alone, against its own static server
    {
      name: "export",
      testMatch: /export/,
      dependencies: ["dev"],
    },
  ],
  webServer: {
    command: "bun run build && bun run start",
    cwd: "examples/tasks",
    url: "http://localhost:3400",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      ...process.env,
      // explicit rather than left to `borgo start`'s re-exec default, so the
      // production build under test is served without an extra supervisor hop
      NODE_ENV: "production",
      PORT: "3400",
      API_PORT: "3901",
      DB_PATH: "e2e-prod.db",
      BORGO_METRICS: "1",
      // env.e2e.ts greps the built assets for this value: a server variable
      // must never reach a client bundle
      ENV_SENTINEL: "borgo-env-server-sentinel-7f3a",
      // deliberately NOT the schema's default: a client value that matches
      // the default cannot tell "the define shipped it" from "the browser
      // fell back", which is exactly the survival a mutation run found
      BORGO_PUBLIC_APP_NAME: "tasks-e2e",
    },
  },
});
