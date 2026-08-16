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

// the nearest existing ancestor of dir, since borgo creates these directories
// on demand: what fails a read-only checkout is the mkdir, and that is the
// parent's permission
export function probeTarget(dir: string, exists: (path: string) => boolean): string {
  let target = dir;
  while (target && !exists(target)) {
    const parent = dirname(target);
    if (parent === target) break;
    target = parent;
  }
  return target || ".";
}

/**
 * Whether the probe file could be written. That question only.
 *
 * It used to be `write; remove; return "ok"` inside one try, so a directory
 * that took the write and refused the delete answered "denied" - the diagnosis
 * of a read-only checkout, printed for a machine that writes perfectly well,
 * and doctor exits 1 on it. Measured on windows with delete denied by ACL:
 * "denied", and `.borgo-doctor-<pid>` still sitting there afterwards, which is
 * itself the proof the write had worked.
 *
 * So the removal moves to a finally and stops being evidence. A check that
 * writes to find out whether it can write cleans up on every branch, including
 * the one where it decides the answer is no.
 */
export function probeWriteWith(
  probe: string,
  write: (path: string) => void,
  remove: (path: string) => void,
): "ok" | "denied" {
  try {
    write(probe);
    return "ok";
  } catch {
    return "denied";
  } finally {
    // a probe that cannot be removed is not the caller's answer, and throwing
    // from here would replace it
    try {
      remove(probe);
    } catch {}
  }
}

// what the probe writes, so a residue can be identified by reading it rather
// than by trusting its name
export const PROBE_MARK = "borgo doctor write probe\n";

const PROBE_NAME = /^\.borgo-doctor-[0-9]+$/;

/**
 * Residues of runs killed between the write and the removal. The window is two
 * adjacent syscalls - 333 us against a 679 ms doctor - but a residue never
 * heals, because the name carries the pid. Measured for one left in
 * public/assets: buildAssetIndex serves it at a public url, and `borgo export`
 * copies it into dist/site and counts it as an asset.
 *
 * A diagnostic removes only what it can prove it wrote, and this one runs in
 * the user's project: exact name, whole content equal to the mark, and only in
 * a directory doctor was already writing into. Anything else is left alone,
 * including the empty residues older versions wrote.
 */
export function sweepProbes(
  dir: string,
  names: string[],
  read: (path: string) => string | null,
  remove: (path: string) => void,
): string[] {
  const swept: string[] = [];
  for (const name of names) {
    if (!PROBE_NAME.test(name)) continue;
    const path = join(dir, name);
    if (read(path) !== PROBE_MARK) continue;
    try {
      remove(path);
      swept.push(path);
    } catch {}
  }
  return swept;
}

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
  // the pid stays in the name: measured on windows, two doctors sharing one
  // fixed name collide on the write with EPERM - the same code a real denial
  // raises - 96 times in 3000, which is a read-only checkout reported for a
  // directory that writes perfectly well
  probeWrite: (dir) => {
    const target = probeTarget(dir, existsSync);
    const answer = probeWriteWith(
      join(target, `.borgo-doctor-${process.pid}`),
      (path) => writeFileSync(path, PROBE_MARK),
      unlinkSync,
    );
    sweepProbes(
      target,
      (() => {
        try {
          return readdirSync(target);
        } catch {
          return [];
        }
      })(),
      (path) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return null;
        }
      },
      unlinkSync,
    );
    return answer;
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

// the comparators that put a floor under a range. Anything else is either a
// ceiling or a form with no single floor at all, and both are refused by name
// rather than read for whichever number appears first in them.
export const SUPPORTED_RANGES = ">=1.3.0, >1.3.0, ^1.3.0, ~1.3.0 or 1.3.0, optionally followed by an upper bound";

/**
 * The lowest version a range admits, or null when it declares no floor we read.
 *
 * This used to be `parseVersion` over the whole string, which returns the first
 * version it can find and never looks at what is in front of it. So `"<1.5.0"`
 * - a *ceiling*, the app saying it cannot run on 1.5 yet - was read as "at
 * least 1.5.0", and `borgo doctor` exited 1 on a machine whose bun was exactly
 * what the app asked for. A comparator borgo cannot read is refused out loud
 * instead: an unread range must not become a requirement nobody wrote.
 *
 * A hyphen range ("1.2.3 - 2.0.0") and a two-comparator range (">=1.3.2 <2")
 * both begin with their floor, which is why the first token is the one read.
 */
