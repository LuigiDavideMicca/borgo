import { defineConfig } from "@playwright/test";

// the "app" project runs against a production build of examples/tasks; the
// "dev" project (fast refresh) starts its own dev server from the spec and
// runs after, so the two builds never race over public/assets
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  projects: [
    {
      name: "app",
      testIgnore: /fastrefresh|export|clear-all/,
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
    {
      name: "dev",
      testMatch: /fastrefresh/,
      dependencies: ["clear-all"],
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
      PORT: "3400",
      API_PORT: "3901",
      DB_PATH: "e2e-prod.db",
      BORGO_METRICS: "1",
    },
  },
});
