import { readFileSync } from "node:fs";
import { serve } from "./server";
import { resolveSwitches } from "./util";

// EVERY SWITCH, ONCE, ABOVE THE TRY - not just BORGO_DEV.
//
// One reading is used by the boot and by the catch alike: a process that starts
// in one mode and then decides whether a build error kills it or is served as a
// page in the other is a defect of its own. And it happens HERE because the
// catch below deliberately BINDS A PORT: a value borgo refuses must fail the
// boot, not be re-thrown from inside the handler that exists to serve failures
// and answered from a listening socket with fewer security headers than a
// server that had accepted it. That held for BORGO_DEV alone while BORGO_CSP,
// BORGO_CSRF, BORGO_METRICS, BORGO_RELOAD, BORGO_SECURITY_HEADERS and
// SESSION_SECURE were all read inside serve(). resolveSwitches has the measured
// account.
const switches = resolveSwitches(process.env);
const dev = switches.dev;

// WHAT A DEAD PARENT LOOKS LIKE, AND WHAT A LIVE ONE OUT OF REACH LOOKS LIKE.
//
// `try { process.kill(pid, 0) } catch { exit(0) }` was wrong in BOTH directions
// at once, and the two are opposites. Measured, not reasoned:
//
//   - on linux, kill(pid, 0) SUCCEEDS on a process that has exited and whose
//     status nobody collected: a corpse keeps its pid and keeps accepting
//     signals. Read as alive, the front server outlives the dev session that
//     started it and holds the port forever - the orphan this watch exists to
//     prevent. (measured on wsl2: state Z in /proc, kill 0 = OK.)
//   - on windows, kill(pid, 0) throws EPERM for a live process this one may not
//     open - pid 4 does it here, and so would a supervisor at a different
//     elevation or an EDR hooking the call. Read as dead, the watch shut the
//     user's front server down mid-session under a perfectly healthy parent.
//
// The rule is watchdog_unix.go's, stated from this side: uncertainty answers
// ALIVE. Only a probe that says "no such process" is certainty of death; EPERM
// is a live process out of reach, exactly as the go side reads EPERM and
// ERROR_ACCESS_DENIED. The corpse is read from /proc/<pid>/stat rather than
// inferred from a signal, and where there is no /proc the answer degrades to
// the signal alone - which is what this file did before, so no platform gate is
// needed to add a branch whose only effect is on the platform it works on.
export type ParentReading = {
  /** parentPid was this process's parent when the watch started */
  direct: boolean;
  ppid: number;
  /** the code process.kill(pid, 0) threw, or null when it succeeded */
  killError: string | null;
  /** /proc/<pid>/stat, or null off linux and for a pid that is gone */
  stat: string | null;
};

export function readParent(parentPid: number, direct: boolean): ParentReading {
  let killError: string | null = null;
  try {
    process.kill(parentPid, 0);
  } catch (error) {
    killError = (error as { code?: string }).code ?? "UNKNOWN";
  }
  // EPERM included on purpose: a corpse keeps the credentials that refused the
  // signal, and /proc is readable regardless of them
  let stat: string | null = null;
  if (killError === null || killError === "EPERM") {
    try {
      stat = readFileSync(`/proc/${parentPid}/stat`, "utf8");
    } catch {}
  }
  return { direct, ppid: process.ppid, killError, stat };
}

export function isCorpse(stat: string | null): boolean {
  if (!stat) return false;
  // field 2 is the comm, in parentheses and UNESCAPED, so a process called
  // "my prog (x)" defeats any split on whitespace or on the first ")": only the
  // last one is certainly the closing one
  const close = stat.lastIndexOf(")");
  if (close < 0) return false;
  const state = stat.slice(close + 1).trimStart().charAt(0);
  // Z is a corpse; X and x are the moment after, while it is torn down
  return state === "Z" || state === "X" || state === "x";
}

export function parentGone(parentPid: number, reading: ParentReading): boolean {
  // reparenting happens at the parent's EXIT, not at its reap - measured on
  // linux, where the child's getppid had already changed while the parent still
  // read as Z. It is also the one answer a recycled pid cannot forge. Windows
  // never reparents, so this branch never fires there and the probe below is
  // the whole answer.
  if (reading.direct && reading.ppid !== parentPid) return true;
  if (reading.killError !== null && reading.killError !== "EPERM") return true;
  return isCorpse(reading.stat);
}

// import.meta.main, so that the readings above can be imported and asserted
// without this module booting a server as a side effect of the import. dev.ts
// spawns this file as the entry point (bun <path>), where it is true.
if (import.meta.main) {
  // die with the watcher: a force-killed dev session delivers no signal, and an
  // orphaned front server would hold the port forever. That is measured on
  // posix; on windows it is defence in depth rather than the only defence, because
  // bun puts a spawned child in a job object that takes it down with the parent
  // - taskkill /F on a `borgo dev` shaped parent left no child behind here.
  const parentPid = Number(process.env.BORGO_PARENT_PID || 0);
  if (parentPid > 1) {
    // read once, at boot, while the parent is still there to be recognised
    const direct = process.ppid === parentPid;
    setInterval(() => {
      if (parentGone(parentPid, readParent(parentPid, direct))) process.exit(0);
    }, 2_000);
  }

  try {
    await serve({ dev, switches });
  } catch (error) {
    if (!dev) throw error;
    // a broken build must not take the port down: serve the error instead, keep
    // the dev channel alive, and the next successful rebuild reloads the browser
    console.error(error);
    const { overlayHtml } = await import("./overlay");
    const port = Number(process.env.PORT || 3000);
    const stamp = Date.now();
    const sockets = new Set<import("bun").ServerWebSocket<undefined>>();
    let server: import("bun").Server<undefined>;
    // the original failure may have been the port itself: the fallback would
    // then rethrow the same EADDRINUSE, unhandled and without a hint
    try {
      server = Bun.serve<undefined, never>({
        port,
        websocket: {
          open(ws) {
            sockets.add(ws);
            ws.send(JSON.stringify({ type: "js", file: process.env.BORGO_CHANGED ?? "(build)", chunks: {}, stamp }));
          },
          close(ws) {
            sockets.delete(ws);
          },
          message() {},
        },
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/__borgo/dev" && server.upgrade(req)) return undefined as never;
          if (req.method === "POST" && url.pathname.startsWith("/__borgo/dev/")) {
            if (url.pathname.endsWith("/reload")) {
              const data = JSON.stringify({ type: "reload" });
              for (const ws of sockets) ws.send(data);
            }
            return new Response(null, { status: 204, headers: { "x-borgo-fallback": "1" } });
          }
          return new Response(overlayHtml(error), {
            status: 500,
            headers: { "Content-Type": "text/html; charset=utf-8", "x-borgo-fallback": "1" },
          });
        },
      });
    } catch (fallbackError) {
      if ((fallbackError as { code?: string }).code === "EADDRINUSE") {
        console.error(`port ${port} is in use - stop whatever holds it (borgo doctor names it) or set PORT`);
        process.exit(1);
      }
      throw fallbackError;
    }
  }
}
