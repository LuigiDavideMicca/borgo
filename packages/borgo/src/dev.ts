import { mkdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { c, g } from "./colors";
import { isReused, parentGone, processStart, readParent, selfStart, watchParent, type StartToken } from "./parent-watch";
import {
  encodeChanged,
  frontTopology,
  goBinName,
  goFrontEnv,
  INTERNAL_KEY_HEADER,
  pickRenderPort,
  renderEnv,
  runBorgogen,
  UNKNOWN_CHANGE,
} from "./util";

const serverEntry = fileURLToPath(new URL("serve-entry.ts", import.meta.url));

// every file in the window rides the rebuild: the client ignores an update
// naming a page other than the one on screen, so the last file alone would
// silently drop a "Save All"
export function createChangeBatcher(
  delayMs: number,
  flush: (side: string, files: string[]) => void,
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, Set<string>>();
  return (file: string, side: string) => {
    let files = pending.get(side);
    if (!files) pending.set(side, (files = new Set()));
    files.add(file);
    const timer = timers.get(side);
    if (timer) clearTimeout(timer);
    timers.set(
      side,
      setTimeout(() => {
        timers.delete(side);
        pending.delete(side);
        flush(side, [...files]);
      }, delayMs),
    );
  };
}

// windows delivers a straggler event for a write already rebuilt. `forget`:
// after a failed rebuild the "save again" the user is told to make writes
// identical bytes, and the dedup would swallow it
export function createContentDedup(read: (file: string) => Uint8Array | Buffer) {
  const lastSeen = new Map<string, string>();
  return {
    isUnchanged(file: string): boolean {
      try {
        const hash = String(Bun.hash(read(file)));
        if (lastSeen.get(file) === hash) return true;
        lastSeen.set(file, hash);
      } catch {
        // deleted: forget, or recreating it with identical content (git stash
        // pop) would never rebuild
        lastSeen.delete(file);
      }
      return false;
    },
    forget() {
      lastSeen.clear();
    },
  };
}
// output dirs are ignored only at the root: an app dir sharing a name stays watched
export const ignored = /(^|[\\/])(node_modules|\.git)([\\/]|$)|^(\.borgo|public|dist)([\\/]|$)|(borgo|env)\.gen\.go$/;

// The app's own write targets, read from .gitignore: an app that stores
// uploads, a sqlite file or a cache inside its own directory storms this
// watcher - measured, twenty uploads overflowed the event queue, and an
// overflow forces a full rebuild that restarts the front server with
// requests in flight. .gitignore is already the list of "not source", so
// honouring it costs the app nothing to declare.
//
// Deliberately literal: a plain name (`uploads`, `tmp`) and a bare extension
// glob (`*.db`), nothing else. A watcher that half-understands gitignore's
// grammar would ignore a directory the developer is editing in, and silence
// is the one failure this must not have.
export function gitignoredMatcher(text: string): (file: string) => boolean {
  const roots = new Set<string>();
  const extensions = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const extension = /^\*(\.[A-Za-z0-9]+)$/.exec(line);
    if (extension) {
      extensions.add(extension[1].toLowerCase());
      continue;
    }
    if (line.includes("*") || line.includes("?") || line.includes("[")) continue;
    const name = line.replace(/^\//, "").replace(/\/+$/, "");
    if (!name || name.includes("/")) continue;
    roots.add(name);
  }
  if (!roots.size && !extensions.size) return () => false;
  return (file: string) => {
    const path = file.replaceAll("\\", "/");
    const first = path.split("/")[0];
    if (first && roots.has(first)) return true;
    const dot = path.lastIndexOf(".");
    return dot > 0 && extensions.has(path.slice(dot).toLowerCase());
  };
}

// which rebuild a changed file asks for. A .sql file is go's: migrations
// are embedded into the binary, so a new one applies only once the api is
// rebuilt (found by the verifier of phase 6)
export function watchedSide(file: string): "api" | "css" | "app" | null {
  if (/\.(go|sql)$/.test(file)) return "api";
  if (/\.(scss|css)$/.test(file)) return "css";
  if (/\.(tsx?|html)$/.test(file)) return "app";
  return null;
}

// every rebuild a changed file asks for: env.ts is the pages' environment
// and the source of the go side's env package, so it rebuilds both
export function rebuildSides(file: string): ("api" | "css" | "app")[] {
  const side = watchedSide(file);
  if (!side) return [];
  return file === "env.ts" ? [side, "api"] : [side];
}

// One dev session per directory. Two share public/assets and rename each
// other's chunks mid-build; the loser reports ENOENT on a file that existed
// a millisecond earlier, which reads as a bundler bug and is not one (found
// by an app that accumulated five of them). The port guard below catches the
// same-port case; this catches the rest.
export const DEV_LOCK = ".borgo/dev.lock";

// a session writes its own start into the lock: a live pid that started
// otherwise is the pid reused, not the session (isReused)
export function readDevLock(
  text: string,
  isAlive: (pid: number) => boolean,
  self: number,
  startOf: (pid: number) => StartToken | null,
): { pid: number; port: string; apiPort: string } | null {
  let held: { pid?: unknown; port?: unknown; apiPort?: unknown; start?: unknown };
  try {
    held = JSON.parse(text);
  } catch {
    return null; // a torn lock is not a session
  }
  if (typeof held.pid !== "number" || held.pid === self || !isAlive(held.pid)) return null;
  if (isReused(held.pid, held.start, startOf)) return null;
  return {
    pid: held.pid,
    port: String(held.port ?? "?"),
    apiPort: String(held.apiPort ?? "?"),
  };
}

// through the reading parent-watch already hardened, not a bare probe: a
// signal refused with EPERM means a process we may not touch, which is a
// LIVE one, and a bare try/catch reads that as dead. Uncertainty answers
// "alive" here for the same reason it does there - the expensive mistake is
// taking a directory another session is building in, not refusing one time
// too many. dev-parent-watch.test.ts pins the absence of the bare probe.
const pidAlive = (pid: number): boolean => !parentGone(pid, readParent(pid, false));

export async function dev() {
  // the launcher is a shell bun did not start, so bun's job object does not
  // reach this process: a force-killed terminal on windows delivers no signal
  // and this poll is the only thing that frees both ports. Windows never
  // reparents, so there a reused pid could read a stranger as the launcher:
  // left open on purpose - a pid came back after 740 spawns at the soonest
  // against ~180 processes created in the 2 s poll gap, and a wrong identity
  // check would kill a healthy session instead
  watchParent(process.ppid, () => process.exit(0));

  const goBin = `.borgo/${goBinName()}`;
  const goNext = `.borgo/next-${goBinName()}`;
  const frontPort = process.env.PORT || "3000";
  const apiPort = process.env.API_PORT || "3501";
  // go answers frontPort, the front server process is the render service on
  // its own loopback port, and both hold this boot's key. That port is the one
  // named or a free one, never a fixed default - where two projects' sessions
  // met. A named port that already answers is refused below, after the lock,
  // with the other two
  process.env.BORGO_RENDER_PORT = String(await pickRenderPort(process.env));
  const topology = frontTopology(process.env);
  // where the front server process actually listens, key included: this
  // orchestrator's own pokes (css, reload, readiness) go there directly and
  // never through the front - they are not the browser's to reach
  const renderBase = `http://127.0.0.1:${topology.renderPort}`;
  const renderHeaders: Record<string, string> = { [INTERNAL_KEY_HEADER]: topology.key };
  // the go front's internal listener, same key: what the browsers are told
  // goes there, and its dev channel tells them (dev_channel.go)
  const goBase = `http://127.0.0.1:${apiPort}`;
  let goProc: Subprocess | null = null;
  let frontProc: Subprocess | null = null;
  let reload = false;

  // before either port is touched: a session already in this directory is a
  // refusal whatever ports it holds, because the collision is the build
  // directory and not the socket
  try {
    const held = readDevLock(readFileSync(DEV_LOCK, "utf8"), pidAlive, process.pid, processStart);
    if (held) {
      console.error(
        `  ${c.red(g.err)} another borgo dev is already running in this directory` +
          ` ${c.dim(`${g.dot} pid ${held.pid}, ports ${held.port}/${held.apiPort}`)}\n` +
          `  two sessions share public/assets and rename each other's chunks mid-build.\n` +
          `  stop it, or if it is gone: delete ${DEV_LOCK}`,
      );
      process.exit(1);
    }
  } catch {
    // no lock, or an unreadable one: this session takes the directory
  }
  mkdirSync(".borgo", { recursive: true });
  writeFileSync(
    DEV_LOCK,
    JSON.stringify({ pid: process.pid, port: frontPort, apiPort, start: selfStart() }),
  );
  const dropLock = () => {
    try {
      // only ours: a session that replaced a stale lock must not delete the
      // live one that replaced it in turn
      const mine = readDevLock(readFileSync(DEV_LOCK, "utf8"), () => true, -1, () => null);
      if (mine?.pid === process.pid) unlinkSync(DEV_LOCK);
    } catch {}
  };
  process.on("exit", dropLock);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      dropLock();
      process.exit(0);
    });
  }

  // asked by answering, not by binding: windows SO_REUSEADDR semantics let a
  // second `borgo dev` bind an already-held port and print the full happy
  // banner - two sessions, undefined which one the browser reached, and the
  // only hint a misleading "stale api process" line (measured). a port that
  // ANSWERS http is a session; refuse before starting half of one
  for (const [port, name] of [
    [frontPort, "front server"],
    [apiPort, "api"],
    [String(topology.renderPort), "render service"],
  ] as const) {
    try {
      await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) });
    } catch {
      continue; // nothing answered: the port is ours
    }
    console.error(
      `  port ${port} already answers http - another dev session (or app) is the ${name} there.\n` +
        `  stop it, or run with ${name === "api" ? "API_PORT" : name === "render service" ? "BORGO_RENDER_PORT" : "PORT"}=<free port>. \`bunx borgo doctor\` names the holder.`,
    );
    process.exit(1);
  }

  // either process may be mid-restart: keep knocking. The render service
  // takes the css poke (it compiles); the go front takes what the browsers
  // are told
  const poke = async (base: string, path: string): Promise<Response | null> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        return await fetch(`${base}/__borgo/dev/${path}`, {
          method: "POST",
          headers: renderHeaders,
          signal: AbortSignal.timeout(2_000),
        });
      } catch {}
      await Bun.sleep(250);
    }
    return null;
  };
  const notifyFront = (path: string) => poke(renderBase, path);
  const notifyGo = (path: string) => poke(goBase, path);

  // a reload before the api listens lands the browser on a dead backend
  const apiReady = async (proc: Subprocess) => {
    const deadline = Date.now() + 30_000;
    let exited = false;
    proc.exited.then(() => (exited = true));
    while (Date.now() < deadline && !exited) {
      try {
        // with the key: a probe without it is logged by the internal listener as
        // a stranger refused, once per restart
        await fetch(`http://localhost:${apiPort}/`, { signal: AbortSignal.timeout(1_000), headers: renderHeaders });
        return true;
      } catch {}
      await Bun.sleep(100);
    }
    return false;
  };

  const dedup = createContentDedup(readFileSync);

  // build to a scratch name while the old api keeps serving; windows can hold
  // the old file briefly after exit
  let liveGoHash = "";
  const startGo = async () => {
    // checked like the cli's build checks it: a borgogen-only failure with
    // a clean go build restarted the api with STALE types - the drift the
    // generator exists to make impossible. the api keeps serving; the types
    // wait for the fix, and the line says which of the two is stale
    if (!(await runBorgogen({ fresh: true }))) {
      console.error(`  ${c.red(g.err)} code generation failed (api types or the go env package) - the api restarts, but generated code is stale until the next good save`);
    }
    const build = Bun.spawn(["go", "build", "-o", goNext, "."], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await build.exited) !== 0) {
      console.error(`  ${c.red(g.err)} go build failed, the previous api keeps serving...`);
      return;
    }
    // a torn read at event time poisons the source-hash dedup; go builds are
    // deterministic, so the binary is the reliable dedup
    const nextHash = String(Bun.hash(readFileSync(goNext)));
    if (nextHash === liveGoHash && goProc && goProc.exitCode === null) {
      // silence after "rebuilding api" read as a hang: say why nothing follows
      console.error(`  ${c.dim(`${g.dot} api binary unchanged - the running api keeps serving`)}`);
      return;
    }
    liveGoHash = nextHash;
    // dropping the reference before the kill marks this exit as ours
    const previous = goProc;
    goProc = null;
    previous?.kill();
    await previous?.exited;
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(goNext, goBin);
        break;
      } catch (error) {
        if (attempt >= 20) {
          // our api is already dead: a stale process holds the binary. The
          // dedup must let the "save again" through, it writes identical bytes
          dedup.forget();
          liveGoHash = "";
          console.error(
            `  ${c.red(g.err)} cannot replace ${goBin}: a stale api process still holds it.\n` +
              `  kill it (its name is "${goBinName().replace(/\.exe$/, "")}") and save again — the api is down until then.`,
          );
          return;
        }
        await Bun.sleep(100);
      }
    }
    const proc = Bun.spawn([goBin], {
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        ...goFrontEnv(topology),
        // this is borgo dev: as the front, go lets the browser's fast-refresh
        // channel through and keeps csrf off, like the front server always did
        BORGO_DEV: "1",
        ...(reload ? { BORGO_RELOAD: "1" } : {}),
        // the api watches this pid: a force-killed session leaves no stale process
        BORGO_PARENT_PID: String(process.pid),
      },
    });
    goProc = proc;
    // without this a go front that dies on its own leaves the port dark in silence
    proc.exited.then((code) => {
      if (goProc !== proc) return;
      goProc = null;
      // the gesture this message instructs is an editor save - which writes
      // identical bytes, which the content-hash dedup swallowed: the user
      // saved, nothing rebuilt, nothing said, and the api stayed dead
      // (measured). the stale-binary path above forgets for the same reason
      dedup.forget();
      liveGoHash = "";
      console.error(
        `  ${c.red(g.err)} the go front exited on its own (${code}) - the page is down until you save a file the api is built from (.go, .sql or env.ts) to rebuild and restart it`,
      );
    });
    const ready = await apiReady(proc);
    if (!ready) console.error(`  ${c.red(g.err)} api is not answering on :${apiPort}`);
    if (reload && ready) await notifyGo("reload");
  };

  // a restart for a clean module graph; the browser hot-applies on reconnect
  const startFront = async (changed?: string[]) => {
    // detached BEFORE the kill, as the api's restart does: the exit handler
    // below asks "am I still the render service?", and while frontProc still
    // pointed at the process being replaced the answer was yes - so every
    // hot restart printed "exited on its own (143)" for a kill this very line
    // had just sent, training the reader to ignore the one message that
    // means the render service really died
    const previous = frontProc;
    frontProc = null;
    previous?.kill();
    await previous?.exited;
    // not "bun": killing a PATH shim leaves the real server on the port
    const proc = Bun.spawn([process.execPath, serverEntry], {
      stdout: "inherit",
      stderr: "inherit",
      env: {
        // bun's fetch pool (default 256) is read at boot, and a proxied event
        // stream holds a slot for its whole life; overridable on purpose
        BUN_CONFIG_MAX_HTTP_REQUESTS: "16384",
        ...process.env,
        ...renderEnv(topology),
        BORGO_DEV: "1",
        ...(reload ? { BORGO_RELOAD: "1" } : {}),
        ...(changed?.length ? { BORGO_CHANGED: encodeChanged(changed) } : {}),
        BORGO_PARENT_PID: String(process.pid),
      },
    });
    frontProc = proc;
    // symmetric with the api's own-exit notice: the front dying on its own
    // was 28 seconds of silence under a "ready" banner (measured), healed
    // only by the next edit. the dedup forgets for the same reason the api
    // path does - the instructed gesture is a save of identical bytes
    proc.exited.then((code) => {
      if (frontProc !== proc) return;
      frontProc = null;
      dedup.forget();
      console.error(
        `  ${c.red(g.err)} the render service exited on its own (${code}) - pages answer 503 until you save any page or style to restart it`,
      );
    });
    // the fs noise of the boot must land inside the busy window
    const deadline = Date.now() + 30_000;
    let exited = false;
    proc.exited.then(() => (exited = true));
    while (Date.now() < deadline && !exited) {
      try {
        await fetch(`${renderBase}/healthz`, { headers: renderHeaders, signal: AbortSignal.timeout(1_000) });
        break;
      } catch {}
      await Bun.sleep(100);
    }
  };

  // a front server parked on a build error cannot hot-swap: restart it. A
  // swap that compiled is told to the browsers by the go front
  const swapCss = async (changed: string[]) => {
    const res = await notifyFront("css");
    if (res?.headers.get("x-borgo-fallback")) return startFront(changed);
    if (res?.ok) await notifyGo("css");
  };

  await startGo();
  await startFront();
  reload = true;

  let queue = Promise.resolve();
  let busy = 0;

  const rebuild: Record<string, (files: string[]) => Promise<void>> = {
    api: () => startGo(),
    css: (files) => swapCss(files),
    app: (files) => startFront(files),
  };

  const schedule = createChangeBatcher(100, (side, files) => {
    const named = files.map((f) => (f === UNKNOWN_CHANGE ? "(events lost)" : f)).join(", ");
    console.log(`  ${c.terracotta(g.change)} ${named} ${c.dim(`changed, rebuilding ${side}`)}`);
    // errors must not poison the chain, or every later rebuild is skipped
    queue = queue
      .then(async () => {
        busy++;
        try {
          await rebuild[side](files);
        } finally {
          setTimeout(() => busy--, 1_000);
        }
      })
      .catch((error) => console.error(error));
  });

  watch(".", { recursive: true }, (_, file) => {
    if (file && ignored.test(file)) return;
    if (!file) {
      // events lost: unless it was our own rebuild writing, force a full reload
      if (!busy) schedule(UNKNOWN_CHANGE, "app");
      return;
    }
    const normalized = file.replaceAll("\\", "/");
    const sides = rebuildSides(normalized);
    if (sides.length === 0) return;
    if (sides[0] !== "css" && dedup.isUnchanged(file)) return;
    for (const side of sides) schedule(normalized, side);
  });

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  // also fires on uncaught exceptions
  process.on("exit", () => {
    goProc?.kill();
    frontProc?.kill();
  });
}
