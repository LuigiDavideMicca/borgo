// hand-rolled prometheus text exposition, enabled with BORGO_METRICS=1: request
// count by route pattern + status, one duration histogram per route pattern,
// process uptime. patterns keep the cardinality bounded by the page table.
export const BUCKETS = [0.005, 0.025, 0.1, 0.5, 1, 5] as const;

const MAX_ROUTES = 100;

export type Metrics = {
  observe: (route: string, status: number, seconds: number) => void;
  render: () => string;
};

const escapeLabel = (s: string) =>
  s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

export function createMetrics(start = Date.now()): Metrics {
  const requests = new Map<string, number>();
  const durations = new Map<string, { count: number; sum: number; buckets: number[] }>();

  return {
    observe(route, status, seconds) {
      if (durations.size >= MAX_ROUTES && !durations.has(route)) route = "other";
      const key = `${route}\u0000${status}`;
      requests.set(key, (requests.get(key) ?? 0) + 1);

      let series = durations.get(route);
      if (!series) {
        series = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
        durations.set(route, series);
      }
      series.count++;
      series.sum += seconds;
      for (let i = 0; i < BUCKETS.length; i++) {
        if (seconds <= BUCKETS[i]) series.buckets[i]++;
      }
    },

    render() {
      const lines: string[] = [];
      lines.push("# HELP borgo_http_requests_total requests handled by the front server");
      lines.push("# TYPE borgo_http_requests_total counter");
      for (const [key, count] of requests) {
        const [route, status] = key.split("\u0000");
        lines.push(`borgo_http_requests_total{route="${escapeLabel(route)}",status="${status}"} ${count}`);
      }
      lines.push("# HELP borgo_http_request_duration_seconds request duration by route pattern");
      lines.push("# TYPE borgo_http_request_duration_seconds histogram");
      for (const [route, series] of durations) {
        const label = escapeLabel(route);
        for (let i = 0; i < BUCKETS.length; i++) {
          lines.push(
            `borgo_http_request_duration_seconds_bucket{route="${label}",le="${BUCKETS[i]}"} ${series.buckets[i]}`,
          );
        }
        lines.push(`borgo_http_request_duration_seconds_bucket{route="${label}",le="+Inf"} ${series.count}`);
        lines.push(`borgo_http_request_duration_seconds_sum{route="${label}"} ${series.sum}`);
        lines.push(`borgo_http_request_duration_seconds_count{route="${label}"} ${series.count}`);
      }
      lines.push("# HELP borgo_process_uptime_seconds seconds since the front server started");
      lines.push("# TYPE borgo_process_uptime_seconds gauge");
      lines.push(`borgo_process_uptime_seconds ${(Date.now() - start) / 1000}`);
      return lines.join("\n") + "\n";
    },
  };
}
