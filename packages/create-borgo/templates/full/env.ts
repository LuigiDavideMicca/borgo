import { defineEnv } from "borgo-framework";

// the app's declared environment: validated before the server binds, typed at
// the call site. server values stay on this machine; client values carry the
// BORGO_PUBLIC_ prefix and ride into the bundle through the build's define -
// explicit and allowlisted, never by osmosis.
export const env = defineEnv({
  server: {
    // mirrors the rule borgo.Serve enforces on the go half: unset boots with
    // a warning there (sessions then fail per request), set but short is
    // refused at boot. try: openssl rand -base64 32
    SESSION_SECRET: {
      optional: true,
      validate: (raw) => {
        if (raw.length < 32) throw new Error("expected at least 32 characters");
        return raw;
      },
    },
  },
  client: {
    BORGO_PUBLIC_APP_NAME: { default: "{{name}}" },
  },
});
