// Phase 3 spike of borgo 0.30: what a held websocket costs, and how fast one
// message reaches 1, 100 and 1000 subscribers, on the roads the design weighs:
//   B  - a relay in go on the standard library (go-raw with GO_RAW_WS=1);
//   R  - borgo's own relay (ws_relay.go), road B as written into borgo.
// Roads A (bun's relay behind the go front, as 0.2x ran it) and L (the same
// behind a lean go forwarder) were measured on 13/9 and are gone with bun's
// relay: their numbers stay in results/spikes.
// The method is memory-conn's (lib/memory.ts): raw TCP sockets, not a client
// library, whose pools would measure themselves; RSS summed over every
// process tree the road runs, idle polled until stable, and the delta divided
// by what is still open when RSS is read.
//
//   bun tools/spike-ws.ts                      every road
//   SPIKE_ONLY=L bun tools/spike-ws.ts         one road, by its letter
//   SPIKE_WS_BUFFER=256                        the go relay's per-connection buffer
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { settledRss, stableIdleRss, type ProcessSample } from "../lib/memory";
import { installCleanupHooks, killAll, run, spawnServer, type Spawned } from "../lib/proc";

const bench = join(import.meta.dir, "..");
const HELD = Number(process.env.SPIKE_HELD ?? 1000);
const FANOUT = [1, 100, 1000];
const PUBLISHES = 50;
const ONLY = process.env.SPIKE_ONLY ?? "";
const WS_BUFFER = process.env.SPIKE_WS_BUFFER ?? "";

type Target = { name: string; url: string; headers: Record<string, string> };
type ServerSpec = {
  dir: string;
  build: string[][];
  start: string[];
  env: Record<string, string>;
  ready: string;
  ports: number[];
};
type Variant = { letter: string; name: string; servers: ServerSpec[]; targets: Target[] };

const goRawDir = join(bench, "apps", "go-raw");
const goRaw = (env: Record<string, string>, port: number): ServerSpec => ({
  dir: goRawDir,
  build: [["go", "build", "-o", "bin/server.bin", "."]],
  start: ["./bin/server.bin"],
  env: { PORT: String(port), ...env },
  ready: `http://127.0.0.1:${port}/api/hello`,
  ports: [port],
});
// borgo's own relay (ws_relay.go), measured before it is wired into the
// front: the package's test binary, whose TestWSRelaySpikeServer serves the
// relay alone when BORGO_WS_SPIKE_ADDR is set. go -C builds it from the repo
// root into go-raw's ignored bin/, the one place relative spawning works
const borgoRelay: ServerSpec = {
  dir: goRawDir,
  build: [["go", "-C", join(bench, ".."), "test", "-c", "-o", join(goRawDir, "bin", "borgo-relay.bin"), "."]],
  start: ["./bin/borgo-relay.bin", "-test.run=^TestWSRelaySpikeServer$", "-test.timeout=0"],
  env: { BORGO_WS_SPIKE_ADDR: "127.0.0.1:43150" },
  ready: "http://127.0.0.1:43150/api/hello",
  ports: [43150],
};

const variants: Variant[] = [
  {
    letter: "R",
    name: "R - borgo's relay as written (ws_relay.go, before the front is wired to it)",
    servers: [borgoRelay],
    targets: [{ name: "R, borgo relay", url: "http://127.0.0.1:43150/ws", headers: {} }],
  },
  {
    letter: "B",
    name: "B - go relay on the standard library (go-raw, GO_RAW_WS=1)",
    servers: [goRaw({ GO_RAW_WS: "1", ...(WS_BUFFER ? { GO_RAW_WS_BUFFER: WS_BUFFER } : {}) }, 43130)],
    targets: [{ name: `B, go relay${WS_BUFFER ? `, buffer ${WS_BUFFER}` : ""}`, url: "http://127.0.0.1:43130/ws", headers: {} }],
  },
];

