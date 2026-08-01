import { readFileSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { median } from "./stats";
import { run } from "./proc";
import type { MemoryResult } from "./types";

export interface ProcessSample {
  pid: number;
  ppid: number;
  rssBytes: number;
  command: string;
}

/**
 * RSS of a process *tree*, because a borgo app is two processes (the Bun front
 * server and the Go API binary) and charging it only for one would be a lie in
 * our favour. Next.js in production is also more than one process.
 */
export async function sampleTree(rootPid: number): Promise<ProcessSample[]> {
  const all = await sampleAll();
  const byParent = new Map<number, ProcessSample[]>();
  for (const proc of all) {
    const siblings = byParent.get(proc.ppid) ?? [];
    siblings.push(proc);
    byParent.set(proc.ppid, siblings);
  }
  const out: ProcessSample[] = [];
  const seen = new Set<number>();
  const walk = (pid: number) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    const self = all.find((p) => p.pid === pid);
    if (self) out.push(self);
    for (const child of byParent.get(pid) ?? []) walk(child.pid);
  };
  walk(rootPid);
  return out;
}

export const treeRss = (samples: ProcessSample[]): number => samples.reduce((sum, p) => sum + p.rssBytes, 0);

async function sampleAll(): Promise<ProcessSample[]> {
  if (process.platform === "win32") return sampleWindows();
  if (process.platform === "linux") return sampleLinux();
  return samplePs();
}

async function sampleWindows(): Promise<ProcessSample[]> {
  // WorkingSetSize is the Windows analogue of RSS: resident physical bytes.
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name | ConvertTo-Json -Compress";
  const res = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  if (res.code !== 0) throw new Error(`could not enumerate processes: ${res.stderr.trim()}`);
  const parsed = JSON.parse(res.stdout) as
    | { ProcessId: number; ParentProcessId: number; WorkingSetSize: number; Name: string }[]
    | { ProcessId: number; ParentProcessId: number; WorkingSetSize: number; Name: string };
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((r) => ({
    pid: r.ProcessId,
    ppid: r.ParentProcessId,
    rssBytes: Number(r.WorkingSetSize) || 0,
    command: r.Name,
  }));
}

function sampleLinux(): ProcessSample[] {
  const out: ProcessSample[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isFinite(pid)) continue;
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0);
      // VmRSS is in kB
      const rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
      const name = /^Name:\s+(.*)$/m.exec(status)?.[1] ?? String(pid);
      out.push({ pid, ppid, rssBytes: rssKb * 1024, command: name });
    } catch {
      // the process exited between readdir and read - normal, skip it
    }
  }
  return out;
}

async function samplePs(): Promise<ProcessSample[]> {
  const res = await run(["ps", "-Ao", "pid=,ppid=,rss=,comm="], { cwd: process.cwd(), timeoutMs: 30_000 });
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, rss, ...rest] = line.split(/\s+/);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        // ps reports rss in kB
        rssBytes: Number(rss) * 1024,
        command: rest.join(" "),
      };
    })
    .filter((p) => Number.isFinite(p.pid));
}

/**
 * A single RSS reading is noise: allocators grow lazily and GCs land where they
 * land. We take a handful of samples over a settle window and report the median.
 */
export async function settledRss(rootPid: number, opts: { samples?: number; intervalMs?: number } = {}): Promise<{ rss: number; processes: ProcessSample[] }> {
  const samples = opts.samples ?? 6;
  const interval = opts.intervalMs ?? 500;
  const readings: number[] = [];
  let last: ProcessSample[] = [];
  for (let i = 0; i < samples; i++) {
    last = await sampleTree(rootPid);
    readings.push(treeRss(last));
    if (i < samples - 1) await Bun.sleep(interval);
  }
  return { rss: median(readings), processes: last };
}

/**
 * Waits for RSS to stop moving before treating it as "idle".
 *
 * A freshly booted runtime is still growing, and a runtime that has just been
 * hammered is still shrinking; sampling either one immediately produces a
 * baseline that drifts under the subsequent measurement - which is how a
 * memory-per-connection figure ends up negative. This polls until two
 * consecutive windows agree within `tolerance`, or gives up and returns the
 * last reading with `stable: false` so the report can say so.
 */
export async function stableIdleRss(
  rootPid: number,
  opts: { maxMs?: number; windowMs?: number; tolerance?: number } = {},
): Promise<{ rss: number; processes: ProcessSample[]; stable: boolean }> {
  const maxMs = opts.maxMs ?? 30_000;
  const windowMs = opts.windowMs ?? 2_000;
  const tolerance = opts.tolerance ?? 0.02;
  const deadline = Date.now() + maxMs;

  let previous = await settledRss(rootPid, { samples: 3, intervalMs: windowMs / 3 });
  while (Date.now() < deadline) {
    const current = await settledRss(rootPid, { samples: 3, intervalMs: windowMs / 3 });
    const drift = previous.rss === 0 ? 1 : Math.abs(current.rss - previous.rss) / previous.rss;
    if (drift <= tolerance) return { ...current, stable: true };
    previous = current;
  }
  return { ...previous, stable: false };
}

export interface ConnectionHold {
  established: number;
  /** how many of those sockets are still alive right now */
  stillOpen: () => number;
  close: () => void;
}

export interface SseHandshake {
  statusLine: string;
  status: number;
  headers: Record<string, string>;
}

/**
 * One SSE handshake over a raw socket, returning as soon as the response
 * headers are complete.
 *
 * This exists because `fetch` cannot be used here: Bun's fetch does not resolve
 * until the first *body* byte arrives, and a correct SSE endpoint that has
 * nothing to say yet sends none - so a fetch-based check hangs forever against
 * a server that is behaving perfectly. curl streams and sees the headers
 * immediately; so does this.
 */
