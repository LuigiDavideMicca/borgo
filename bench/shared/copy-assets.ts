#!/usr/bin/env bun
// Copies the canonical shared files into an implementation, so every framework
// serves byte-identical bytes and computes the dataset from identical code.
// Run as a build step from an app directory:
//
//   bun ../../shared/copy-assets.ts public/static [lib]
//
// The optional second argument copies items.js in as well, for bundlers that
// refuse to reach outside the project root (Next.js, Astro).
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [publicDir, itemsDir] = process.argv.slice(2);
if (!publicDir) {
  console.error("usage: bun copy-assets.ts <public-directory> [items-directory]");
  process.exit(1);
}

const copy = async (name: string, intoDir: string) => {
  const source = join(here, name);
  const dest = resolve(process.cwd(), intoDir, name);
  mkdirSync(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(source));
  console.log(`copied ${name} (${Bun.file(source).size} bytes) -> ${dest}`);
};

await copy("payload.json", publicDir);
if (itemsDir) await copy("items.js", itemsDir);
