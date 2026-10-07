const base = process.argv[2];
const t0 = performance.now();
const at = () => Math.round(performance.now() - t0);

// the go stream: silent but for pings, until the event at 45 s
const sse = (async () => {
  const res = await fetch(`${base}/api/silent`);
  const reader = res.body!.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return { ended: at(), gotEvent: text.includes("fired"), text: text.slice(0, 200) };
    text += new TextDecoder().decode(value);
    if (text.includes("event: fired")) return { ended: at(), gotEvent: true };
  }
})().catch((e) => ({ error: String(e), at: at() }));

// the render service's stream: the shell now, the rest at 45 s
const page = (async () => {
  const res = await fetch(`${base}/late`);
  const html = await res.text();
  return { ended: at(), status: res.status, complete: html.includes("seconds later") && html.trimEnd().endsWith("</html>"), bytes: html.length };
})().catch((e) => ({ error: String(e), at: at() }));

// the starvation: waves of 24 heavy renders until 44 s
const heavy: number[] = [];
const statuses: Record<number, number> = {};
await Bun.sleep(1000);
while (at() < 44_000) {
  await Promise.all(
    Array.from({ length: Number(process.argv[3] ?? 24) }, async () => {
      const s = performance.now();
      const r = await fetch(`${base}/heavy`).catch(() => null);
      statuses[r?.status ?? 0] = (statuses[r?.status ?? 0] ?? 0) + 1;
      await r?.arrayBuffer().catch(() => null);
      heavy.push(Math.round(performance.now() - s));
    }),
  );
}
const wait = 45_000 - at();
if (wait > 0) await Bun.sleep(wait);
const firedAt = at();
const fired = await fetch(`${base}/api/fire`, { method: "POST" }).then((r) => r.status).catch(() => 0);
const [s, p] = await Promise.all([sse, Promise.race([page, Bun.sleep(30_000).then(() => ({ timeout: true }))])]);
heavy.sort((a, b) => a - b);
console.log(JSON.stringify({ sse: s, page: p, fired, firedAt, heavyRenders: heavy.length, statuses, heavyMs: { min: heavy[0], median: heavy[heavy.length >> 1], max: heavy[heavy.length - 1] } }));
process.exit(0);
