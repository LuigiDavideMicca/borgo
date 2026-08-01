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
    expect: { status: 200, contentType: "application/json", contains: ['"Item 100"', '"Item 1"'] },
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
      contains: ['data-bench-page="ssr"', "Item 20"],
    },
    description:
      "A page with a layout, a nav, 20 rendered rows and one hydrated interactive component. " +
      "Server-rendered per request. This is the scenario a meta-framework exists for.",
  },
  {
    id: "static-asset",
    title: "static asset",
    kind: "load",
    path: "/static/payload.json",
    expect: { status: 200, contains: ["bench-static-asset"] },
    description:
      "A ~32 kB file served from disk. In production most people put a CDN or nginx in front " +
      "of this; it is measured because frameworks differ by an order of magnitude here and " +
      "some deployments do not.",
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
