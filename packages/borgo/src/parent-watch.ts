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

// when a process started, as a token compared only with another token read
// the same way: a pid alone names whoever holds it now, and windows hands a
// freed one to the next process within minutes (a dev lock outlived its
// session and was read as wslhost's, found while closing phase 7). Linux
// counts clock ticks after boot, which no change of the wall clock moves; an
// epoch time from btime would move with every step of the clock and read a
// live holder as a stranger (found by the verifier of that fix). Elsewhere
// the start is the stored epoch time, which a later step does not move either
export type StartToken = { clock: "ticks" | "ms"; value: number };

// how late an epoch reading of another process may come out: ps truncates
// its elapsed time to the second
const MS_SLACK = 2_000;

// whether the process holding a pid now started after the one a lock
// recorded. Ticks are exact. An epoch start is one-sided: the recorded one
// is read from inside the process, after the runtime came up - seconds after
// its creation on a loaded machine (measured: 2.1 s under 32 busy loops on 8
// cores, found by the verifier) - so it can only be late, and a pid reused
// started after the holder died, which is after it recorded anything. A
// start read earlier than the recorded one, by any amount, is the holder
export function startedAfter(now: StartToken, recorded: StartToken): boolean {
  // two clocks cannot be compared: the answer that keeps refusing
  if (now.clock !== recorded.clock) return false;
  return now.clock === "ticks" ? now.value !== recorded.value : now.value > recorded.value + MS_SLACK;
}

// a live pid is a lock's holder unless the start the lock recorded says
// otherwise. A start that cannot be told, or a lock without one, keeps the
// answer that refuses: the holder
export function isReused(pid: number, recorded: unknown, startOf: (pid: number) => StartToken | null): boolean {
  const ok =
    typeof recorded === "object" &&
    recorded !== null &&
    ((recorded as StartToken).clock === "ticks" || (recorded as StartToken).clock === "ms") &&
    typeof (recorded as StartToken).value === "number";
  if (!ok) return false;
  const now = startOf(pid);
  return now !== null && startedAfter(now, recorded as StartToken);
}

// this process's own, without spawning anything
export function selfStart(): StartToken {
  if (process.platform === "linux") {
    try {
      const ticks = ticksFromProcStat(readFileSync("/proc/self/stat", "utf8"));
      if (ticks !== null) return { clock: "ticks", value: ticks };
    } catch {}
  }
  return { clock: "ms", value: Date.now() - process.uptime() * 1000 };
}

// another process's, or null when it cannot be told: windows asks
// powershell, macOS asks ps for the elapsed time - slow, so asked only when
// a lock names a live pid, and bounded, since a hang would hang borgo dev
// before it printed anything
export function processStart(pid: number): StartToken | null {
  try {
    if (process.platform === "linux") {
      const ticks = ticksFromProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      return ticks === null ? null : { clock: "ticks", value: ticks };
    }
    if (process.platform === "win32") {
      const out = Bun.spawnSync(
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`,
        ],
        { stdout: "pipe", stderr: "ignore", timeout: 10_000 },
      );
      const ms = Number(out.stdout.toString().trim());
      return out.exitCode === 0 && Number.isFinite(ms) && ms > 0 ? { clock: "ms", value: ms } : null;
    }
    // read before the spawn: the elapsed time is truncated to a second, and
    // the start it gives can only come out earlier than the true one
    const now = Date.now();
    const out = Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    const elapsed = out.exitCode === 0 ? parseEtime(out.stdout.toString()) : null;
    return elapsed === null ? null : { clock: "ms", value: now - elapsed };
  } catch {
    return null;
  }
}

// field 22 of /proc/<pid>/stat: the start in clock ticks after boot
export function ticksFromProcStat(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  // fields after comm start at field 3
  const ticks = Number(stat.slice(close + 1).trim().split(/\s+/)[22 - 3]);
  return Number.isInteger(ticks) ? ticks : null;
}

// ps's etime: [[dd-]hh:]mm:ss
export function parseEtime(text: string): number | null {
  const m = text.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d = "0", h = "0", min, s] = m;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)) * 1000;
}
