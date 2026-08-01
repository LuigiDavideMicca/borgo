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

/** relative standard deviation, in percent - our run-to-run noise figure */
export function rsd(values: number[]): number {
  const m = mean(values);
  return m === 0 ? 0 : (stdev(values) / m) * 100;
}
