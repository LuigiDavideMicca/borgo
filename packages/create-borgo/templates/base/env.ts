import { defineEnv } from "borgo-framework";

// the app's declared environment: validated before the server binds, typed at
// the call site (env.BORGO_PUBLIC_APP_NAME is a string, a number type would
// read as a number). server values stay on this machine; client values carry
// the BORGO_PUBLIC_ prefix and ride into the bundle through the build's
// define - explicit and allowlisted, never by osmosis.
export const env = defineEnv({
  client: {
    BORGO_PUBLIC_APP_NAME: { default: "{{name}}" },
  },
});