// a client frame is masked, always
function clientText(payload: string): Buffer {
  const data = Buffer.from(payload);
  const mask = randomBytes(4);
  let head: Buffer;
  if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
  else {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(data.length, 2);
  }
  const body = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) body[i] = data[i]! ^ mask[i % 4]!;
  return Buffer.concat([head, mask, body]);
}

// server frames are unmasked; several arrive in one chunk and one can span
// chunks, so each socket keeps what it has not parsed yet
function frameReader(onText: (text: string) => void) {
  // typed wide: alloc infers an ArrayBuffer-backed buffer, and a socket's
  // chunk is not necessarily one
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      if (pending.length < 2) return;
      const opcode = pending[0]! & 0x0f;
      let len = pending[1]! & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (pending.length < 4) return;
        len = pending.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (pending.length < 10) return;
        len = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      if (pending.length < offset + len) return;
      const payload = pending.subarray(offset, offset + len);
      pending = pending.subarray(offset + len);
      if (opcode === 0x1) onText(payload.toString("utf8"));
    }
  };
}

let lastMessageAt = 0;

function openWs(target: Target, topic: string, onText?: (text: string) => void, timeoutMs = 30_000): Promise<Socket> {
  const u = new URL(target.url);
  return new Promise((resolve, reject) => {
    const socket = connect({ port: Number(u.port), host: u.hostname });
    const extra = Object.entries(target.headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("no handshake answer"));
    }, timeoutMs);
    let seen = Buffer.alloc(0);
    let upgraded = false;
    const read = frameReader((text) => {
      lastMessageAt = performance.now();
      onText?.(text);
    });
    socket.on("connect", () =>
      socket.write(
        `GET ${u.pathname}?topics=${encodeURIComponent(topic)} HTTP/1.1\r\nHost: ${u.host}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
          `Sec-WebSocket-Version: 13\r\nOrigin: http://${u.host}\r\n${extra}\r\n`,
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      if (upgraded) return read(chunk);
      seen = Buffer.concat([seen, chunk]);
      const end = seen.indexOf("\r\n\r\n");
      if (end === -1) return;
      const status = seen.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
      clearTimeout(timer);
      if (!/^HTTP\/1\.1 101/.test(status)) {
        socket.destroy();
        reject(new Error(`handshake answered: ${status}`));
        return;
      }
      upgraded = true;
      resolve(socket);
      const rest = seen.subarray(end + 4);
      if (rest.length) read(rest);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      if (!upgraded) reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!upgraded) reject(new Error("closed before the handshake"));
    });
  });
}

async function openMany(target: Target, count: number, topicOf: (i: number) => string, onText?: (text: string) => void) {
  const sockets: Socket[] = [];
  let failed = 0;
  let firstError = "";
  for (let i = 0; i < count; i += 100) {
    const wave = await Promise.allSettled(
      Array.from({ length: Math.min(100, count - i) }, (_, k) => openWs(target, topicOf(i + k), onText)),
    );
    for (const r of wave) {
      if (r.status === "fulfilled") sockets.push(r.value);
      else {
        failed++;
        firstError ||= String(r.reason);
      }
    }
    await Bun.sleep(50);
  }
  return { sockets, failed, firstError };
}

