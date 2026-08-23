import { readFileSync, renameSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { c, g } from "./colors";
import { watchParent } from "./parent-watch";
import { encodeChanged, goBinName, runBorgogen, UNKNOWN_CHANGE } from "./util";

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
const ignored = /(^|[\\/])(node_modules|\.git)([\\/]|$)|^(\.borgo|public|dist)([\\/]|$)|borgo\.gen\.go$/;

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
  let goProc: Subprocess | null = null;
  let frontProc: Subprocess | null = null;
  let reload = false;

  // the front server may be mid-restart: keep knocking
  const notifyFront = async (path: string): Promise<Response | null> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        return await fetch(`http://localhost:${frontPort}/__borgo/dev/${path}`, {
          method: "POST",
          signal: AbortSignal.timeout(2_000),
        });
      } catch {}
      await Bun.sleep(250);
    }
    return null;
  };

  // a reload before the api listens lands the browser on a dead backend
  const apiReady = async (proc: Subprocess) => {
    const deadline = Date.now() + 30_000;
    let exited = false;
    proc.exited.then(() => (exited = true));
    while (Date.now() < deadline && !exited) {
      try {
        await fetch(`http://localhost:${apiPort}/`, { signal: AbortSignal.timeout(1_000) });
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
    await runBorgogen();
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
    if (nextHash === liveGoHash && goProc && goProc.exitCode === null) return;
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
        ...(reload ? { BORGO_RELOAD: "1" } : {}),
        // the api watches this pid: a force-killed session leaves no stale process
        BORGO_PARENT_PID: String(process.pid),
      },
    });
    goProc = proc;
    // without this an api that dies on its own serves 502s in silence
    proc.exited.then((code) => {
      if (goProc !== proc) return;
      goProc = null;
      console.error(
        `  ${c.red(g.err)} the api exited on its own (${code}) - save a .go file to rebuild and restart it`,
      );
    });
    const ready = await apiReady(proc);
    if (!ready) console.error(`  ${c.red(g.err)} api is not answering on :${apiPort}`);
    if (reload && ready) await notifyFront("reload");
  };

  // a restart for a clean module graph; the browser hot-applies on reconnect
  const startFront = async (changed?: string[]) => {
    frontProc?.kill();
    await frontProc?.exited;
    // not "bun": killing a PATH shim leaves the real server on the port
    const proc = Bun.spawn([process.execPath, serverEntry], {
      stdout: "inherit",
      stderr: "inherit",
      env: {
        // bun's fetch pool (default 256) is read at boot, and a proxied event
        // stream holds a slot for its whole life; overridable on purpose
        BUN_CONFIG_MAX_HTTP_REQUESTS: "16384",
        ...process.env,
        BORGO_DEV: "1",
        ...(reload ? { BORGO_RELOAD: "1" } : {}),
        ...(changed?.length ? { BORGO_CHANGED: encodeChanged(changed) } : {}),
        BORGO_PARENT_PID: String(process.pid),
      },
    });
    frontProc = proc;
    // the fs noise of the boot must land inside the busy window
    const deadline = Date.now() + 30_000;
    let exited = false;
    proc.exited.then(() => (exited = true));
    while (Date.now() < deadline && !exited) {
      try {
        await fetch(`http://localhost:${frontPort}/__borgo/dev`, { signal: AbortSignal.timeout(1_000) });
        break;
      } catch {}
      await Bun.sleep(100);
    }
  };

  // a front server parked on a build error cannot hot-swap: restart it
  const swapCss = async (changed: string[]) => {
    const res = await notifyFront("css");
    if (res?.headers.get("x-borgo-fallback")) await startFront(changed);
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
    if (file.endsWith(".go")) {
      if (dedup.isUnchanged(file)) return;
      schedule(normalized, "api");
    } else if (/\.(scss|css)$/.test(file)) schedule(normalized, "css");
    else if (/\.(tsx?|html)$/.test(file)) {
      if (dedup.isUnchanged(file)) return;
      schedule(normalized, "app");
    }
  });

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  // also fires on uncaught exceptions
  process.on("exit", () => {
    goProc?.kill();
    frontProc?.kill();
  });
}
