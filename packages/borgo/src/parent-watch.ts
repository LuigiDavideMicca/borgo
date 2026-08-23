import { readFileSync } from "node:fs";

// uncertainty answers ALIVE. A bare `process.kill(pid, 0)` is wrong both ways:
// on linux it succeeds on an unreaped zombie (the watcher then outlives the
// launcher and holds the go binary and both ports), on windows it throws EPERM
// for a live process this one may not open (pid 4), as for a posix parent that
// changed credentials. So EPERM is alive, the corpse is read from /proc, and
// ppid moving off the parent (at its exit, before the reap) is the one answer a
// recycled pid cannot forge. Off linux there is no /proc: the signal decides.
//
// imports node:fs and nothing else: cli.ts loads this lazily and a bare `borgo`
// outside a project must not reach ./server and the app's react
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
  // EPERM on purpose: a corpse keeps the credentials that refused the signal
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
  // comm (field 2) is unescaped: "my prog (x)" defeats any split on whitespace
  // or on the first ")"
  const close = stat.lastIndexOf(")");
  if (close < 0) return false;
  const state = stat.slice(close + 1).trimStart().charAt(0);
  // X and x: the moment after Z, while it is torn down
  return state === "Z" || state === "X" || state === "x";
}

export function parentGone(parentPid: number, reading: ParentReading): boolean {
  // windows never reparents: there the probe below is the whole answer
  if (reading.direct && reading.ppid !== parentPid) return true;
  if (reading.killError !== null && reading.killError !== "EPERM") return true;
  return isCorpse(reading.stat);
}

// a hand-set pid is watched as given, but it turns the reparent branch off on
// every platform: say so once at boot rather than let an orphan say it
export function describeParentMismatch(parentPid: number, ppid: number, name = "BORGO_PARENT_PID"): string | null {
  if (parentPid === ppid) return null;
  return `${name}=${parentPid} is not this process's parent (${ppid}): the reparent branch is off, only the probe is watching`;
}

// `direct` is captured once at boot: recomputed in the interval it would turn
// false the moment reparenting happened, exactly when it has to be true. pid 1
// is where orphans are reparented TO, 0/NaN an unset variable: neither watched
export function watchParent(
  parentPid: number,
  onGone: () => void,
  intervalMs = 2_000,
  name = "BORGO_PARENT_PID",
): ReturnType<typeof setInterval> | null {
  if (!(parentPid > 1)) return null;
  const direct = process.ppid === parentPid;
  // a pid already gone is the first tick's exit, not a mismatch to report
  const mismatch = describeParentMismatch(parentPid, process.ppid, name);
  if (mismatch && !parentGone(parentPid, readParent(parentPid, direct))) console.error(mismatch);
  return setInterval(() => {
    if (parentGone(parentPid, readParent(parentPid, direct))) onGone();
  }, intervalMs);
}