async function waitQuiet(quietMs: number, maxMs: number) {
  const deadline = performance.now() + maxMs;
  while (performance.now() < deadline) {
    if (performance.now() - lastMessageAt > quietMs) return true;
    await Bun.sleep(100);
  }
  return false;
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

const kib = (bytes: number) => (bytes / 1024).toFixed(1);
const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

function breakdown(idle: ProcessSample[], loaded: ProcessSample[]) {
  return loaded.map((p) => {
    const before = idle.find((q) => q.pid === p.pid)?.rssBytes ?? 0;
    return `${p.command} (pid ${p.pid}): ${mib(before)} -> ${mib(p.rssBytes)} MiB`;
  });
}

// every tree the road runs is charged: road L is a bun app and a forwarder
async function measureMemory(servers: Spawned[], target: Target) {
  let idleRss = 0;
  let idleStable = true;
  const idleProcesses: ProcessSample[] = [];
  for (const server of servers) {
    const idle = await stableIdleRss(server.pid);
    idleRss += idle.rss;
    idleStable &&= idle.stable;
    idleProcesses.push(...idle.processes);
  }
  const held = await openMany(target, HELD, (i) => `held-${i}`);
  await Bun.sleep(3_000);
  let loadedRss = 0;
  const loadedProcesses: ProcessSample[] = [];
  for (const server of servers) {
    const loaded = await settledRss(server.pid, { samples: 6, intervalMs: 500 });
    loadedRss += loaded.rss;
    loadedProcesses.push(...loaded.processes);
  }
  const open = held.sockets.filter((s) => !s.destroyed && s.readable).length;
  for (const s of held.sockets) s.destroy();
  return {
    idleMiB: Number(mib(idleRss)),
    idleStable,
    loadedMiB: Number(mib(loadedRss)),
    open,
    failed: held.failed,
    firstError: held.firstError,
    kibPerConnection: open ? Number(kib((loadedRss - idleRss) / open)) : NaN,
    processes: breakdown(idleProcesses, loadedProcesses),
  };
}

async function measureFanout(target: Target, n: number) {
  const topic = `fan-${n}`;
  const sendTimes = new Array<number>(PUBLISHES).fill(0);
  const received: number[][] = Array.from({ length: PUBLISHES }, () => []);
  const subs = await openMany(
    target,
    n,
    () => topic,
    (text) => {
      const at = performance.now();
      let msg: { event?: string; data?: { i?: number } };
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.event !== "tick" || typeof msg.data?.i !== "number") return;
      received[msg.data.i]!.push(at - sendTimes[msg.data.i]!);
    },
  );
  // every join tells every subscriber the new count: that storm settles
  // before anything is timed
  const settled = await waitQuiet(1_000, 60_000);
  const publisher = await openWs(target, topic);
  await waitQuiet(500, 10_000);
  for (let i = 0; i < PUBLISHES; i++) {
    sendTimes[i] = performance.now();
    publisher.write(clientText(JSON.stringify({ topic, event: "tick", data: { i } })));
    await Bun.sleep(40);
  }
  await Bun.sleep(3_000);
  const all = received.flat();
  const lastPerMessage = received.filter((r) => r.length === subs.sockets.length).map((r) => Math.max(...r));
  publisher.destroy();
  for (const s of subs.sockets) s.destroy();
  await Bun.sleep(1_000);
  return {
    subscribers: subs.sockets.length,
    failed: subs.failed,
    stormSettled: settled,
    delivered: all.length,
    expected: subs.sockets.length * PUBLISHES,
    p50ms: Number(percentile(all, 50).toFixed(2)),
    p99ms: Number(percentile(all, 99).toFixed(2)),
    allReachedP50ms: Number(percentile(lastPerMessage, 50).toFixed(2)),
    allReachedP99ms: Number(percentile(lastPerMessage, 99).toFixed(2)),
  };
}

async function portsFree(ports: number[], maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const answering = await Promise.all(
      ports.map(
        (port) =>
          new Promise<boolean>((resolve) => {
            const s = connect({ port, host: "127.0.0.1" });
            s.once("connect", () => {
              s.destroy();
              resolve(true);
            });
            s.once("error", () => resolve(false));
          }),
      ),
    );
    if (!answering.some(Boolean)) return;
    if (Date.now() > deadline) throw new Error(`ports ${ports.join(", ")} still answer after the servers were stopped`);
    await Bun.sleep(250);
  }
}

async function bootOne(spec: ServerSpec): Promise<Spawned> {
  await portsFree(spec.ports);
  const server = spawnServer(spec.start, { cwd: spec.dir, env: spec.env });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(spec.ready, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return server;
    } catch {}
    if (Date.now() > deadline) {
      server.stop();
      throw new Error(`${spec.dir} never became ready:\n${server.output().slice(-2000)}`);
    }
    await Bun.sleep(250);
  }
}

