// Phase 3 spike of borgo 0.30: what a held websocket costs, and how fast one
// message reaches 1, 100 and 1000 subscribers, on the two roads the design
// weighs:
//   A  - borgo's relay in bun behind the go front, today's code, reached
//        through the go front and, from the same boot, directly on the render
//        service, to separate the proxy's share from bun's;
//   B  - a relay in go on the standard library (go-raw with GO_RAW_WS=1).
// The method is memory-conn's (lib/memory.ts): raw TCP sockets, not a client
// library, whose pools would measure themselves; RSS summed over the process
// tree, idle polled until stable, and the delta divided by what is still open
// when RSS is read.
//
//   bun tools/spike-ws.ts
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
const KEY = "b".repeat(64);
// SPIKE_ONLY=B or =A runs one road; SPIKE_WS_BUFFER sets the go relay's per-connection buffer
const ONLY = process.env.SPIKE_ONLY ?? "";
const WS_BUFFER = process.env.SPIKE_WS_BUFFER ?? "";

type Target = { name: string; url: string; headers: Record<string, string> };
type Variant = {
  name: string;
  dir: string;
  build: string[][];
  start: string[];
  env: Record<string, string>;
  ready: string;
  ports: number[];
  targets: Target[];
};

const variants: Variant[] = [
  {
    name: "B - go relay on the standard library (go-raw, GO_RAW_WS=1)",
    dir: join(bench, "apps", "go-raw"),
    build: [["go", "build", "-o", "bin/server.bin", "."]],
    start: ["./bin/server.bin"],
    env: { PORT: "43130", GO_RAW_WS: "1", ...(WS_BUFFER ? { GO_RAW_WS_BUFFER: WS_BUFFER } : {}) },
    ready: "http://127.0.0.1:43130/api/hello",
    ports: [43130],
    targets: [{ name: "B, go relay", url: "http://127.0.0.1:43130/ws", headers: {} }],
  },
  {
    name: "A - bun relay behind the go front (borgo start, this checkout)",
    dir: join(bench, "apps", "borgo"),
    build: [["go", "mod", "tidy"], ["bun", "run", "build"]],
    start: ["bun", "node_modules/borgo-framework/src/cli.ts", "start"],
    env: {
      PORT: "43100",
      API_PORT: "43101",
      BORGO_RENDER_PORT: "43102",
      BORGO_INTERNAL_KEY: KEY,
      SESSION_SECRET: "bench-only-secret-0123456789abcdef",
      BUN_CONFIG_MAX_HTTP_REQUESTS: "16384",
      NODE_ENV: "production",
    },
    ready: "http://127.0.0.1:43100/api/hello",
    ports: [43100, 43101, 43102],
    targets: [
      { name: "A, through the go front", url: "http://127.0.0.1:43100/ws", headers: {} },
      { name: "A0, bun directly", url: "http://127.0.0.1:43102/ws", headers: { "X-Borgo-Internal": KEY } },
    ],
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
  let pending = Buffer.alloc(0);
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

async function measureMemory(server: Spawned, target: Target) {
  const idle = await stableIdleRss(server.pid);
  const held = await openMany(target, HELD, (i) => `held-${i}`);
  await Bun.sleep(3_000);
  const loaded = await settledRss(server.pid, { samples: 6, intervalMs: 500 });
  const open = held.sockets.filter((s) => !s.destroyed && s.readable).length;
  for (const s of held.sockets) s.destroy();
  return {
    idleMiB: Number(mib(idle.rss)),
    idleStable: idle.stable,
    loadedMiB: Number(mib(loaded.rss)),
    open,
    failed: held.failed,
    firstError: held.firstError,
    kibPerConnection: open ? Number(kib((loaded.rss - idle.rss) / open)) : NaN,
    processes: breakdown(idle.processes, loaded.processes),
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
    if (Date.now() > deadline) throw new Error(`ports ${ports.join(", ")} still answer after the server was stopped`);
    await Bun.sleep(250);
  }
}

async function boot(variant: Variant): Promise<Spawned> {
  await portsFree(variant.ports);
  const server = spawnServer(variant.start, { cwd: variant.dir, env: variant.env });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(variant.ready, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return server;
    } catch {}
    if (Date.now() > deadline) {
      server.stop();
      throw new Error(`${variant.name} never became ready:\n${server.output().slice(-2000)}`);
    }
    await Bun.sleep(250);
  }
}

installCleanupHooks();
const results: Array<{ target: string; memory: unknown; fanout: unknown[] }> = [];
for (const variant of variants.filter((v) => !ONLY || v.name.startsWith(ONLY))) {
  console.log(`\n== ${variant.name}`);
  for (const step of variant.build) {
    const res = await run(step, { cwd: variant.dir, timeoutMs: 300_000 });
    if (res.code !== 0) throw new Error(`build step ${step.join(" ")} failed:\n${res.stderr.slice(-2000)}`);
  }
  for (const target of variant.targets) {
    console.log(`-- ${target.name}`);
    let server = await boot(variant);
    const memory = await measureMemory(server, target);
    console.log(`   memory: ${memory.kibPerConnection} KiB per connection (${memory.open} open, idle ${memory.idleMiB} MiB, stable ${memory.idleStable})`);
    server.stop();
    await portsFree(variant.ports);
    server = await boot(variant);
    const fanout = [];
    for (const n of FANOUT) {
      const f = await measureFanout(target, n);
      console.log(`   fan-out ${n}: p50 ${f.p50ms} ms, p99 ${f.p99ms} ms, all reached p50 ${f.allReachedP50ms} ms, delivered ${f.delivered}/${f.expected}`);
      fanout.push(f);
    }
    server.stop();
    await portsFree(variant.ports);
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
    "# Spike 0.30 phase 3 - websocket relay, bun behind go (A) against go (B)",
    "",
    `${HELD} held connections for memory, one topic each; ${PUBLISHES} publishes for fan-out.`,
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
