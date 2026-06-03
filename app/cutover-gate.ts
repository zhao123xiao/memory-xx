import { defaultGateMetricDefinitions } from "./ops/gates";
import { CutoverStage, GateComparator } from "./ops/types";

export type CutoverGateStatus = "pass" | "degraded-blocked" | "skipped-no-sample";

export interface CutoverGateResult {
  readonly ok: boolean;
  readonly stage: string;
  readonly status: CutoverGateStatus;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly metrics: readonly CutoverGateMetricResult[];
}

export interface CutoverGateMetricInput {
  readonly metricId: string;
  readonly actual?: number;
  readonly sampleSize?: number;
  readonly dataSource?: string;
  readonly window?: string;
  readonly minSampleSize?: number;
}

export interface CutoverGateMetricResult extends CutoverGateMetricInput {
  readonly required: boolean;
  readonly threshold?: number;
  readonly comparator?: GateComparator;
  readonly status: "pass" | "fail" | "skipped-no-sample";
  readonly reason?: string;
}

export interface CutoverGateOptions {
  readonly metrics?: readonly CutoverGateMetricInput[];
  readonly allowDegraded?: boolean;
}

const DEFAULT_MIN_SAMPLE_SIZE = 20;
const HIGH_RISK_DRIFT_METRICS = new Set([
  "candidate_only_false_positive_proxy"
]);

function normalizeStage(stage: string): CutoverStage {
  const value = stage.trim().toLowerCase();
  if (value === "m5" || value === CutoverStage.M5WriteCutover) return CutoverStage.M5WriteCutover;
  return CutoverStage.M4ReadCanary;
}

function compare(actual: number, comparator: GateComparator, threshold: number): boolean {
  switch (comparator) {
    case GateComparator.GreaterThanOrEqual:
      return actual >= threshold;
    case GateComparator.LessThanOrEqual:
      return actual <= threshold;
    case GateComparator.Equal:
      return actual === threshold;
  }
}

export function evaluateCutoverGate(stage = "m4", options: CutoverGateOptions = {}): CutoverGateResult {
  const normalizedStage = normalizeStage(stage);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const metricReadings = new Map((options.metrics ?? []).map((metric) => [metric.metricId, metric]));
  const requiredDefinitions = defaultGateMetricDefinitions(normalizedStage);

  if (!options.metrics || options.metrics.length === 0) {
    blockers.push("cutover_metrics_missing");
  }

  const metrics: CutoverGateMetricResult[] = requiredDefinitions.map((definition) => {
    const reading = metricReadings.get(definition.metricId);
    if (!reading) {
      blockers.push(`${definition.metricId}:skipped-no-sample`);
      return {
        metricId: definition.metricId,
        required: definition.required,
        threshold: definition.threshold,
        comparator: definition.comparator,
        status: "skipped-no-sample",
        reason: "missing_reading"
      };
    }

    const minSampleSize = reading.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
    if (!reading.dataSource?.trim()) blockers.push(`${definition.metricId}:data_source_missing`);
    if (!reading.window?.trim()) blockers.push(`${definition.metricId}:window_missing`);
    if ((reading.sampleSize ?? 0) < minSampleSize) {
      blockers.push(`${definition.metricId}:sample_size_below_minimum`);
      return {
        ...reading,
        required: definition.required,
        threshold: definition.threshold,
        comparator: definition.comparator,
        minSampleSize,
        status: "skipped-no-sample",
        reason: "sample_size_below_minimum"
      };
    }

    const actual = reading.actual;
    if (typeof actual !== "number" || !Number.isFinite(actual)) {
      blockers.push(`${definition.metricId}:actual_missing`);
      return {
        ...reading,
        required: definition.required,
        threshold: definition.threshold,
        comparator: definition.comparator,
        minSampleSize,
        status: "fail",
        reason: "actual_missing"
      };
    }

    const passed = compare(actual, definition.comparator, definition.threshold);
    if (!passed) blockers.push(`${definition.metricId}:threshold_not_met`);
    return {
      ...reading,
      required: definition.required,
      threshold: definition.threshold,
      comparator: definition.comparator,
      minSampleSize,
      status: passed ? "pass" : "fail",
      reason: passed ? undefined : "threshold_not_met"
    };
  });

  for (const reading of options.metrics ?? []) {
    if (!HIGH_RISK_DRIFT_METRICS.has(reading.metricId)) continue;
    if ((reading.actual ?? 0) <= 0) continue;
    const reason = `${reading.metricId}:drift_detected`;
    if (options.allowDegraded) warnings.push(reason);
    else blockers.push(reason);
  }

  return {
    ok: blockers.length === 0,
    stage: normalizedStage,
    status: blockers.length === 0
      ? "pass"
      : blockers.some((blocker) => blocker.includes("skipped-no-sample") || blocker.includes("sample_size"))
        ? "skipped-no-sample"
        : "degraded-blocked",
    blockers,
    warnings,
    metrics
  };
}
