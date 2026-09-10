// the server half of the app-env story: find the app's env.ts, read the meta
// off every borgo env it exports. lives apart from env.ts so the browser
// bundle never carries the process imports.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EnvMeta } from "./env";

// one file by convention, like pages/ and api/: declared elsewhere it still
// works at import time, but only env.ts is checked at boot and shipped by
// the build - the convention is what makes the guarantees findable
export const APP_ENV_FILE = "env.ts";

// evaluated in a fresh process, not imported: bun's module cache is keyed by
// path with the query ignored (measured - two imports with different ?v read
// one module), so an in-process import would hand a dev-loop rebuild the
// env.ts of the boot, not the one on disk. the subprocess reads the meta off
// the shared symbol registry, so it needs no import of borgo's own code.
// the answer travels through a FILE named in argv, never stdout: stdout
// belongs to the app, and one console.log in env.ts - the most natural
// debugging gesture there is - used to come back as a bare SyntaxError from
// JSON.parse that never named env.ts (found adversarially). whatever the
// module prints is forwarded instead.
// memoised by content hash; a dev rebuild asks fresh, because the hash sees
// env.ts and not the files env.ts imports - edited validation rules kept
// serving the old schema until env.ts itself was touched
const READ_METAS = `
const url = JSON.parse(process.argv.at(-2));
const out = JSON.parse(process.argv.at(-1));
const module = await import(url);
const metas = [];
const seen = new Set();
const envExports = [];
const otherExports = [];
for (const [name, exported] of Object.entries(module)) {
  const meta = exported === null || typeof exported !== "object" ? undefined : exported[Symbol.for("borgo.env")];
  if (meta) {
    envExports.push(name);
    // the same proxy exported under two names (export const env + export
    // default env, the idiomatic pair) is ONE schema: counted twice it
    // double-reported every boot failure and false-refused the build as
    // "declared by more than one exported schema"
    if (!seen.has(exported)) { seen.add(exported); metas.push(meta); }
  } else {
    otherExports.push(name);
  }
}
await Bun.write(out, JSON.stringify({ metas, envExports, otherExports }));
`;

// the shape of the app's env.ts as the build and the boot see it: the
// schemas' metas, plus which export names carried an env (the client shim
// re-exports exactly those) and which carried anything else
export type AppEnv = {
  metas: EnvMeta[];
  envExports: string[];
  otherExports: string[];
};

const memo = new Map<string, AppEnv>();

export async function appEnvMetas(
  root = process.cwd(),
  { fresh = false }: { fresh?: boolean } = {},
): Promise<AppEnv> {
  const file = join(root, APP_ENV_FILE);
  if (!existsSync(file)) return { metas: [], envExports: [], otherExports: [] };
  const key = `${file}:${Bun.hash(readFileSync(file)).toString(36)}`;
  if (!fresh) {
    const known = memo.get(key);
    if (known) return known;
  }
  const out = join(tmpdir(), `borgo-env-${process.pid}-${Date.now().toString(36)}.json`);
  let answer: string;
  try {
    const proc = Bun.spawnSync(
      [process.execPath, "-e", READ_METAS, JSON.stringify(pathToFileURL(file).href), JSON.stringify(out)],
      // bounded: an env.ts whose import never completes - a top-level await
      // on a connection that never answers is the natural gesture - froze
      // the build, every dev rebuild and the boot, silently and forever,
      // because spawnSync stops the parent's event loop while it waits
      { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 10_000 },
    );
    // the app's own output, wherever it went, reaches the person debugging
    const said = proc.stdout.toString().trim();
    if (said) console.log(said);
    if (proc.exitCode !== 0) {
      if (proc.exitCode === null || proc.signalCode != null) {
        throw new Error(
          "borgo: env.ts did not finish importing within 10s - a top-level await on something that never answers would do this. the environment module must load fast; do slow work after boot, not at import",
        );
      }
      // a schema mistake in env.ts is an author error and rides up as the
      // boot failure it is, with bun's own message kept
      throw new Error(`borgo: env.ts refused to load:\n${proc.stderr.toString().trim()}`);
    }
    const complained = proc.stderr.toString().trim();
    if (complained) console.error(complained);
    if (!existsSync(out)) {
      throw new Error(
        "borgo: env.ts loaded but its schema never came back - a process.exit() at import time would do this",
      );
    }
    answer = readFileSync(out, "utf8");
  } finally {
    try {
      unlinkSync(out);
    } catch {}
  }
  let app: AppEnv;
  try {
    app = JSON.parse(answer) as AppEnv;
  } catch {
    // a child killed mid-write (oom, an external kill) leaves a truncated
    // file; a bare SyntaxError naming nothing is the failure class the file
    // channel was built to eliminate
    throw new Error(
      "borgo: env.ts loaded but its schema came back unreadable - the reader process may have been killed mid-write. rerun; if it repeats, something on this machine is killing short-lived bun processes",
    );
  }
  // json dropped the undefined values; the define does the same, and the
  // failures and names travel whole
  app.metas ??= [];
  app.envExports ??= [];
  app.otherExports ??= [];
  for (const meta of app.metas) {
    meta.clientValues ??= {};
    meta.failures ??= [];
    meta.clientFailures ??= [];
    meta.clientNames ??= [];
  }
  memo.set(key, app);
  return app;
}

