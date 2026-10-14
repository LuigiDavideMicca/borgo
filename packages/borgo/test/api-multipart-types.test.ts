// the typed client's body over a multipart route, held by tsc itself, as
// ws-events-types.test.ts holds the events: every expectation written as
// code, every refusal as an expect-error directive that fails when unused.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const src = resolve(import.meta.dir, "../src/index.ts");

const probe = `
import type { ApiClient } from "borgo-framework";

interface Form { note?: string | null; count?: number | null; file?: Blob | null; extras?: Array<Blob> | null }

declare module "borgo-framework" {
  interface ApiRoutes {
    "POST /api/attachments": { response: { id: string }; request: Form; multipart: true };
    "POST /api/tasks": { response: { id: string }; request: { title?: string | null } };
    "GET /api/files/{rest...}": { response: { size: number } };
    "GET /api/exact/{$}": { response: { ok: boolean } };
  }
}

declare const api: ApiClient;
declare const file: File;

export async function calls() {
  // a multipart route: an object with files, or a FormData of one's own
  const a = await api("POST /api/attachments", { body: { note: "x", file, extras: [file] } });
  a.id.toUpperCase();
  await api("POST /api/attachments", { body: new FormData() });
  // @ts-expect-error a file field is a Blob, not a string
  await api("POST /api/attachments", { body: { file: "not a file" } });
  // @ts-expect-error a field the form does not declare
  await api("POST /api/attachments", { body: { nope: 1 } });
  // a JSON route takes its object, and refuses a FormData
  await api("POST /api/tasks", { body: { title: "t" } });
  // @ts-expect-error a JSON route is not sent a FormData
  await api("POST /api/tasks", { body: new FormData() });
  // ServeMux's wildcards: {name...} is the param name, {$} takes none
  await api("GET /api/files/{rest...}", { params: { rest: "a/b" } });
  // @ts-expect-error the param is rest, not "rest..."
  await api("GET /api/files/{rest...}", { params: { "rest...": "a/b" } });
  await api("GET /api/exact/{$}");
}
`;

test("a multipart route takes its form or a FormData, and a JSON route refuses a FormData", () => {
  const dir = mkdtempSync(join(tmpdir(), "borgo-api-types-"));
  try {
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
        files: ["probe.ts"],
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