export function sseHandshake(url: string, timeoutMs = 15_000): Promise<SseHandshake> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect({ port: Number(target.port || 80), host: target.hostname });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no response headers within ${timeoutMs}ms`));
    }, timeoutMs);
    let seen = "";
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    socket.on("connect", () =>
      socket.write(
        `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\n` +
          `Accept: text/event-stream\r\nConnection: close\r\n\r\n`,
      ),
    );
    socket.on("data", (chunk) => {
      seen += chunk.toString("latin1");
      const end = seen.indexOf("\r\n\r\n");
      if (end === -1) return;
      const [statusLine, ...rest] = seen.slice(0, end).split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of rest) {
        const colon = line.indexOf(":");
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      finish(() =>
        resolve({
          statusLine: statusLine ?? "",
          status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine ?? "")?.[1] ?? 0),
          headers,
        }),
      );
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => finish(() => reject(new Error("connection closed before headers were complete"))));
  });
}

/**
 * Opens N server-sent-event streams and holds them.
 *
 * Raw sockets, not `fetch`: every runtime's fetch pools and caps connections
 * per host, so a fetch-based probe silently measures the client's pool size
 * instead of the server's per-connection cost - which is the whole point of
 * this scenario. One TCP socket per connection, one hand-written HTTP/1.1
 * request each, and `established` counts only the sockets that came back with
 * a 200 status line. The response bodies are read and discarded so the kernel
 * receive buffers do not fill and stall the server.
 */
export function holdConnections(
  url: string,
  count: number,
  opts: { batch?: number; timeoutMs?: number } = {},
): Promise<ConnectionHold> {
  const batch = opts.batch ?? 100;
  const timeout = opts.timeoutMs ?? 30_000;
  const target = new URL(url);
  const host = target.hostname;
  const port = Number(target.port || 80);
  const request =
    `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
    `Host: ${target.host}\r\n` +
    `Accept: text/event-stream\r\n` +
    `Connection: keep-alive\r\n` +
    `User-Agent: borgo-bench-memory-probe\r\n\r\n`;

  const sockets: import("node:net").Socket[] = [];
  const close = () => {
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {}
    }
  };

  const openOne = () =>
    new Promise<void>((resolve, reject) => {
      const socket = connect({ port, host });
      sockets.push(socket);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("timed out waiting for response headers"));
      }, timeout);
      let seen = "";
      let settled = false;
      socket.on("data", (chunk) => {
        if (settled) return; // keep draining, stop parsing
        seen += chunk.toString("latin1");
        if (!seen.includes("\r\n\r\n")) return;
        settled = true;
        clearTimeout(timer);
        if (/^HTTP\/1\.[01] 200/.test(seen)) resolve();
        else reject(new Error(`sse handshake answered: ${seen.split("\r\n")[0]}`));
      });
      socket.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      socket.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("server closed the connection before answering"));
      });
      socket.on("connect", () => socket.write(request));
    });

  return (async () => {
    let established = 0;
    for (let offset = 0; offset < count; offset += batch) {
      const size = Math.min(batch, count - offset);
      const settled = await Promise.allSettled(Array.from({ length: size }, openOne));
      established += settled.filter((s) => s.status === "fulfilled").length;
      const failed = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
      if (failed.length > size / 2) {
        close();
        throw new Error(
          `only ${established}/${offset + size} sse connections opened - first error: ${failed[0]!.reason}`,
        );
      }
      // let the server finish accepting before the next wave
      await Bun.sleep(50);
    }
    if (established < count) {
      console.log(`      note: ${established}/${count} connections established; the delta is divided by what is still open`);
    }
    return {
      established,
      stillOpen: () => sockets.filter((socket) => !socket.destroyed && socket.readable).length,
      close,
    };
  })();
}

export async function measureMemory(opts: {
  rootPid: number;
  sseUrl: string;
  connections: number;
}): Promise<MemoryResult> {
  const idle = await stableIdleRss(opts.rootPid);
  const hold = await holdConnections(opts.sseUrl, opts.connections);
  // let the server finish accepting and allocating before reading
  await Bun.sleep(3_000);
  const loaded = await settledRss(opts.rootPid, { samples: 6, intervalMs: 500 });
  // the divisor is what is still open at the moment RSS was read, not what we
  // once managed to open: a server that dropped half of them is not holding
  // them, and dividing by the optimistic number would flatter it
  const held = hold.stillOpen();
  hold.close();

  const delta = loaded.rss - idle.rss;
  const notes: string[] = [];
  if (!idle.stable) {
    notes.push("idle RSS had not stopped drifting when the baseline was taken; treat the delta as approximate");
  }
  if (held < hold.established) {
    notes.push(`${hold.established - held} of ${hold.established} connections had been dropped by the time RSS was read`);
  }
  if (delta <= 0) {
    notes.push(
      "RSS did not grow while holding the connections. This is a measurement floor, not a claim that " +
        "connections are free: the runtime's allocator was still returning memory from earlier work, " +
        "or the per-connection cost is below the noise of this sampler. Re-run with more connections.",
    );
  }
  if (hold.established < opts.connections) {
    notes.push(`only ${hold.established} of ${opts.connections} connections were established`);
  }

  return {
    connections: opts.connections,
    idleRssBytes: idle.rss,
    loadedRssBytes: loaded.rss,
    deltaBytes: delta,
    bytesPerConnection: held > 0 ? delta / held : 0,
    established: held,
    idleStable: idle.stable,
    reliable: idle.stable && delta > 0 && held === opts.connections,
    notes,
    processes: loaded.processes.map((p) => ({ pid: p.pid, rssBytes: p.rssBytes, command: p.command })),
  };
}
