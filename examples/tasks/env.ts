import { defineEnv } from "borgo-framework";

// the app's declared environment: validated before the server binds, typed at
// the call site. server values stay on this machine; client values carry the
// BORGO_PUBLIC_ prefix and ride into the bundle through the build's define.
export const env = defineEnv({
  server: {
    // the sqlite file the go api opens - declared so a malformed environment
    // is a named boot refusal, not a first-request surprise
    DB_PATH: { default: "tasks.db" },
    HTTP_TIMEOUT_MS: { type: "number", default: 30_000 },
    // ci plants a value here and greps the built assets for it: a server
    // variable must never reach the browser
    ENV_SENTINEL: { optional: true },
  },
  client: {
    BORGO_PUBLIC_APP_NAME: { default: "tasks" },
  },
});
