/**
 * We report the median of N runs, never the best. The best run of a set is a
 * measurement of how quiet the machine got, not of the software.
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * Relative standard deviation, in percent - our run-to-run noise figure.
 *
 * NaN, not 0, for fewer than two runs. `--runs 1` used to print "0.0%" in the
 * column headed "run-to-run RSD", which reads as a perfectly reproducible
 * measurement and is in fact the absence of one. A number that has never been
 * repeated has no dispersion to report, and the report prints "n/a".
 */
export function rsd(values: number[]): number {
  if (values.length < 2) return NaN;
  const m = mean(values);
  return m === 0 ? 0 : (stdev(values) / m) * 100;
}

/** the observed spread, which is what a reader of three runs actually wants beside the median */
export function range(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Half-width of the 95% confidence interval of the mean, in the same unit as
 * the values, using a t multiplier for the small n a benchmark actually runs.
 * Returns NaN below two runs: with one measurement there is no interval, and
 * printing +/- 0 would be a claim of certainty nothing supports.
 */
const T95: Record<number, number> = { 2: 12.706, 3: 4.303, 4: 3.182, 5: 2.776, 6: 2.571, 7: 2.447, 8: 2.365, 9: 2.306, 10: 2.262 };

export function ci95(values: number[]): number {
  const n = values.length;
  if (n < 2) return NaN;
  const t = T95[n] ?? 1.96;
  return (t * stdev(values)) / Math.sqrt(n);
}
