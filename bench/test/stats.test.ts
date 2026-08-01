import { describe, expect, test } from "bun:test";
import { ci95, mean, median, range, rsd, stdev } from "../lib/stats";

describe("dispersion that has not been measured is not zero", () => {
  test("rsd of a single run is n/a, not 0%", () => {
    expect(Number.isNaN(rsd([12345]))).toBe(true);
    expect(Number.isNaN(rsd([]))).toBe(true);
  });

  test("rsd of repeated runs is a real figure", () => {
    expect(rsd([100, 100, 100])).toBe(0);
    expect(rsd([90, 100, 110])).toBeCloseTo(10, 5);
  });

  test("ci95 of a single run is n/a, not +/- 0", () => {
    expect(Number.isNaN(ci95([12345]))).toBe(true);
  });

  test("ci95 widens as the runs disagree", () => {
    const tight = ci95([100, 101, 99]);
    const loose = ci95([100, 140, 60]);
    expect(tight).toBeGreaterThan(0);
    expect(loose).toBeGreaterThan(tight);
  });
});

describe("median and range", () => {
  test("the median is reported, never the best", () => {
    expect(median([10, 100, 20])).toBe(20);
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  test("range reports what was actually seen", () => {
    expect(range([14665, 19355, 15422])).toEqual({ min: 14665, max: 19355 });
    expect(range([])).toEqual({ min: 0, max: 0 });
  });

  test("mean and stdev behave", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(stdev([1])).toBe(0);
    expect(stdev([2, 4])).toBeCloseTo(1.4142, 3);
  });
});
