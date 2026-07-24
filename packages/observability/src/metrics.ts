/**
 * Minimal, dependency-free Prometheus metrics in the text exposition format. Counters and
 * histograms with labels, rendered at /metrics. (A drop-in for prom-client; kept tiny so the
 * core has no runtime deps.)
 */
type Labels = Record<string, string>;

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${JSON.stringify(labels[k])}`)
    .join(",");
}

function renderLabels(labels: Labels): string {
  const entries = Object.keys(labels)
    .sort()
    // Prometheus exposition escaping: backslash first, then newline and double-quote.
    .map(
      (k) =>
        `${k}="${String(labels[k])
          .replace(/\\/g, "\\\\")
          .replace(/\n/g, "\\n")
          .replace(/"/g, '\\"')}"`,
    );
  return entries.length ? `{${entries.join(",")}}` : "";
}

export class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, amount = 1): void {
    const k = key(labels);
    const cur = this.values.get(k) ?? { labels, value: 0 };
    cur.value += amount;
    this.values.set(k, cur);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels))?.value ?? 0;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values())
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    return lines.join("\n");
  }
}

const DEFAULT_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 800, 1000, 2500];

export class Histogram {
  private readonly buckets: number[];
  private readonly counts = new Map<
    string,
    { labels: Labels; bucketCounts: number[]; sum: number; count: number }
  >();
  constructor(
    readonly name: string,
    readonly help: string,
    buckets: number[] = DEFAULT_BUCKETS,
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }
  observe(value: number, labels: Labels = {}): void {
    const k = key(labels);
    const cur = this.counts.get(k) ?? {
      labels,
      bucketCounts: new Array(this.buckets.length).fill(0),
      sum: 0,
      count: 0,
    };
    cur.sum += value;
    cur.count += 1;
    for (let i = 0; i < this.buckets.length; i++)
      if (value <= this.buckets[i]!) cur.bucketCounts[i]! += 1;
    this.counts.set(k, cur);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, bucketCounts, sum, count } of this.counts.values()) {
      this.buckets.forEach((b, i) =>
        lines.push(
          `${this.name}_bucket${renderLabels({ ...labels, le: String(b) })} ${bucketCounts[i]}`,
        ),
      );
      lines.push(`${this.name}_bucket${renderLabels({ ...labels, le: "+Inf" })} ${count}`);
      lines.push(`${this.name}_sum${renderLabels(labels)} ${sum}`);
      lines.push(`${this.name}_count${renderLabels(labels)} ${count}`);
    }
    return lines.join("\n");
  }
}

export class MetricsRegistry {
  readonly verdicts = new Counter("pharos_verdicts_total", "Total verdicts by decision and tier");
  readonly recordsSealed = new Counter(
    "pharos_records_sealed_total",
    "Total sealed evidence records",
  );
  readonly escalations = new Counter("pharos_escalations_total", "Total escalations parked");
  readonly verdictLatency = new Histogram(
    "pharos_verdict_latency_ms",
    "End-to-end verdict latency (ms)",
  );
  readonly errors = new Counter("pharos_errors_total", "Total errors by route");
  readonly kmsUnavailable = new Counter(
    "pharos_kms_unavailable_total",
    "Total KMS-unavailable events at seal time (signing provider unreachable / breaker open)",
  );

  render(): string {
    return (
      [
        this.verdicts,
        this.recordsSealed,
        this.escalations,
        this.verdictLatency,
        this.errors,
        this.kmsUnavailable,
      ]
        .map((m) => m.render())
        .join("\n\n") + "\n"
    );
  }
}
