interface CounterEntry {
  readonly value: number;
  readonly labels: Record<string, string>;
}

interface HistogramEntry {
  readonly value: number;
  readonly labels: Record<string, string>;
}

interface GaugeEntry {
  readonly value: number;
  readonly labels: Record<string, string>;
}

type HistogramMode = "summary" | "histogram";

const DEFAULT_HISTOGRAM_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900];

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const value = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(",");
  return value ? `{${value}}` : "";
}

export class InMemoryRequestMetrics {
  private readonly counters = new Map<string, CounterEntry[]>();
  private readonly histograms = new Map<string, HistogramEntry[]>();
  private readonly histogramModes = new Map<string, HistogramMode>();
  private readonly gauges = new Map<string, GaugeEntry[]>();

  addCounter(name: string, value: number, labels: Record<string, string> = {}): void {
    const entries = this.counters.get(name) ?? [];
    entries.push({ value, labels });
    this.counters.set(name, entries);
  }

  incrementCounter(name: string, labels: Record<string, string> = {}): void {
    this.addCounter(name, 1, labels);
  }

  observeHistogram(
    name: string,
    value: number,
    labels: Record<string, string> = {},
    mode: HistogramMode = "summary"
  ): void {
    const entries = this.histograms.get(name) ?? [];
    entries.push({ value, labels });
    this.histograms.set(name, entries);
    if (mode === "histogram") {
      this.histogramModes.set(name, "histogram");
    } else if (!this.histogramModes.has(name)) {
      this.histogramModes.set(name, "summary");
    }
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const entries = this.gauges.get(name) ?? [];
    const key = labelKey(labels);
    const next = entries.filter((entry) => labelKey(entry.labels) !== key);
    next.push({ value, labels });
    this.gauges.set(name, next);
  }

  getSnapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [name, entries] of this.counters.entries()) {
      result[name] = entries.reduce((sum, e) => sum + e.value, 0);
    }

    for (const [name, entries] of this.histograms.entries()) {
      const values = entries.map((e) => e.value);
      const sum = values.reduce((a, b) => a + b, 0);
      result[name] = {
        count: values.length,
        sum,
        avg: values.length > 0 ? Math.round(sum / values.length) : 0,
        min: values.length > 0 ? Math.min(...values) : 0,
        max: values.length > 0 ? Math.max(...values) : 0,
      };
    }

    for (const [name, entries] of this.gauges.entries()) {
      if (entries.length === 1 && Object.keys(entries[0]?.labels ?? {}).length === 0) {
        result[name] = entries[0]?.value ?? 0;
      } else {
        result[name] = entries.map((entry) => ({
          value: entry.value,
          labels: { ...entry.labels }
        }));
      }
    }

    return result;
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    this.histogramModes.clear();
    this.gauges.clear();
  }

  getPrometheusSnapshot(): string {
    const lines: string[] = [];

    for (const [name, entries] of this.counters.entries()) {
      const aggregated = new Map<string, number>();
      for (const entry of entries) {
        const labelStr = formatLabels(entry.labels);
        aggregated.set(labelStr, (aggregated.get(labelStr) ?? 0) + entry.value);
      }
      lines.push(`# TYPE ${name} counter`);
      for (const [labelStr, total] of aggregated) {
        lines.push(`${name}${labelStr} ${total}`);
      }
    }

    for (const [name, entries] of this.gauges.entries()) {
      lines.push(`# TYPE ${name} gauge`);
      for (const entry of entries) {
        lines.push(`${name}${formatLabels(entry.labels)} ${entry.value}`);
      }
    }

    for (const [name, entries] of this.histograms.entries()) {
      const mode = this.histogramModes.get(name) ?? "summary";
      if (mode === "histogram") {
        const groups = new Map<string, { labels: Record<string, string>; values: number[]; sum: number }>();
        for (const entry of entries) {
          const key = labelKey(entry.labels);
          const existing = groups.get(key) ?? { labels: entry.labels, values: [], sum: 0 };
          existing.values.push(entry.value);
          existing.sum += entry.value;
          groups.set(key, existing);
        }
        lines.push(`# TYPE ${name} histogram`);
        for (const { labels, values, sum } of groups.values()) {
          for (const bucket of DEFAULT_HISTOGRAM_BUCKETS) {
            const bucketLabels = { ...labels, le: String(bucket) };
            const count = values.filter((value) => value <= bucket).length;
            lines.push(`${name}_bucket${formatLabels(bucketLabels)} ${count}`);
          }
          lines.push(`${name}_bucket${formatLabels({ ...labels, le: "+Inf" })} ${values.length}`);
          lines.push(`${name}_sum${formatLabels(labels)} ${sum}`);
          lines.push(`${name}_count${formatLabels(labels)} ${values.length}`);
        }
        continue;
      }

      const groups = new Map<string, { count: number; sum: number }>();
      for (const entry of entries) {
        const labelStr = formatLabels(entry.labels);
        const existing = groups.get(labelStr) ?? { count: 0, sum: 0 };
        existing.count += 1;
        existing.sum += entry.value;
        groups.set(labelStr, existing);
      }
      lines.push(`# TYPE ${name} summary`);
      for (const [labelStr, { count, sum }] of groups) {
        lines.push(`${name}_count${labelStr} ${count}`);
        lines.push(`${name}_sum${labelStr} ${sum}`);
        if (count > 0) {
          lines.push(`${name}_avg${labelStr} ${Math.round(sum / count)}`);
        }
      }
    }

    return lines.join("\n") + "\n";
  }
}

export let metrics = new InMemoryRequestMetrics();
export function setMetrics(instance: InMemoryRequestMetrics): void {
  metrics = instance;
}

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SNAPSHOT_FILE = join(process.cwd(), "metrics_snapshot.json");
const SAVE_INTERVAL_MS = 60_000;
let saveTimer: ReturnType<typeof setInterval> | null = null;

export function startMetricsPersistence(): void {
  loadFromDisk();
  saveTimer = setInterval(() => saveToDisk(), SAVE_INTERVAL_MS);
  saveTimer.unref();
}

export function stopMetricsPersistence(): void {
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
  saveToDisk();
}

function loadFromDisk(): void {
  try {
    if (!existsSync(SNAPSHOT_FILE)) return;
    const raw = readFileSync(SNAPSHOT_FILE, "utf-8");
    const data = JSON.parse(raw) as {
      counters?: Record<string, number>;
      histograms?: Record<string, { count: number; sum: number; avg: number; min: number; max: number }>;
    };
    if (data.counters) {
      for (const [name, total] of Object.entries(data.counters)) {
        metrics.incrementCounter(name);
        // Overwrite the accumulated count
        const entries = (metrics as any).counters.get(name) as CounterEntry[] | undefined;
        if (entries && entries.length > 0) {
          entries[entries.length - 1] = { value: total, labels: {} };
        }
      }
    }
    if (data.histograms) {
      for (const [name, hist] of Object.entries(data.histograms ?? {})) {
        // Replay as individual observations with average value
        for (let i = 0; i < Math.min(hist.count, 100); i++) {
          metrics.observeHistogram(name, hist.avg);
        }
      }
    }
  } catch {
    // Ignore disk errors — metrics are best-effort
  }
}

function saveToDisk(): void {
  try {
    const snapshot = metrics.getSnapshot();
    writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), "utf-8");
  } catch {
    // Ignore disk errors
  }
}
