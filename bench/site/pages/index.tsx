import { run } from "@/data.gen";
import { fmtGB, fmtKB, fmtMB, fmtMs, fmtRps, shortCommit } from "@/lib/format";

export const head = {
  title: "borgo benchmarks",
  meta: [
    {
      name: "description",
      content: "five scenarios, one contract, every bias stated before the table",
    },
  ],
};

// the whole page is server-rendered markup and inline svg: no page bundle,
// nothing fetched, the numbers are baked from the committed json at build
export const hydrate = false;

type LoadScenario = "hello-json" | "api-list" | "ssr-page" | "static-asset";

const SCENARIOS: Array<{ id: LoadScenario; title: string; what: string }> = [
  { id: "hello-json", title: "hello-json", what: "the floor: request plumbing with almost no work attached" },
  { id: "api-list", title: "api-list", what: "~15 kB of JSON generated per request; serialisation and body writing" },
  { id: "ssr-page", title: "ssr-page", what: "a page with layout, nav, 20 rendered rows and a hydrated counter, server-rendered per request" },
  { id: "static-asset", title: "static-asset", what: "a 31,607-byte file from disk, byte-identical for every implementation" },
];

// geometry shared by every chart: a fat left gutter for names, a right pad
// so the longest bar's label never clips
const W = 760;
const GUTTER = 120;
const RIGHT_PAD = 170;
const BAR_H = 22;
const ROW_H = 36;
const PLOT_W = W - GUTTER - RIGHT_PAD;

// a bar whose data end is rounded and whose baseline end is not: the flat
// edge sits on the axis, the cap marks the value
const barPath = (x: number, y: number, w: number, h: number) => {
  const r = Math.min(4, w);
  return `M${x},${y} h${Math.max(0, w - r)} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${Math.max(0, w - r)} z`;
};

