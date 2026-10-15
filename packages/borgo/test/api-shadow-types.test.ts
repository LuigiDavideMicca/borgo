// an app type named like one of borgo-framework's own declarations - a chat
// app's Channel - keeps its name in the generated file, and the declare
// module block reaches it through an alias: inside the block the bare name
// was borgo's Channel (found by the verifier of hunt 3), and renaming the
// app's type broke every import of it (found rebuilding piazza)
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const src = resolve(import.meta.dir, "../src/index.ts");

// what borgogen writes for testdata/shadowed (cmd/borgogen)
const generated = `
export interface Channel {
  name: string;
}

type __app_Channel = Channel;

declare module "borgo-framework" {
  interface ApiRoutes {
    "GET /api/channel": { response: __app_Channel };
  }
  interface WsEvents {
    "live/channel": __app_Channel;
  }
}

export {};
`;

const probe = `
import type { ApiClient } from "borgo-framework";
import { subscribe } from "borgo-framework";
import type { Channel } from "./api-types";

declare const api: ApiClient;

export async function calls() {
  const c: Channel = await api("GET /api/channel");
  c.name.toUpperCase();
  subscribe("live", (event, data) => {
    if (event === "channel") data.name.toUpperCase();
  });
  // @ts-expect-error the app's Channel has no publish: it is not borgo's
  c.publish;
}
`;

test("an app type named Channel is the app's inside the declare module block", () => {
  const dir = mkdtempSync(join(tmpdir(), "borgo-shadow-types-"));
  try {
    writeFileSync(join(dir, "api-types.ts"), generated);
    writeFileSync(join(dir, "probe.ts"), probe);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "es2022",
          lib: ["es2022", "dom"],
          module: "esnext",
          moduleResolution: "bundler",
          skipLibCheck: true,
          paths: { "borgo-framework": [src.replaceAll("\\", "/")] },
        },
        files: ["api-types.ts", "probe.ts"],
      }),
    );
    const run = Bun.spawnSync(["bunx", "tsc", "-p", dir], { stdout: "pipe", stderr: "pipe" });
    const out = run.stdout.toString() + run.stderr.toString();
    expect(out.trim(), out).toBe("");
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
