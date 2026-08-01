import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** bench/ itself, resolved from this file so the runner works from any cwd. */
export const benchRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** repo root - the parent of bench/. */
export const repoRoot = (): string => resolve(benchRoot(), "..");

export const appsDir = (): string => join(benchRoot(), "apps");
export const resultsDir = (): string => join(benchRoot(), "results");
/** downloaded load tools live here; gitignored. */
export const toolsDir = (): string => join(benchRoot(), ".tools");