function BarChart({
  rows,
  format,
  detail,
  title,
}: {
  rows: Array<{ name: string; value: number; detail?: string; note?: string }>;
  format: (n: number) => string;
  detail?: string;
  title: string;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  const height = rows.length * ROW_H + 6;
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={title}>
        {rows.map((row, i) => {
          const y = i * ROW_H + 4;
          const w = Math.max(2, (row.value / max) * PLOT_W);
          return (
            <g key={row.name}>
              <title>{`${row.name}: ${format(row.value)}${row.detail ? ` (${row.detail})` : ""}`}</title>
              <text className="name" x={GUTTER - 10} y={y + BAR_H / 2 + 4} textAnchor="end">
                {row.name}
              </text>
              <path className="bar" d={barPath(GUTTER, y, w, BAR_H)} />
              <text className="value" x={GUTTER + w + 10} y={y + BAR_H / 2 - 2}>
                {format(row.value)}
              </text>
              {row.detail && (
                <text className="detail" x={GUTTER + w + 10} y={y + BAR_H / 2 + 12}>
                  {row.detail}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <details>
        <summary>table view</summary>
        <table>
          <thead>
            <tr>
              <th>framework</th>
              <th>{detail ? "value" : "value"}</th>
              {detail && <th>{detail}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <td>{row.name}</td>
                <td>{format(row.value)}</td>
                {detail && <td>{row.detail ?? ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

export default function Bench() {
  const env = run.environment;
  const loadRows = (id: LoadScenario) =>
    run.apps
      .filter((a) => id in a.load)
      .map((a) => {
        const s = a.load[id as keyof typeof a.load]!;
        return { name: a.name, value: s.rps, detail: `p50 ${fmtMs(s.p50)} · p99 ${fmtMs(s.p99)}` };
      })
      .sort((a, b) => b.value - a.value);

  const memoryApps = run.apps.filter((a) => a.memory);

  return (
    <main>
      <header>
        <h1>borgo benchmarks</h1>
        <p className="tagline">
          Five scenarios, one <a href="https://github.com/LuigiDavideMicca/borgo/blob/main/bench/CONTRACT.md">contract</a> every
          implementation must satisfy before a number is reported. Method first, numbers second.
        </p>
      </header>

      <section className="biases" aria-labelledby="biases-h">
        <h2 id="biases-h">The biases, stated first</h2>
        <ol>
          <li>
            <strong>We wrote the harness and one of the subjects.</strong> borgo is our framework; nobody from the
            other teams reviewed their implementation here.
          </li>
          <li>
            <strong>We are better at borgo than at the alternatives.</strong> Each competitor is idiomatic but
            un-tuned; where a faster mode was deliberately not used, the run's notes say so. Read their numbers as
            floors, not ceilings.
          </li>
          <li>
            <strong>A benchmark app is not an application.</strong> No database, no auth, no real template weight. A
            framework that wins here by 3× will not make your app 3× faster.
          </li>
          <li>
            <strong>Self-hosted against self-hosted.</strong> Next.js runs `next start` on Node, not Vercel — the
            deployment borgo competes with, not the one Next.js is most optimised for.
          </li>
          <li>
            <strong>One machine.</strong> The load generator competes with the server for the same cores; treat the
            numbers as conservative and compressed at the top end.
          </li>
        </ol>
        <p>
          Found a scenario tilted our way? That is a harness bug —{" "}
          <a href="https://github.com/LuigiDavideMicca/borgo/issues">open an issue</a> or send a better competitor
          implementation.
        </p>
      </section>

      <section className="identity" aria-labelledby="run-h">
        <h2 id="run-h">This run</h2>
        <dl>
          <div>
            <dt>captured</dt>
            <dd>{new Date(env.capturedAt).toISOString().slice(0, 16).replace("T", " ")} UTC</dd>
          </div>
          <div>
            <dt>borgo</dt>
            <dd>
              {env.repo.borgoVersion} @ {shortCommit(env.repo.commit)}
              {env.repo.dirty ? " (dirty tree)" : ""}
            </dd>
          </div>
          <div>
            <dt>machine</dt>
            <dd>
              {env.host.cpuModel} · {env.host.cpuCount} cpu · {fmtGB(env.host.totalMemBytes)} ·{" "}
              {env.host.osType} {env.host.osRelease}
            </dd>
          </div>
          <div>
            <dt>toolchain</dt>
            <dd>
              bun {env.versions.bun} · {env.versions.go?.replace("go version ", "")} · node {env.versions.node}
            </dd>
          </div>
          <div>
            <dt>load</dt>
            <dd>
              {env.loadTool.version} · {run.config.connections} connections · {run.config.durationSeconds}s ×{" "}
              {run.config.runs} runs (median shown) · {run.config.warmupSeconds}s warmup
            </dd>
          </div>
          {env.note && (
            <div>
              <dt>note</dt>
              <dd>{env.note}</dd>
            </div>
          )}
        </dl>
      </section>

      {SCENARIOS.map((s) => {
        const rows = loadRows(s.id);
        if (!rows.length) return null;
        return (
          <section key={s.id} aria-labelledby={`h-${s.id}`}>
            <h2 id={`h-${s.id}`}>{s.title}</h2>
            <p className="what">{s.what} — higher is better.</p>
            <BarChart title={s.title} rows={rows} format={fmtRps} detail="latency" />
          </section>
        );
      })}

      {memoryApps.length > 0 && (
        <section aria-labelledby="h-memory">
          <h2 id="h-memory">memory-conn</h2>
          <p className="what">
            RSS of the whole process tree at rest, and the cost of holding {run.config.memoryConnections} open SSE
            connections — lower is better.
          </p>
          <h3>resident memory after boot, idle</h3>
          <BarChart
            title="idle RSS"
            rows={memoryApps
              .map((a) => ({
                name: a.name,
                value: a.memory!.idleRssBytes,
                detail: a.memory!.reliable ? undefined : "baseline never stabilised",
              }))
              .sort((a, b) => a.value - b.value)}
            format={fmtMB}
          />
          <h3>per held connection</h3>
          <BarChart
            title="memory per connection"
            rows={memoryApps
              .map((a) => ({
                name: a.name,
                value: a.memory!.bytesPerConnection,
                detail: `${fmtMB(a.memory!.deltaBytes)} for ${run.config.memoryConnections}`,
              }))
              .sort((a, b) => a.value - b.value)}
            format={fmtKB}
          />
        </section>
      )}

      {run.notMeasured.length > 0 && (
        <section aria-labelledby="h-missing">
          <h2 id="h-missing">Not measured</h2>
          <p className="what">A missing competitor is honest; a half-implemented one would be a lie with a table.</p>
          <ul>
            {run.notMeasured.map((m) => (
              <li key={m.name}>
                <strong>{m.name}</strong> — {m.reason}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="h-notes">
        <h2 id="h-notes">Per-implementation notes</h2>
        <ul className="notes">
          {run.apps
            .filter((a) => a.notes)
            .map((a) => (
              <li key={a.name}>
                <strong>{a.name}</strong> <span className="rt">({a.runtime})</span> — {a.notes}
              </li>
            ))}
        </ul>
      </section>

      <footer>
        Reproduce it:{" "}
        <code>git clone https://github.com/LuigiDavideMicca/borgo && cd borgo/bench && bun run.ts</code> — the
        harness refuses to report a number it could not verify, and this page is generated from the same json it
        writes, by <code>bench/site</code>, a borgo app exported with <code>borgo export</code>.
      </footer>
    </main>
  );
}
