#!/usr/bin/env bun
// Downloads a pinned `oha` release into bench/.tools so a run does not depend
// on whatever happens to be on the operator's PATH. The version is pinned and
// the sha256 of every artefact we have actually downloaded is recorded below:
// a mismatch aborts. Hashes we have not verified ourselves are `null`, and the
// download prints the hash it saw so the next person can pin it honestly
// rather than us inventing one.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { toolsDir } from "../lib/paths";

export const OHA_VERSION = "v1.15.0";

type Asset = { file: string; sha256: string | null };

const ASSETS: Record<string, Asset> = {
  "win32-x64": {
    file: "oha-windows-amd64.exe",
    sha256: "cfd51293ba621eea0616848a78caf360855859364d2ea8e23df515d791c91383",
  },
  "linux-x64": { file: "oha-linux-amd64", sha256: null },
  "linux-arm64": { file: "oha-linux-arm64", sha256: null },
  "darwin-x64": { file: "oha-macos-amd64", sha256: null },
  "darwin-arm64": { file: "oha-macos-arm64", sha256: null },
};

const key = () => `${process.platform}-${process.arch}`;

export function pinnedOhaPath(): string {
  const asset = ASSETS[key()];
  if (!asset) return "";
  return join(toolsDir(), `${OHA_VERSION}-${asset.file}`);
}

export async function ensureOha(opts: { quiet?: boolean } = {}): Promise<string> {
  const asset = ASSETS[key()];
  if (!asset) throw new Error(`no pinned oha build for ${key()} - install oha yourself and put it on PATH`);

  const dest = pinnedOhaPath();
  if (existsSync(dest)) return dest;

  const url = `https://github.com/hatoo/oha/releases/download/${OHA_VERSION}/${asset.file}`;
  if (!opts.quiet) console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const got = hasher.digest("hex");

  if (asset.sha256 && asset.sha256 !== got) {
    throw new Error(
      `sha256 mismatch for ${asset.file}\n  expected ${asset.sha256}\n  got      ${got}\n` +
        `refusing to use it. either the release was re-cut or the download was tampered with.`,
    );
  }
  if (!asset.sha256 && !opts.quiet) {
    console.log(`  note: no pinned sha256 for ${key()}. downloaded sha256 = ${got}`);
    console.log(`  pin it in bench/tools/get-oha.ts if you trust this download.`);
  }

  mkdirSync(toolsDir(), { recursive: true });
  await Bun.write(dest, bytes);
  if (process.platform !== "win32") chmodSync(dest, 0o755);
  if (!opts.quiet) console.log(`  installed ${dest}`);
  return dest;
}

if (import.meta.main) {
  const path = await ensureOha();
  const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
  console.log("  " + (await new Response(proc.stdout).text()).trim());
  await proc.exited;
}
