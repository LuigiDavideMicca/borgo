import { readFileSync } from "node:fs";

// WHAT A DEAD PARENT LOOKS LIKE, ON THE PROCESSES THAT SUPERVISE.
//
// `try { process.kill(pid, 0) } catch { exit(0) }` was wrong in BOTH directions
// at once, in dev.ts, cli.ts and serve-entry.ts, and the two are opposites.
// Measured:
//
//   - linux: kill(pid, 0) SUCCEEDS on a process that has exited and whose
//     status nobody collected - a corpse keeps its pid and keeps accepting
//     signals (wsl2: state Z in /proc, kill 0 = OK). Read as alive, the watcher
//     outlives the launcher and holds the go binary and both ports forever,
//     which is the orphan this watch exists to prevent.
//   - windows: process.kill throws EPERM for a live process this one may not
//     open - pid 4 does it here - and so does a posix parent that changed
//     credentials (`sudo -u app borgo dev`). Read as death, it takes the user's
//     whole session down under a perfectly healthy launcher.
//
// Uncertainty answers ALIVE. Only "no such process" is certainty of death;
// EPERM is a live process out of reach; the corpse is read from /proc/<pid>/stat
// rather than inferred from a signal, and where there is no /proc the answer
// degrades to the signal alone - exactly what the three sites did before, so no
// platform gate is needed. The direct branch is the certainty a recycled pid
// cannot forge: reparenting happens at the parent's EXIT, not at its reap,
// measured with a real three-generation fork where the grandchild's ppid had
// already moved off a parent still reading Z and still accepting kill 0.
//
// This module imports node:fs and nothing else, on purpose: cli.ts imports it
// lazily on the re-exec branch and a bare `borgo` outside a project must keep
// working, which rules out anything that reaches ./server and the app's react.
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

/**
 * The line printed once, at boot, when the pid in the env is not this
 * process's parent: a hand-set BORGO_PARENT_PID / BORGO_SUPERVISOR_PID is
 * accepted - the pid watched is the env's, never the parent's - but it turns
 * the reparent branch off on every platform at once, and whoever set it should
 * learn that here rather than from an orphan. Null when pid == ppid, so the
 * normal boot prints nothing. Called after the boot probe, never before: a pid
 * already gone exits silently, and is not also reported as a mismatch.
 */
export function describeParentMismatch(parentPid: number, ppid: number, name = "BORGO_PARENT_PID"): string | null {
  if (parentPid === ppid) return null;
  return `${name}=${parentPid} is not this process's parent (${ppid}): the reparent branch is off, only the probe is watching`;
}

/**
 * Polls until the process named by parentPid is gone, then calls onGone.
 *
 * `direct` is captured once, at boot, while the parent is still there to be
 * recognised: recomputing it inside the interval would make it false the moment
 * reparenting happened, which is exactly when it has to be true. A pid of 1 or
 * less is not watched - on posix that is where an orphan is reparented TO, so
 * watching it could never answer, and 0/NaN is an unset or malformed variable.
 */
export function watchParent(
  parentPid: number,
  onGone: () => void,
  intervalMs = 2_000,
  name = "BORGO_PARENT_PID",
): ReturnType<typeof setInterval> | null {
  if (!(parentPid > 1)) return null;
  const direct = process.ppid === parentPid;
  // probe first, as serve-entry and the go side do: a pid already gone is the
  // first tick's exit, not a mismatch to report on the way there
  const mismatch = describeParentMismatch(parentPid, process.ppid, name);
  if (mismatch && !parentGone(parentPid, readParent(parentPid, direct))) console.error(mismatch);
  return setInterval(() => {
    if (parentGone(parentPid, readParent(parentPid, direct))) onGone();
  }, intervalMs);
}
