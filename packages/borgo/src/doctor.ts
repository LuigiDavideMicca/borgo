// borgo doctor: diagnoses the environment an app runs in. every check is a
// pure function over an injectable DoctorEnv, so the logic is unit-testable
// without touching the real machine.
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { banner, c, g } from "./colors";

// info marks a check whose bad news is worth printing but is not a broken
// environment: no docker on a machine that never builds an image is fine.
// these never count towards the exit code, and never render red.
export type Check = { name: string; ok: boolean; detail: string; fix?: string; info?: boolean };

export type DoctorEnv = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  which: (cmd: string) => string | null;
  exec: (cmd: string[]) => { code: number; out: string };
  exists: (path: string) => boolean;
  mtime: (path: string) => number | null;
  listDir: (dir: string) => string[];
  // every file under dir, at any depth, as paths relative to dir
  listTree: (dir: string) => string[];
  readFile: (path: string) => string | null;
  resolve: (spec: string) => string | null;
  openForWrite: (path: string) => "ok" | "busy";
  // borgo creates these directories on demand, so a missing one is probed at
  // its nearest existing ancestor: what fails a read-only checkout is the
  // mkdir, and that is the parent's permission
  probeWrite: (dir: string) => "ok" | "denied";
  diskFree: (path: string) => number | null;
  isPortFree: (port: number) => Promise<boolean>;
};

export const realEnv = (): DoctorEnv => ({
  platform: process.platform,
  env: process.env,
  which: (cmd) => Bun.which(cmd),
  exec: (cmd) => {
    try {
      const proc = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
      return { code: proc.exitCode ?? 1, out: proc.stdout.toString() };
    } catch {
      return { code: 1, out: "" };
    }
  },
  exists: existsSync,
  mtime: (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  },
  listDir: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  listTree: (dir) => {
    try {
      return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1).replaceAll("\\", "/"));
    } catch {
      return [];
    }
  },
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  resolve: (spec) => {
    try {
      return Bun.resolveSync(spec, process.cwd());
    } catch {
      return null;
    }
  },
  probeWrite: (dir) => {
    let target = dir;
    while (target && !existsSync(target)) {
      const parent = dirname(target);
      if (parent === target) break;
      target = parent;
    }
    const probe = join(target || ".", `.borgo-doctor-${process.pid}`);
    try {
      writeFileSync(probe, "");
      unlinkSync(probe);
      return "ok";
    } catch {
      return "denied";
    }
  },
  diskFree: (path) => {
    try {
      const fs = statfsSync(path);
      return fs.bavail * fs.bsize;
    } catch {
      return null;
    }
  },
  // a running executable cannot be opened for write on windows; that is
  // exactly the lock that makes dev's binary swap fail with EPERM
  openForWrite: (path) => {
    try {
      closeSync(openSync(path, "r+"));
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code === "ENOENT" ? "ok" : "busy";
    }
  },
  // no host: the probe binds the wildcard address, which collides with a
  // holder on any interface. pinning it to 127.0.0.1 misses the common case
  // on windows - a server bound to 0.0.0.0 without SO_EXCLUSIVEADDRUSE (go's
  // net.Listen, so borgo's own api) lets a loopback-only bind succeed, and the
  // port reads back "free" while the api is answering on it
  isPortFree: (port) =>
    new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen({ port, exclusive: true }, () => server.close(() => resolve(true)));
    }),
});

