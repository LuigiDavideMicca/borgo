import { describe, expect, test } from "bun:test";
import { cpuBusyRatio, environmentWarnings, QUIET_THRESHOLD, type Environment } from "../lib/env";

const base: Environment = {
  capturedAt: "2026-08-01T00:00:00.000Z",
  host: {
    platform: "linux",
    osType: "Linux",
    osRelease: "6.0",
    arch: "x64",
    cpuModel: "test cpu",
    cpuCount: 8,
    cpuMhz: 2800,
    totalMemBytes: 32 * 1024 ** 3,
    freeMemBytesAtStart: 20 * 1024 ** 3,
  },
  versions: {},
  repo: { commit: "abcdef1234567890", dirty: false, borgoVersion: "0.20.1" },
  loadTool: { name: "oha", version: "1.15.0", path: "/tmp/oha" },
  note: "idle laptop on mains",
  idleCheck: { busyRatioAtStart: 0.01, sampleMs: 1000, quietThreshold: QUIET_THRESHOLD, quiet: true },
};

describe("cpuBusyRatio", () => {
  test("an idle window is 0 and a saturated one is 1", () => {
    expect(cpuBusyRatio({ idle: 0, total: 0 }, { idle: 1000, total: 1000 })).toBe(0);
    expect(cpuBusyRatio({ idle: 0, total: 0 }, { idle: 0, total: 1000 })).toBe(1);
    expect(cpuBusyRatio({ idle: 500, total: 1000 }, { idle: 1250, total: 2000 })).toBeCloseTo(0.25, 5);
  });

  test("a window in which no time passed is not evidence of a busy machine", () => {
    expect(cpuBusyRatio({ idle: 10, total: 20 }, { idle: 10, total: 20 })).toBe(0);
  });
});

describe("environmentWarnings", () => {
  test("a clean, attested, idle run warns about nothing", () => {
    expect(environmentWarnings(base)).toEqual([]);
  });

  test("no operator note is a warning, not a blank table cell", () => {
    expect(environmentWarnings({ ...base, note: "   " }).join(" ")).toContain("No `--note` was given");
  });

  test("a machine that was not idle before the campaign is a warning", () => {
    const busy = { ...base, idleCheck: { ...base.idleCheck, busyRatioAtStart: 0.5, quiet: false } };
    expect(environmentWarnings(busy).join(" ")).toContain("50.0% busy");
  });

  test("a dirty tree is a warning", () => {
    expect(environmentWarnings({ ...base, repo: { ...base.repo, dirty: true } }).join(" ")).toContain("dirty");
  });

  test("a machine that got busy during the campaign is a warning", () => {
    const withClose: Environment = {
      ...base,
      close: {
        finishedAt: "2026-08-01T01:00:00.000Z",
        freeMemBytesAtEnd: base.host.freeMemBytesAtStart,
        busyRatioAtEnd: 0.6,
        elapsedSeconds: 3600,
      },
    };
    expect(environmentWarnings(withClose).join(" ")).toContain("still 60.0% busy");
  });

  test("memory disappearing during the campaign is a warning", () => {
    const withClose: Environment = {
      ...base,
      close: {
        finishedAt: "2026-08-01T01:00:00.000Z",
        freeMemBytesAtEnd: 1 * 1024 ** 3,
        busyRatioAtEnd: 0.01,
        elapsedSeconds: 3600,
      },
    };
    expect(environmentWarnings(withClose).join(" ")).toContain("Free memory fell by");
  });
});
