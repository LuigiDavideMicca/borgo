import { readFileSync, renameSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { c, g } from "./colors";
import { encodeChanged, goBinName, runBorgogen, UNKNOWN_CHANGE } from "./util";

const serverEntry = fileURLToPath(new URL("serve-entry.ts", import.meta.url));

/**
 * Batches file changes per side behind one debounce window.
 *
 * The window used to key only on the side and carry only the last file that
 * landed in it, so two saves 20 ms apart - a "Save All" over index.tsx and
 * about.tsx - rebuilt once and told the browser about one of them. The client
 * ignores an update naming a page other than the one on screen, so if the
 * survivor was the other file the edit you were looking at applied nothing and
 * logged nothing. Every file in the window rides the rebuild it caused.
 */
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

// content dedup for the watcher: windows delivers a straggler event for a
// write that was already rebuilt, and identical content must not trigger a
// second restart and reload. `forget` exists because a failed rebuild makes
// the dedup a trap - the file on disk is unchanged, so the save the user is
// told to make would be swallowed.
export function createContentDedup(read: (file: string) => Uint8Array | Buffer) {
  const lastSeen = new Map<string, string>();
  return {
    isUnchanged(file: string): boolean {
      try {
        const hash = String(Bun.hash(read(file)));
        if (lastSeen.get(file) === hash) return true;
        lastSeen.set(file, hash);
      } catch {
        // unreadable usually means deleted: forget the hash, or recreating the
        // file with identical content (git stash pop) would never rebuild
        lastSeen.delete(file);
      }
      return false;
    },
    forget() {
      lastSeen.clear();
    },
  };
}
// node_modules and .git are ignored at any depth (workspaces nest them);
// .borgo, public and dist are our own output dirs, ignored only at the root
// so an app dir that happens to share a name stays watched
const ignored = /(^|[\\/])(node_modules|\.git)([\\/]|$)|^(\.borgo|public|dist)([\\/]|$)|borgo\.gen\.go$/;

export async function dev() {
  // die with the launcher: a force-killed parent (terminal, task runner, test
  // harness) delivers no signal on windows, and an orphaned watcher would
  // keep the front server and the api alive on their ports forever
  const ppid = process.ppid;
  if (ppid > 1) {
    setInterval(() => {
      try {
        process.kill(ppid, 0);
      } catch {
        process.exit(0);
      }
    }, 2_000);
  }

  const goBin = `.borgo/${goBinName()}`;
  const goNext = `.borgo/next-${goBinName()}`;
  const frontPort = process.env.PORT || "3000";
  const apiPort = process.env.API_PORT || "3501";
  let goProc: Subprocess | null = null;
  let frontProc: Subprocess | null = null;
  let reload = false;

  // the front server owns the dev websocket; these endpoints let this
  // process trigger a css hot swap or a full reload in connected browsers.
  // it may be mid-restart, so keep knocking for a while
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

  // wait until the api actually accepts requests: a freshly built binary can
  // take a while to start listening (antivirus scans, slow disks), and
  // reloading the browser before that lands it on a dead backend
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

  // windows can deliver a straggler event for a write that was already
  // rebuilt; identical content must not trigger a second restart and reload
  const dedup = createContentDedup(readFileSync);

  // build to a scratch name while the old api keeps serving, swap only once
  // the binary is ready; windows can hold the old file briefly after exit
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
    // dedup on the build output: a torn read at event time poisons the
    // source-hash dedup and queues a second identical build - go builds are
    // deterministic, so an unchanged binary means no swap and no reload
    const nextHash = String(Bun.hash(readFileSync(goNext)));
    if (nextHash === liveGoHash && goProc && goProc.exitCode === null) return;
    liveGoHash = nextHash;
    // dropping the reference before killing marks this exit as ours, so the
    // watchdog below stays quiet about a restart we asked for
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
          // our own api was already killed to release its lock, so if the
          // rename still fails a stale process from a force-killed session
          // holds the binary — and the api is down until the user acts.
          // the advice is "save again", so the content dedup has to let that
          // save through: a plain ctrl+s writes identical bytes, and the
          // watcher would swallow it and leave the api down in silence
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
        // the api watches this pid and exits when the watcher dies, so a
        // force-killed session cannot leave a stale process on the binary
        BORGO_PARENT_PID: String(process.pid),
      },
    });
    goProc = proc;
    // an api that dies on its own - a panic, a failed bind, someone killing it
    // - is nobody's rebuild: without this the session keeps serving 502s and
    // says nothing until the next .go edit happens to restart it
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

  // a code change restarts the front server for a clean module graph; the
  // browser keeps its state and hot-applies the change when it reconnects
  const startFront = async (changed?: string[]) => {
    frontProc?.kill();
    await frontProc?.exited;
    // process.execPath, not "bun": a PATH lookup can resolve to a shim (npm
    // installs one) whose kill leaves the real server orphaned on the port
    const proc = Bun.spawn([process.execPath, serverEntry], {
      stdout: "inherit",
      stderr: "inherit",
      env: {
        // bun caps concurrent outbound fetches at 256, and every proxied /api
        // request - an event stream included - holds one for its whole life.
        // For a client that is a sensible default; for a proxy it is a ceiling
        // on how many streams the app can serve at once, hit silently. It has
        // to be in the environment at spawn: bun reads it when the process
        // starts, so assigning process.env later changes nothing. Kept
        // overridable, because the app may want a real limit.
        BUN_CONFIG_MAX_HTTP_REQUESTS: "16384",
        ...process.env,
        BORGO_DEV: "1",
        ...(reload ? { BORGO_RELOAD: "1" } : {}),
        ...(changed?.length ? { BORGO_CHANGED: encodeChanged(changed) } : {}),
        BORGO_PARENT_PID: String(process.pid),
      },
    });
    frontProc = proc;
    // hold the rebuild queue until the new server answers, so the fs noise
    // of its own boot lands inside the busy window instead of triggering a
    // second restart and a spurious reload
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

  // a css edit normally hot-swaps in place; if the front server is parked on
  // a build error (fallback marks its responses), restart it instead
  const swapCss = async (changed: string[]) => {
    const res = await notifyFront("css");
    if (res?.headers.get("x-borgo-fallback")) await startFront(changed);
  };

  await startGo();
  await startFront();
  reload = true;

  let queue = Promise.resolve();
  let busy = 0;

  // every side's rebuild, given the whole set of files that landed in its
  // window. the set is what the browser is told about: one file per rebuild
  // was how a "Save All" silently dropped the edit to the page on screen.
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
      // the watch buffer overflowed and events were lost; unless it was our
      // own rebuild writing, restart the front and force a full reload
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
  // also fires on crashes (uncaught exceptions), not just ctrl-c: the api
  // and front server must never outlive the watcher
  process.on("exit", () => {
    goProc?.kill();
    frontProc?.kill();
  });
}