export function parseVersion(s: string): number[] | null {
  const m = s.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function versionAtLeast(version: string, min: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

const MIN_BUN = "1.3.0";
const MIN_GO = "1.25";
// enough for node_modules, a go build cache and the emitted bundle
const MIN_FREE_BYTES = 512 * 1024 * 1024;

const bunInstall = (platform: string) =>
  platform === "win32"
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
    : "curl -fsSL https://bun.sh/install | bash";

const packageJson = (d: DoctorEnv): Record<string, unknown> | null => {
  const raw = d.readFile("package.json");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

// the app may ask for a newer bun than the framework does; it may not ask for
// an older one. a declared floor below borgo's is not a relaxation, it is a
// green check on a bun that `borgo build` will fail on, so the higher of the
// two wins. a range like ">=1.3.2 <2" is read for its first version.
export function bunMinimum(d: DoctorEnv): { min: string; source: string } {
  const engines = packageJson(d)?.engines as { bun?: string } | undefined;
  const declared = typeof engines?.bun === "string" ? parseVersion(engines.bun) : null;
  if (!declared) return { min: MIN_BUN, source: "borgo" };
  const asked = declared.join(".");
  if (!versionAtLeast(asked, MIN_BUN)) return { min: MIN_BUN, source: "borgo" };
  return { min: asked, source: "package.json engines.bun" };
}

// an npm-installed bun is a wrapper under node_modules, not the real binary:
// it runs, but the bin shims it spawns cannot find bun and the whole thing
// fails with "bun is not installed"
const underNodeModules = (path: string) => /[\\/]node_modules[\\/]/.test(path);

// npm and nvm-for-windows install their wrappers as .cmd/.ps1/.bat next to
// node.exe. the official bun installer only ever writes bun.exe.
const isCmdShim = (path: string) => /\.(cmd|bat|ps1)$/i.test(path);

export function checkBun(d: DoctorEnv): Check {
  const name = "bun";
  const found = d.which("bun");
  if (!found) {
    return { name, ok: false, detail: "not found on PATH", fix: `install it: ${bunInstall(d.platform)}` };
  }
  if (d.platform === "win32" && !d.which("bun.exe")) {
    return {
      name,
      ok: false,
      detail: `resolves to a shim (${found}) but bun.exe is not on PATH`,
      fix: `use the official installer instead of npm: ${bunInstall(d.platform)}`,
    };
  }
  if (underNodeModules(found)) {
    return {
      name,
      ok: false,
      detail: `an npm-installed shim (${found}) shadows the real bun on PATH`,
      fix: `remove the "bun" npm package, then install it properly: ${bunInstall(d.platform)}`,
    };
  }
  const ver = d.exec(["bun", "--version"]);
  const version = ver.code === 0 ? ver.out.trim() : "";
  if (!version) {
    return { name, ok: false, detail: `${found} did not answer --version`, fix: `reinstall it: ${bunInstall(d.platform)}` };
  }
  const { min, source } = bunMinimum(d);
  if (!versionAtLeast(version, min)) {
    return {
      name,
      ok: false,
      detail: `${version} is older than the required ${min} (${source})`,
      fix: "bun upgrade",
    };
  }
  return { name, ok: true, detail: `${version} ${g.dot} ${found}` };
}

// the shim resolves *and* a real bun.exe is installed somewhere else on PATH:
// everything works until something spawns a bin shim, so this is a note and
// not a failure - unlike the case checkBun already fails on, where the shim is
// all there is. reported separately so the version check still runs.
export function checkBunShim(d: DoctorEnv): Check | null {
  const found = d.which("bun");
  if (!found || !isCmdShim(found)) return null;
  const real = d.which("bun.exe");
  if (!real || real === found) return null;
  return {
    name: "bun on PATH",
    ok: false,
    info: true,
    detail: `${found} shadows ${real}`,
    fix: `put the directory of ${real} ahead of it on PATH, or remove the shim`,
  };
}

// borgo needs no node at all; a plugin, a lint step or a playwright install
// might, and "is node even here" is the first thing anyone asks when one of
// them fails. purely informational either way.
export function checkNode(d: DoctorEnv): Check {
  const name = "node";
  const found = d.which("node");
  if (!found) {
    return {
      name,
      ok: false,
      info: true,
      detail: "not found on PATH",
      fix: "only needed if a tool you use asks for it - borgo does not: https://nodejs.org",
    };
  }
  const ver = d.exec(["node", "--version"]);
  const version = ver.code === 0 ? ver.out.trim().replace(/^v/, "") : "";
  return {
    name,
    ok: true,
    info: true,
    detail: version ? `${version} ${g.dot} ${found}` : found,
  };
}

// the scaffold ships a Dockerfile and a compose file. not having docker is a
// perfectly good state to be in - knowing before `borgo deploy` is not.
export function checkDocker(d: DoctorEnv): Check {
  const name = "docker";
  const found = d.which("docker");
  if (!found) {
    return {
      name,
      ok: false,
      info: true,
      detail: "not installed",
      fix: "only needed for the scaffold's Dockerfile: https://docs.docker.com/get-docker/",
    };
  }
  // asks the daemon, not the registry: it fails fast when nothing is listening
  const ver = d.exec(["docker", "version", "--format", "{{.Server.Version}}"]);
  const server = ver.code === 0 ? ver.out.trim().split("\n")[0]?.trim() : "";
  if (!server) {
    return {
      name,
      ok: false,
      info: true,
      detail: `${found} is installed but the daemon is not reachable`,
      fix: d.platform === "linux" ? "sudo systemctl start docker" : "start docker desktop",
    };
  }
  return { name, ok: true, info: true, detail: `server ${server} ${g.dot} ${found}` };
}

// a read-only checkout, a synced folder that lost its permissions, an
// antivirus holding public/assets: every one of them surfaces later as a
// build that fails halfway with an errno nobody reads
export function checkWritable(d: DoctorEnv): Check | null {
  if (!d.exists("package.json")) return null;
  const name = "write access";
  const targets = [".borgo", "public/assets", "dist"];
  const denied = targets.filter((dir) => d.probeWrite(dir) === "denied");
  if (denied.length) {
    return {
      name,
      ok: false,
      detail: `cannot write to ${denied.join(", ")}`,
      fix:
        d.platform === "win32"
          ? `check the folder is not read-only or synced-locked: icacls ${denied[0]}`
          : `chmod u+w ${denied[0]} (or fix its owner)`,
    };
  }
  return { name, ok: true, detail: `${targets.join(", ")} writable` };
}

const humanBytes = (bytes: number) => {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
};

export function checkDisk(d: DoctorEnv): Check | null {
  const free = d.diskFree(".");
  // an fs that cannot answer is not a problem to report
  if (free === null) return null;
  const name = "disk space";
  if (free < MIN_FREE_BYTES) {
    return {
      name,
      ok: false,
      detail: `${humanBytes(free)} free, a build wants at least ${humanBytes(MIN_FREE_BYTES)}`,
      fix: "free up space - node_modules, the go build cache and public/assets all land here",
    };
  }
  return { name, ok: true, detail: `${humanBytes(free)} free` };
}

const PLAYWRIGHT_PKGS = ["@playwright/test", "playwright"];

const playwrightBrowsersDir = (d: DoctorEnv): string => {
  const override = d.env.PLAYWRIGHT_BROWSERS_PATH;
  // the documented "0" means: keep them inside the package itself
  if (override === "0") return "node_modules/playwright-core/.local-browsers";
  if (override) return override;
  if (d.platform === "win32") return `${d.env.LOCALAPPDATA ?? ""}/ms-playwright`;
  const home = d.env.HOME ?? "";
  return d.platform === "darwin" ? `${home}/Library/Caches/ms-playwright` : `${home}/.cache/ms-playwright`;
};

// only for apps that actually use it: an install of ~400 MB of browsers is
// not something to nag a plain app about
export function checkPlaywright(d: DoctorEnv): Check | null {
  const pkg = packageJson(d);
  if (!pkg) return null;
  const deps = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  };
  const dep = PLAYWRIGHT_PKGS.find((p) => p in deps);
  if (!dep) return null;
  const name = "playwright";
  const dir = playwrightBrowsersDir(d);
  const installed = d.listDir(dir).filter((entry) => !entry.startsWith("."));
  if (!installed.length) {
    return {
      name,
      ok: false,
      detail: `${dep} is a dependency but no browsers are installed in ${dir}`,
      fix: "bunx playwright install",
    };
  }
  return { name, ok: true, detail: `${installed.length} browsers ${g.dot} ${dir}` };
}

export function checkGo(d: DoctorEnv): Check {
  const name = "go";
  const found = d.which("go");
  const required = d.readFile("go.mod")?.match(/^go\s+(\d+(?:\.\d+){0,2})/m)?.[1] ?? MIN_GO;
  if (!found) {
    return { name, ok: false, detail: "not found on PATH", fix: `install go >= ${required}: https://go.dev/dl` };
  }
  const ver = d.exec(["go", "version"]);
  const version = ver.code === 0 ? ver.out.match(/go(\d+\.\d+(?:\.\d+)?)/)?.[1] : undefined;
  if (!version) {
    return { name, ok: false, detail: `${found} did not answer \`go version\``, fix: `reinstall go: https://go.dev/dl` };
  }
  if (!versionAtLeast(version, required)) {
    return { name, ok: false, detail: `go${version} is older than the required go >= ${required}`, fix: "update go: https://go.dev/dl" };
  }
  return { name, ok: true, detail: `go${version} ${g.dot} ${found}` };
}

export function parseNetstatPid(out: string, port: number): string | null {
  // the state column is localized ("LISTENING", "IN ASCOLTO", "ABHÖREN"...):
  // recognize a listening row by shape instead, a tcp local address on the
  // port with the wildcard foreign address :0
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+:0\s/);
    if (!m || Number(m[1]) !== port) continue;
    const pid = line.trim().split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid)) return pid;
  }
  return null;
}

