import type { BodySpec } from "./canonical";

export type ScenarioId = "hello-json" | "api-list" | "ssr-page" | "static-asset" | "memory-conn";

export interface Scenario {
  id: ScenarioId;
  title: string;
  /** "load" runs the load tool; "memory" runs the connection-holding probe. */
  kind: "load" | "memory";
  /** canonical path every implementation must serve - see CONTRACT.md */
  path: string;
  /** a cheap correctness check run before the load: a wrong answer is not a fast answer */
  expect: {
    status: number;
    contentType?: string;
    /** every string must appear in the body */
    contains?: string[];
    /**
     * every pattern must match the body at least `min` times (default 1). This
     * is what makes a structural requirement enforceable: "five nav links" and
     * "twenty rows" are counts, and a substring check cannot express a count.
     */
    matches?: { pattern: string; flags?: string; min?: number; label: string }[];
    /**
     * a floor on the response body, in bytes. Not a performance figure - a
     * tripwire. An implementation that quietly serves a shorter body than the
     * contract describes would otherwise post a very good req/s number.
     */
    minBytes?: number;
    /**
     * an exact body length. A floor only catches a body that is too short; the
     * static asset is one committed file and CONTRACT.md says "nobody serves a
     * different number of bytes", so for that scenario the floor was the wrong
     * tripwire in both directions.
     */
    exactBytes?: number;
    /** sha256 of the body, hex. The contract pins one for the static asset. */
    sha256?: string;
    /**
     * the body must equal, value for value, what CONTRACT.md specifies. Counting
     * `"done":` occurrences passes an implementation whose `done` is always
     * false - which is cheaper to produce than the contract's items.
     */
    body?: BodySpec;
  };
  description: string;
}

export interface Manifest {
  /** directory name and report label */
  name: string;
  framework: string;
  language: string;
  /** how the process is run, e.g. "bun 1.3 + go 1.25" */
  runtime: string;
  /**
   * implemented: we wrote it, it builds, it answers the contract correctly.
   * stub:        the directory and manifest exist, the app does not run yet.
   * A stub is skipped by the runner and reported as "not implemented" - never
   * as a zero.
   */
  status: "implemented" | "stub";
  /** the port the public entrypoint listens on; the runner injects it as PORT */
  port: number;
  /** probed until it answers 200 - defines "started" and time-to-first-response */
  readyPath: string;
  /** run once before the first build; may be omitted */
  install?: string[];
  /** each entry is one argv array, run in order, from the app directory */
  build?: string[][];
  /** argv of the long-running server */
  start: string[];
  /** extra env; ${PORT} and ${API_PORT} are substituted */
  env?: Record<string, string>;
  implements: ScenarioId[];
  /** argv printing the framework version, recorded in the environment block */
  versionCommand?: string[];
  notes?: string;
  /** what is missing, for stubs */
  todo?: string;
}

export interface Latencies {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  /**
   * p99.99, not the maximum. oha reports both and this is the one we take;
   * the field used to be called `max`, which made a tail percentile look like
   * a worst case in every artifact that carried it. wrk does not report it and
   * leaves it 0.
   */
  p9999: number;
}

export interface LoadStats {
  requestsPerSec: number;
  /**
   * the load tool's own transport-level success rate: did the exchange
   * complete. A 500 that arrives intact counts as a success here, which is why
   * it is not the only thing the runner gates on - see `non2xxRate`.
   */
  successRate: number;
  /** share of responses whose status was not 2xx. Derived, not reported by oha. */
  non2xxRate: number;
  totalRequests: number;
  latencyMs: Latencies;
  statusCodes: Record<string, number>;
  errors: Record<string, number>;
}

/**
 * The per-field median across runs. Counting fields are deliberately absent:
 * summing a distribution over three runs and storing it in an object called
 * "median" is how a 3-run total ends up printed beside a 1-run median. Counts
 * live in `totals`, labelled as totals.
 */
export interface LoadMedian {
  requestsPerSec: number;
  successRate: number;
  non2xxRate: number;
  totalRequests: number;
  latencyMs: Latencies;
}

export interface LoadRunResult {
  runs: LoadStats[];
  /** median across runs, per field - the reported number */
  median: LoadMedian;
  /** summed over every run, and named for it */
  totals: {
    runs: number;
    requests: number;
    statusCodes: Record<string, number>;
    errors: Record<string, number>;
  };
  /** the single worst run, which is what the gates use: a median of three hides one catastrophe */
  worst: { successRate: number; non2xxRate: number };
}

export interface MemoryResult {
  connections: number;
  /** RSS of the whole process tree, bytes */
  idleRssBytes: number;
  loadedRssBytes: number;
  deltaBytes: number;
  bytesPerConnection: number;
  established: number;
  /** did the idle baseline stop drifting before it was taken? */
  idleStable: boolean;
  /** false when the figure should not be quoted without its caveats */
  reliable: boolean;
  /** why it is not reliable, in plain words; printed in the report */
  notes: string[];
  processes: { pid: number; rssBytes: number; command: string }[];
}

export interface StartupResult {
  /** spawn -> first 200 on readyPath, ms */
  timeToFirstResponseMs: number;
  /** RSS after the ready probe, before any load */
  bootRssBytes: number;
  /**
   * Had it stopped growing when it was read?
   *
   * This used to be three samples over 600 ms, taken while a JIT runtime is
   * still allocating. Whichever runtime grows slowest wins a column measuring
   * how far along its growth curve it happened to be, which is not a property
   * of a framework. It is now polled to stability, and when it never settles
   * the report says so instead of publishing the snapshot bare.
   */
  bootRssStable: boolean;
}

/**
 * The one response the correctness check read, recorded so that a req/s table
 * can be read against what each implementation actually put on the wire. Two
 * frameworks answering the same path with a 3 kB and a 40 kB body are not
 * doing the same amount of work, and nothing else in this harness would say so.
 */
export interface ResponseSample {
  status: number;
  contentType: string;
  bytes: number;
}

export interface ScenarioResult {
  scenario: ScenarioId;
  status: "ok" | "skipped" | "failed";
  reason?: string;
  /** what the pre-load correctness check received */
  sample?: ResponseSample;
  load?: LoadRunResult;
  memory?: MemoryResult;
  /** on failure: was the server still running when the scenario gave up? */
  serverAlive?: boolean;
  /** on failure: the tail of whatever the server printed */
  serverOutput?: string;
}

export interface AppResult {
  app: string;
  manifest: Manifest;
  status: "ok" | "stub" | "failed";
  reason?: string;
  /**
   * which sweep produced this result, and where in that sweep's queue the app
   * sat. Two sweeps are run in opposite order precisely so that "measured
   * first" and "measured last" are both represented for every app.
   */
  pass?: number;
  orderIndex?: number;
  /** whatever `versionCommand` printed, so a competitor's version is recorded and not asserted */
  frameworkVersion?: string;
  startup?: StartupResult;
  scenarios: ScenarioResult[];
}
