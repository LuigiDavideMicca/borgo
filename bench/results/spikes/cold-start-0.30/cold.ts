import { spawnSync } from "node:child_process";
const results: { healthz: number; page: number }[] = [];
for (let i = 0; i < 5; i++) {
  spawnSync("docker", ["rm", "-f", "zz-cold-c"]);
  const t0 = performance.now();
  const run = spawnSync("docker", ["run", "-d", "--name", "zz-cold-c", "-p", "3978:3000", "-e", "SESSION_SECRET=cold-start-session-secret-0123456789abcdef", "zz-cold"]);
  if (run.status !== 0) throw new Error(run.stderr.toString());
  let healthz = 0, page = 0;
  while (!healthz || !page) {
    const now = performance.now() - t0;
    if (now > 30000) throw new Error("timeout");
    if (!healthz) {
      try { const t = await (await fetch("http://localhost:3978/healthz")).text(); if (t.includes('"status":"ok"')) healthz = Math.round(performance.now() - t0); } catch {}
    }
    if (!page) {
      try { if ((await fetch("http://localhost:3978/")).status === 200) page = Math.round(performance.now() - t0); } catch {}
    }
    await Bun.sleep(15);
  }
  results.push({ healthz, page });
}
spawnSync("docker", ["rm", "-f", "zz-cold-c"]);
const med = (k: "healthz" | "page") => results.map((r) => r[k]).sort((a, b) => a - b)[2];
console.log(JSON.stringify({ results, median: { healthz: med("healthz"), page: med("page") } }));
