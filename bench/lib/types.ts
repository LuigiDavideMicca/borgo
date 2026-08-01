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

export interface LoadStats {
  requestsPerSec: number;
  successRate: number;
  totalRequests: number;
  latencyMs: { p50: number; p90: number; p95: number; p99: number; max: number };
  statusCodes: Record<string, number>;
  errors: Record<string, number>;
}

export interface LoadRunResult {
  runs: LoadStats[];
  /** median across runs, per field - the reported number */
  median: LoadStats;
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
}

export interface ScenarioResult {
  scenario: ScenarioId;
  status: "ok" | "skipped" | "failed";
  reason?: string;
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
  startup?: StartupResult;
  scenarios: ScenarioResult[];
}
