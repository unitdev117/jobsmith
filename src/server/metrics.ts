// Hand-written Prometheus exposition; five metrics do not justify a client.

export type MetricLabels = Record<string, string>;

export interface Counter {
  inc(labels?: MetricLabels | undefined, amount?: number): void;
}

export interface Gauge {
  set(value: number): void;
  get(): number;
}

interface Sample {
  labelValues: string[];
  value: number;
}

interface CounterSeries {
  labelNames: string[];
  samples: Map<string, Sample>;
}

const escapeLabel = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

const sampleKey = (values: string[]): string => values.join("\u0000");

// UUID path segments collapse to :id so labels stay bounded.
const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const normalizeRoute = (route: string): string =>
  route
    .split("/")
    .map((segment) => (UUID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");

export class MetricsRegistry {
  private readonly counters = new Map<string, CounterSeries>();
  private readonly gauges = new Map<string, number>();
  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  counter(name: string, labelNames: string[] = []): Counter {
    let series = this.counters.get(name);
    if (!series) {
      series = { labelNames, samples: new Map() };
      this.counters.set(name, series);
    }
    return {
      inc: (labels, amount) => {
        const values = series!.labelNames.map((label) => labels?.[label] ?? "");
        const key = sampleKey(values);
        const sample = series!.samples.get(key) ?? {
          labelValues: values,
          value: 0,
        };
        // Counters only ever move up; a negative nudge is a caller bug.
        if ((amount ?? 1) > 0) {
          sample.value += amount ?? 1;
          series!.samples.set(key, sample);
        }
      },
    };
  }

  gauge(name: string): Gauge {
    return {
      set: (value) => {
        this.gauges.set(name, value);
      },
      get: () => this.gauges.get(name) ?? 0,
    };
  }

  render(): string {
    this.gauges.set(
      "process_uptime_seconds",
      Math.floor((this.now() - this.startedAt) / 1000),
    );
    const lines: string[] = [];
    for (const [name, series] of this.counters) {
      lines.push(`# HELP ${name} ${name}`);
      lines.push(`# TYPE ${name} counter`);
      for (const { labelValues, value } of series.samples.values()) {
        lines.push(renderSample(name, series.labelNames, labelValues, value));
      }
    }
    for (const [name, value] of this.gauges) {
      lines.push(`# HELP ${name} ${name}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(renderSample(name, [], [], value));
    }
    return `${lines.join("\n")}\n`;
  }
}

const renderSample = (
  name: string,
  labelNames: string[],
  labelValues: string[],
  value: number,
): string => {
  if (!labelNames.length) return `${name} ${value}`;
  const pairs = labelNames
    .map(
      (label, index) => `${label}="${escapeLabel(labelValues[index] ?? "")}"`,
    )
    .join(",");
  return `${name}{${pairs}} ${value}`;
};
