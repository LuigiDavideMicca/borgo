// the server half of the app-env story: find the app's env.ts, read the meta
// off every borgo env it exports. lives apart from env.ts so the browser
// bundle never carries the process imports.
import { existsSync, readFileSync } from "node:fs";
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
// memoised by content hash: the cost returns only when the file changes
const READ_METAS = `
const url = JSON.parse(process.argv.at(-1));
const module = await import(url);
const metas = [];
for (const exported of Object.values(module)) {
  const meta = exported === null || typeof exported !== "object" ? undefined : exported[Symbol.for("borgo.env")];
  if (meta) metas.push(meta);
}
console.log(JSON.stringify(metas));
`;

const memo = new Map<string, EnvMeta[]>();

export async function appEnvMetas(root = process.cwd()): Promise<EnvMeta[]> {
  const file = join(root, APP_ENV_FILE);
  if (!existsSync(file)) return [];
  const key = `${file}:${Bun.hash(readFileSync(file)).toString(36)}`;
  const known = memo.get(key);
  if (known) return known;
  const proc = Bun.spawnSync(
    [process.execPath, "-e", READ_METAS, JSON.stringify(pathToFileURL(file).href)],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    // a schema mistake in env.ts is an author error and rides up as the boot
    // failure it is, with bun's own message kept
    throw new Error(`borgo: env.ts refused to load:\n${proc.stderr.toString().trim()}`);
  }
  const metas = JSON.parse(proc.stdout.toString()) as EnvMeta[];
  // json dropped the undefined values; the define does the same, and the
  // failures and names travel whole
  for (const meta of metas) {
    meta.clientValues ??= {};
    meta.failures ??= [];
    meta.clientFailures ??= [];
    meta.clientNames ??= [];
  }
  memo.set(key, metas);
  return metas;
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
// the app declares nothing: the wall must hold before the first schema exists
export function clientEnvDefine(metas: EnvMeta[]): Record<string, string> {
  const values: Record<string, unknown> = {};
  for (const meta of metas) Object.assign(values, meta.clientValues);
  return { __BORGO_CLIENT_ENV__: JSON.stringify(values) };
}
