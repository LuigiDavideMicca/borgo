import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appsDir } from "./paths";
import type { Manifest } from "./types";

export interface App {
  dir: string;
  manifest: Manifest;
}

export function listApps(): App[] {
  const root = appsDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name))
    .filter((dir) => existsSync(join(dir, "bench.manifest.json")))
    .map((dir) => ({ dir, manifest: loadManifest(dir) }))
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export function loadManifest(dir: string): Manifest {
  const file = join(dir, "bench.manifest.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  const required: (keyof Manifest)[] = ["name", "framework", "status", "port", "readyPath", "start", "implements"];
  for (const key of required) {
    if (raw[key] === undefined) throw new Error(`${file}: missing "${String(key)}"`);
  }
  if (raw.status !== "implemented" && raw.status !== "stub") {
    throw new Error(`${file}: status must be "implemented" or "stub", got ${JSON.stringify(raw.status)}`);
  }
  if (raw.status === "stub" && !raw.todo) throw new Error(`${file}: a stub must say what is missing in "todo"`);
  return raw;
}

/**
 * ${PORT} / ${API_PORT} in a manifest argv. Some frameworks only take the port
 * as a flag (`next start --port N`), not from the environment.
 */
export function resolveArgv(argv: string[], ports: { port: number; apiPort: number }): string[] {
  return argv.map((arg) =>
    arg.replaceAll("${PORT}", String(ports.port)).replaceAll("${API_PORT}", String(ports.apiPort)),
  );
}

/** ${PORT} / ${API_PORT} in manifest env values */
export function resolveEnv(manifest: Manifest, ports: { port: number; apiPort: number }): Record<string, string> {
  const out: Record<string, string> = {
    PORT: String(ports.port),
    API_PORT: String(ports.apiPort),
    NODE_ENV: "production",
  };
  for (const [key, value] of Object.entries(manifest.env ?? {})) {
    out[key] = value.replaceAll("${PORT}", String(ports.port)).replaceAll("${API_PORT}", String(ports.apiPort));
  }
  return out;
}
