import type { Scenario, ScenarioId } from "./types";

/**
 * The canonical contract. Every implementation serves these exact paths on one
 * public port, so the runner never has to be told where a framework "really"
 * keeps its equivalent - which is the hole through which a flattering mapping
 * would crawl in. The full specification of each response is CONTRACT.md.
 */
export const SCENARIOS: Scenario[] = [
  {
    id: "hello-json",
    title: "hello-world JSON",
    kind: "load",
    path: "/api/hello",
    expect: { status: 200, contentType: "application/json", contains: ['"hello, world"'] },
    description:
      "The floor: serialise one tiny object. Measures request plumbing, not application work. " +
      "For borgo this crosses the Bun front server and the Go API, because that is what a " +
      "deployed borgo app does.",
  },
  {
    id: "api-list",
    title: "JSON list (100 items)",
    kind: "load",
    path: "/api/items?n=100",
    expect: {
      status: 200,
      contentType: "application/json",
      contains: ['"Item 100"', '"Item 1"'],
      // two substrings said nothing about the length of the list or the shape
      // of an element, so an implementation returning ten items - or items
      // missing every field but `title` - passed and posted a large number
      matches: [
        { pattern: '"id"\\s*:', flags: "g", min: 100, label: "100 objects each carrying an id" },
        { pattern: '"title"\\s*:', flags: "g", min: 100, label: "100 objects each carrying a title" },
        { pattern: '"tag"\\s*:', flags: "g", min: 100, label: "100 objects each carrying a tag" },
        { pattern: '"done"\\s*:', flags: "g", min: 100, label: "100 objects each carrying a done flag" },
      ],
      minBytes: 8_000,
    },
    description:
      "A realistic API response: 100 deterministic objects, generated per request (no cache), " +
      "about 15 kB of JSON. Measures serialisation and body writing.",
  },
  {
    id: "ssr-page",
    title: "SSR of a real page",
    kind: "load",
    path: "/page",
    expect: {
      status: 200,
      contentType: "text/html",
      contains: ['data-bench-page="ssr"', "Item 20", "hydrated counter:"],
      // CONTRACT.md lists seven requirements for this page; two substrings
      // checked two of them, and an implementation that rendered
      // `<div data-bench-page="ssr">Item 20</div>` passed and posted a very
      // good number. These are the other five, as counts, because "five nav
      // links" and "twenty rows" are counts and a substring is not.
      matches: [
        { pattern: "<title[^>]*>\\s*bench ssr page\\s*</title>", label: "a <title> of 'bench ssr page'" },
        { pattern: "<h1[\\s>]", label: "an <h1>" },
        { pattern: "<nav[\\s>]", label: "a <nav>" },
        { pattern: 'href="/page#', flags: "g", min: 5, label: "five nav links" },
        // 20 rows x 4 cells. The header row uses <th>, so this counts data only.
        { pattern: "<td[\\s>]", flags: "g", min: 80, label: "twenty rows of id/title/tag/done" },
        // Not proof of hydration - nothing served over one request can be - but
        // it is the necessary condition, and it is what an implementation that
        // quietly dropped the interactive component to go faster would fail.
        // Combined with the "hydrated counter:" substring above, skipping
        // hydration now costs a failed scenario rather than buying throughput.
        { pattern: "<script[\\s>]", label: "ships client JavaScript, so the counter can hydrate" },
      ],
      minBytes: 2_000,
    },
    description:
      "A page with a layout, a nav, 20 rendered rows and one hydrated interactive component. " +
      "Server-rendered per request. This is the scenario a meta-framework exists for. " +
      "Read the req/s column next to the response-size column: the implementations do not " +
      "all put the same number of bytes on the wire for this page.",
  },
  {
    id: "static-asset",
    title: "static asset",
    kind: "load",
    path: "/static/payload.json",
    // the file is byte-identical in every app by construction (shared/copy-assets.ts
    // copies one committed file), so an exact floor is the right tripwire
    expect: { status: 200, contains: ["bench-static-asset"], minBytes: 31_607 },
    description:
      "The same committed 31,607-byte file, served by each implementation's own idea of a " +
      "static file. It is NOT the same amount of work everywhere, and the difference is not " +
      "incidental: borgo, Next and Astro go through a real static pipeline (per-request stat, " +
      "ETag, conditional-request handling), while the hono, elysia, express and fastify apps " +
      "read the file once at boot and write a buffer from memory with two headers. Treat this " +
      "row as 'framework static handler vs. hand-rolled memory buffer', not as a like-for-like " +
      "race - and note that the direction of that bias is against borgo, not for it. In " +
      "production most people put a CDN or nginx in front of all of this anyway.",
  },
  {
    id: "memory-conn",
    title: "memory per concurrent connection",
    kind: "memory",
    path: "/api/events",
    expect: { status: 200, contentType: "text/event-stream" },
    description:
      "RSS of the whole process tree at idle, then holding N open SSE connections, and the " +
      "delta divided by N. This is the number a Go runtime is supposed to win, so it is the " +
      "number we are most obliged to measure honestly.",
  },
];

export const scenarioById = (id: ScenarioId): Scenario => {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown scenario: ${id}`);
  return found;
};

export const ALL_SCENARIO_IDS: ScenarioId[] = SCENARIOS.map((s) => s.id);