// what the client bundle gets in env.ts's place: the same export names,
// answering from the define's allowlisted object - and not one byte of the
// schema. the module the author wrote stays on the server, where the
// defaults, the validators and the server variable names belong; shipped in
// an asset they were measured leaking all three
export function envClientShim(app: AppEnv): string {
  // the local carries a $ prefix so no legal export name can collide with
  // it - `export const env = env` was this function's own first bug
  const lines = ['import { browserEnv } from "borgo-framework";', "const $borgoEnv = browserEnv();"];
  for (const name of app.envExports) {
    lines.push(name === "default" ? "export default $borgoEnv;" : `export const ${name} = $borgoEnv;`);
  }
  return lines.join("\n") + "\n";
}

// every failure at once, or null when the environment is healthy (or the app
// declared nothing): the boot check refuses with this text, named per variable
export function envRefusal(metas: EnvMeta[]): string | null {
  const failures = metas.flatMap((m) => m.failures);
  if (failures.length === 0) return null;
  return (
    `the environment refused the boot - ${failures.length} variable${failures.length === 1 ? "" : "s"}:\n` +
    failures.map((f) => `  - ${f}`).join("\n")
  );
}

// the build's own gate: a broken client variable would be frozen into every
// bundle, so it fails the build - server variables are left to the boot check
// on the machine that runs
export function clientEnvRefusal(metas: EnvMeta[]): string | null {
  const broken = metas.flatMap((m) => m.clientFailures);
  if (broken.length === 0) return null;
  return (
    `client environment variables are frozen into the bundle at build, and ${broken.length} refused:\n` +
    broken.map((f) => `  - ${f}`).join("\n")
  );
}

// the one explicit object the build ships to the browser. defined even when
// the app declares nothing: the wall must hold before the first schema exists.
// a client variable declared by two exported schemas is refused rather than
// resolved by export order - the silent last-one-wins was found adversarially,
// and defineEnv already refuses the same duplication inside one schema
export function clientEnvDefine(metas: EnvMeta[]): Record<string, string> {
  const values: Record<string, unknown> = {};
  const owner = new Set<string>();
  for (const meta of metas) {
    for (const name of meta.clientNames) {
      if (owner.has(name)) {
        throw new Error(
          `borgo env: ${name} is declared by more than one exported schema - one variable, one source of truth`,
        );
      }
      owner.add(name);
    }
    Object.assign(values, meta.clientValues);
  }
  return { __BORGO_CLIENT_ENV__: JSON.stringify(values) };
}