async function boot(variant: Variant): Promise<Spawned[]> {
  const started: Spawned[] = [];
  for (const spec of variant.servers) started.push(await bootOne(spec));
  return started;
}

async function stop(variant: Variant, servers: Spawned[]) {
  for (const server of [...servers].reverse()) server.stop();
  await portsFree(variant.servers.flatMap((s) => s.ports));
}

installCleanupHooks();
const selected = variants.filter((v) => !ONLY || v.letter === ONLY);
if (!selected.length) throw new Error(`SPIKE_ONLY=${ONLY} names no road (R or B)`);

const built = new Set<string>();
for (const variant of selected) {
  for (const spec of variant.servers) {
    if (built.has(spec.dir)) continue;
    for (const step of spec.build) {
      const res = await run(step, { cwd: spec.dir, timeoutMs: 300_000 });
      if (res.code !== 0) throw new Error(`build step ${step.join(" ")} in ${spec.dir} failed:\n${res.stderr.slice(-2000)}`);
    }
    built.add(spec.dir);
  }
}

const results: Array<{ target: string; memory: unknown; fanout: unknown[] }> = [];
for (const variant of selected) {
  console.log(`\n== ${variant.name}`);
  for (const target of variant.targets) {
    console.log(`-- ${target.name}`);
    let servers = await boot(variant);
    const memory = await measureMemory(servers, target);
    console.log(`   memory: ${memory.kibPerConnection} KiB per connection (${memory.open} open, idle ${memory.idleMiB} MiB, stable ${memory.idleStable})`);
    await stop(variant, servers);
    servers = await boot(variant);
    const fanout = [];
    for (const n of FANOUT) {
      const f = await measureFanout(target, n);
      console.log(`   fan-out ${n}: p50 ${f.p50ms} ms, p99 ${f.p99ms} ms, all reached p50 ${f.allReachedP50ms} ms, delivered ${f.delivered}/${f.expected}`);
      fanout.push(f);
    }
    await stop(variant, servers);
    results.push({ target: target.name, memory, fanout });
  }
}
killAll();

const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
const dir = join(bench, "results", "spikes");
mkdirSync(dir, { recursive: true });
const base = join(dir, `run-${stamp}-spike-030-ws${ONLY ? `-${ONLY}` : ""}${WS_BUFFER ? `-buffer${WS_BUFFER}` : ""}`);
writeFileSync(`${base}.json`, JSON.stringify({ held: HELD, publishes: PUBLISHES, results }, null, 2));
const rows = results.map((r) => {
  const m = r.memory as { kibPerConnection: number; open: number; idleStable: boolean };
  const f = r.fanout as Array<{ subscribers: number; p50ms: number; p99ms: number; allReachedP99ms: number; delivered: number; expected: number }>;
  return `| ${r.target} | ${m.kibPerConnection} (${m.open} open${m.idleStable ? "" : ", idle not stable"}) | ${f
    .map((x) => `${x.subscribers}: ${x.p50ms} / ${x.p99ms} / ${x.allReachedP99ms} ms (${x.delivered}/${x.expected})`)
    .join("<br>")} |`;
});
writeFileSync(
  `${base}.md`,
  [
    "# Spike 0.30 phase 3 - websocket relay: bun behind go (A), bun behind a lean forwarder (L), go (B)",
    "",
    `${HELD} held connections for memory, one topic each; ${PUBLISHES} publishes for fan-out. RSS summed over every process tree a road runs.`,
    "",
    "| target | KiB per held connection | fan-out: subscribers: p50 / p99 per delivery / p99 until all reached (delivered) |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "Per-process RSS and every raw figure are in the json beside this file.",
    "",
  ].join("\n"),
);
console.log(`\nwritten ${base}.md`);