export function declaredFloor(range: string): string | null {
  // an alternation's floor is the lowest of its branches, not the first one
  // written: "^2 || ^1.2" read left to right would fail every machine the app
  // is happy on. Refused rather than half-read.
  if (range.includes("||")) return null;
  const first = range.trim().split(/\s+/)[0] ?? "";
  const m = first.match(/^(?:>=|>|\^|~|=)?v?(\d+)\.(\d+)(?:\.(\d+))?$/);
  // ">1.4.2" admits 1.4.3 and not 1.4.2, and is read as a floor of 1.4.2: the
  // one version of error it can produce is a green check on the exact release
  // the app excluded, where reading it as no floor at all drops the whole
  // declaration
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3] ?? 0)}` : null;
}

// the app may ask for a newer bun than the framework does; it may not ask for
// an older one. a declared floor below borgo's is not a relaxation, it is a
// green check on a bun that `borgo build` will fail on, so the higher of the
// two wins.
export function bunMinimum(d: DoctorEnv): { min: string; source: string; unreadable?: string } {
  const engines = packageJson(d)?.engines as { bun?: string } | undefined;
  const declared = typeof engines?.bun === "string" ? engines.bun.trim() : "";
  if (!declared) return { min: MIN_BUN, source: "borgo" };
  const floor = declaredFloor(declared);
  if (!floor) {
    return {
      min: MIN_BUN,
      source: "borgo",
      unreadable: `engines.bun is "${declared}", which borgo does not read as a minimum`,
    };
  }
  if (!versionAtLeast(floor, MIN_BUN)) return { min: MIN_BUN, source: "borgo" };
  return { min: floor, source: "package.json engines.bun" };
}

// a declared range borgo could not read is a note, not a failure: the machine
// is fine, the check simply fell back to borgo's own minimum, and the operator
// is the only one who can say whether that is what they meant
export function checkEnginesBun(d: DoctorEnv): Check | null {
  const { unreadable } = bunMinimum(d);
  if (!unreadable) return null;
  return {
    name: "engines.bun",
    ok: false,
    info: true,
    detail: `${unreadable} ${g.dot} checked against borgo's own ${MIN_BUN} instead`,
    fix: `write it as one of: ${SUPPORTED_RANGES}`,
  };
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

// the images `borgo dev` and `borgo start` run under: the bun front server,
// and the go api binary, which is `api` in dev (.borgo/api) and dist/api in a
// build. lsof truncates long command names, so these are compared as the short
// image names both platforms report.
const OWN_IMAGES = new Set(["bun", "api", "borgo"]);

/**
 * Whether the holder of a port *could* be one of ours, by image name alone.
 *
 * It cannot be more than that, and the old name (`isOwnProcess`) claimed it
 * was. Every bun on the machine is called bun: a scratch script holding :3000
 * matched, doctor called it "in use by borgo itself", filed it as a note and
 * exited 0 - on a machine where `borgo dev` cannot bind. The one command that
 * exists to say what is in the way said nothing was.
 *
 * What a port check verifies is that the port is taken and which image took
 * it. It does not verify who started that image, so nothing downstream may
 * assert it: this decides which *advice* to print, never whether the occupied
 * port counts.
 */
export function looksLikeOwnImage(image: string): boolean {
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
  // an occupied port is a failure whoever holds it, because `borgo dev` cannot
  // bind it either way. Recognising the image is worth a line of advice and
  // nothing else - printed as the condition it is ("if that is your own"),
  // never as a fact about a process doctor never identified.
  const advice = looksLikeOwnImage(holder.name)
    ? `nothing to fix if that is your own borgo ${g.dot} otherwise ${kill}`
    : kill;
  return {
    name,
    ok: false,
    detail: `in use by ${holder.name} (pid ${holder.pid})`,
    fix: `${advice} ${g.dot} or set ${envVar} to another port`,
  };
}

/**
 * The port a variable asks for, or null when it does not name one.
 *
 * `Number(d.env.PORT || 3000)` was handed straight to net.listen, so `PORT=abc`
 * did not print "port NaN" - it threw ERR_INVALID_ARG_VALUE out of doctor and
 * killed the run with a stack trace, and `PORT=70000` did the same with a
 * RangeError. A diagnostic dying on the environment it was asked to diagnose
 * reports nothing at all.
 *
 * 0 is refused with them: it binds, so the check read "port 0 free", but it
 * names no port - `borgo dev` passes it through and then waits forever on
 * localhost:0 for a server that bound something random.
 */
export function resolvePort(raw: string | undefined, fallback: number): number | null {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export async function checkPortSetting(
  d: DoctorEnv,
  envVar: string,
  fallback: number,
  label: string,
): Promise<Check> {
  const raw = d.env[envVar];
  const port = resolvePort(raw, fallback);
  if (port === null) {
    return {
      name: `port (${label})`,
      ok: false,
      detail: `${envVar} is ${JSON.stringify(raw)}, which is not a port between 1 and 65535`,
      fix: `set ${envVar} to a port number, or unset it to use ${fallback}`,
    };
  }
  return checkPort(d, port, label, envVar);
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
    // What the probe establishes is that the file will not open for writing
    // right now. Not what holds it: openForWrite calls every error but ENOENT
    // "busy", so an antivirus, a sync client, a backup agent and a lost write
    // permission all arrive here looking exactly like a running api.
    //
    // It used to read `locked by a running "api" process, dev cannot swap in
    // a new build`, and both halves went past that evidence. The second was
    // false in the commonest case: during a healthy `borgo dev` the holder is
    // dev's own api, which dev kills before the rename and then retries for
    // two seconds - so doctor printed red and exited 1 over a session that
    // was working. Windows only by the guard above, so there is no other
    // platform to branch on.
    //
    // A note, not a failure, and for the reason opposite to the ports above:
    // there an occupied port stops `borgo dev` whoever holds it, so the
    // verified fact is itself the failure. Here the verified fact stops
    // nothing on its own, and whether it stops anything at all is exactly
    // what this check cannot see.
    return {
      name,
      ok: false,
      info: true,
      detail: `${bin} cannot be opened for writing`,
      fix: `nothing to fix if borgo dev is running ${g.dot} otherwise something still holds it: taskkill /F /IM ${image}`,
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
  const results: Array<Check | null> = [
    // toolchain
    checkBun(d),
    checkBunShim(d),
    checkEnginesBun(d),
    checkGo(d),
    checkNode(d),
    checkDocker(d),
    // machine
    await checkPortSetting(d, "PORT", 3000, "front"),
    await checkPortSetting(d, "API_PORT", 3501, "api"),
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