export function portHolder(d: DoctorEnv, port: number): { pid: string; name: string } | null {
  if (d.platform === "win32") {
    const pid = parseNetstatPid(d.exec(["netstat", "-ano", "-p", "tcp"]).out, port);
    if (!pid) return null;
    const task = d.exec(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    return { pid, name: task.out.match(/^"([^"]+)"/)?.[1] ?? "unknown" };
  }
  const out = d.exec(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).out;
  const line = out.split("\n").find((l) => /LISTEN/.test(l));
  if (!line) return null;
  const [name, pid] = line.trim().split(/\s+/);
  return pid && /^\d+$/.test(pid) ? { pid, name } : null;
}

// the processes `borgo dev` and `borgo start` are made of: the bun front
// server, and the go api binary, which is `api` in dev (.borgo/api) and
// dist/api in a build. lsof truncates long command names, so these are
// compared as the short image names both platforms report.
const OWN_IMAGES = new Set(["bun", "api", "borgo"]);

export function isOwnProcess(image: string): boolean {
  const base = image.replaceAll("\\", "/").split("/").pop() ?? image;
  return OWN_IMAGES.has(base.toLowerCase().replace(/\.exe$/, ""));
}

export async function checkPort(d: DoctorEnv, port: number, label: string, envVar: string): Promise<Check> {
  const name = `port ${port} (${label})`;
  if (await d.isPortFree(port)) return { name, ok: true, detail: "free" };
  const holder = portHolder(d, port);
  if (!holder) {
    return { name, ok: false, detail: "in use", fix: `free it, or set ${envVar} to another port` };
  }
  const kill = d.platform === "win32" ? `taskkill /F /PID ${holder.pid}` : `kill ${holder.pid}`;
  // doctor is what you run *while* something is off, which usually means with
  // `borgo dev` up: a port held by borgo's own processes is the app running,
  // not a broken machine, and failing red and exiting 1 over it made the one
  // command meant to diagnose the problem report a problem of its own.
  if (isOwnProcess(holder.name)) {
    return {
      name,
      ok: false,
      info: true,
      detail: `in use by borgo itself ${g.dot} ${holder.name} (pid ${holder.pid})`,
      fix: `nothing to fix if that is your own borgo ${g.dot} a leftover from a killed run: ${kill}`,
    };
  }
  return {
    name,
    ok: false,
    detail: `in use by ${holder.name} (pid ${holder.pid})`,
    fix: `${kill} ${g.dot} or set ${envVar} to another port`,
  };
}

export function checkApiBinary(d: DoctorEnv): Check {
  const name = "api binary";
  const image = "api" + (d.platform === "win32" ? ".exe" : "");
  const bin = `.borgo/${image}`;
  if (!d.exists(bin)) return { name, ok: true, detail: "no dev binary yet" };
  // only windows locks a running executable against replacement; elsewhere
  // dev's rename swap works regardless (and open(r+) on a running elf would
  // report a false ETXTBSY "busy")
  if (d.platform !== "win32") return { name, ok: true, detail: `${bin} swappable` };
  if (d.openForWrite(bin) === "busy") {
    const kill = d.platform === "win32" ? `taskkill /F /IM ${image}` : "pkill -x api";
    return {
      name,
      ok: false,
      detail: `${bin} is locked by a running "api" process, dev cannot swap in a new build`,
      fix: kill,
    };
  }
  return { name, ok: true, detail: `${bin} swappable` };
}

export function checkApiTypes(d: DoctorEnv): Check | null {
  if (!d.exists("api")) return null;
  const name = "api types";
  const types = ".borgo/api-types.d.ts";
  const fix = "go tool borgogen (borgo dev and borgo build run it for you)";
  const generated = d.mtime(types);
  if (generated === null) return { name, ok: false, detail: `${types} is missing`, fix };
  // the whole tree, not just the top level: borgogen reads every .go file
  // under api/, so an app that keeps handlers in api/users/ was reported
  // "fresh" no matter how far behind the generated types had fallen
  for (const file of d.listTree("api")) {
    if (!file.endsWith(".go")) continue;
    const changed = d.mtime(`api/${file}`);
    if (changed !== null && changed > generated + 1000) {
      return { name, ok: false, detail: `api/${file} is newer than ${types}`, fix };
    }
  }
  return { name, ok: true, detail: "fresh" };
}

export function checkNodeModules(d: DoctorEnv): Check | null {
  if (!d.exists("package.json")) return null;
  const name = "node_modules";
  if (!d.exists("node_modules")) return { name, ok: false, detail: "missing", fix: "bun install" };
  return { name, ok: true, detail: "present" };
}

const pkgVersion = (d: DoctorEnv, path: string | null): string | null => {
  if (!path) return null;
  const raw = d.readFile(path);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
};

export function checkDeps(d: DoctorEnv): Check | null {
  if (!d.exists("package.json") || !d.exists("node_modules")) return null;
  const name = "app deps";
  const framework = pkgVersion(d, d.resolve("borgo-framework/package.json"));
  if (!framework) {
    return { name, ok: false, detail: "borgo-framework is not installed", fix: "bun install" };
  }
  const react = pkgVersion(d, d.resolve("react/package.json"));
  const reactDom = pkgVersion(d, d.resolve("react-dom/package.json"));
  if (!react || !reactDom) {
    return { name, ok: false, detail: "react and react-dom must both be installed", fix: "bun install" };
  }
  if (react !== reactDom) {
    return {
      name,
      ok: false,
      detail: `react ${react} and react-dom ${reactDom} differ`,
      fix: "align their versions in package.json, then bun install",
    };
  }
  if (d.exists("api") && !/cmd\/borgogen/.test(d.readFile("go.mod") ?? "")) {
    return {
      name,
      ok: false,
      detail: "go.mod is missing the borgogen tool directive",
      fix: "add `tool github.com/LuigiDavideMicca/borgo/cmd/borgogen` to go.mod",
    };
  }
  return { name, ok: true, detail: `borgo-framework ${framework}, react ${react}` };
}

export async function runChecks(d: DoctorEnv): Promise<Check[]> {
  const port = Number(d.env.PORT || 3000);
  const apiPort = Number(d.env.API_PORT || 3501);
  const results: Array<Check | null> = [
    // toolchain
    checkBun(d),
    checkBunShim(d),
    checkGo(d),
    checkNode(d),
    checkDocker(d),
    // machine
    await checkPort(d, port, "front", "PORT"),
    await checkPort(d, apiPort, "api", "API_PORT"),
    checkDisk(d),
    // project
    checkApiBinary(d),
    checkApiTypes(d),
    checkNodeModules(d),
    checkDeps(d),
    checkWritable(d),
    checkPlaywright(d),
  ];
  return results.filter((r): r is Check => r !== null);
}

/** informational bad news is a note, never a failure: it stays out of the exit code */
export const isFailure = (r: Check) => !r.ok && !r.info;

export async function doctor(d: DoctorEnv = realEnv()): Promise<number> {
  console.log(`\n  ${banner("doctor")}\n`);
  const results = await runChecks(d);
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    // three states, three marks: a note is neither green nor red, so an
    // absent docker cannot read as a broken machine
    const mark = r.ok ? c.sage(g.ok) : r.info ? c.blue(g.dot) : c.red(g.err);
    const detail = r.ok || r.info ? c.dim(r.detail) : r.detail;
    console.log(`  ${mark} ${r.name.padEnd(width)}  ${detail}`);
    if (!r.ok && r.fix) {
      const arrow = r.info ? c.blue(g.arrow) : c.terracotta(g.arrow);
      console.log(`    ${arrow} ${r.fix}`);
    }
  }
  if (!d.exists("package.json")) {
    console.log(`\n  ${c.dim("not inside a borgo app, project checks skipped")}`);
  }
  const failed = results.filter(isFailure).length;
  const notes = results.filter((r) => !r.ok && r.info).length;
  const noted = notes ? c.dim(` (${notes} ${notes === 1 ? "note" : "notes"})`) : "";
  console.log(
    failed
      ? `\n  ${c.red(g.err)} ${failed} of ${results.length} checks failed${noted}\n`
      : `\n  ${c.sage(g.ok)} all ${results.length} checks passed${noted}\n`,
  );
  return failed ? 1 : 0;
}
