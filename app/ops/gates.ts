import {
  CutoverStage,
  GateComparator,
  GateDecision,
  MetricStatus,
  type GateEvaluation,
  type GateMetricDefinition,
  type GateMetricReading,
  type GateMetricResult
} from "./types";

const DEFAULT_M4_METRICS: readonly GateMetricDefinition[] = [
  {
    metricId: "query_pass_rate",
    label: "关键 query 类型通过率",
    comparator: GateComparator.GreaterThanOrEqual,
    threshold: 0.95,
    required: true
  },
  {
    metricId: "default_filter_accuracy",
    label: "默认过滤关键样本正确率",
    comparator: GateComparator.Equal,
    threshold: 1,
    required: true
  },
  {
    metricId: "zero_hit_regression_delta",
    label: "零命中（zero-hit）异常率相对旧基线增量",
    comparator: GateComparator.LessThanOrEqual,
    threshold: 0,
    required: true
  },
  {
    metricId: "cache_invalidation_accuracy",
    label: "缓存失效（cache invalidation）抽检正确率",
    comparator: GateComparator.Equal,
    threshold: 1,
    required: true
  }
];

const DEFAULT_M5_METRICS: readonly GateMetricDefinition[] = [
  {
    metricId: "idempotency_conflict_accuracy",
    label: "幂等冲突处理正确率",
    comparator: GateComparator.Equal,
    threshold: 1,
    required: true
  },
  {
    metricId: "projection_consistency_accuracy",
    label: "投影（projection）最终一致性抽检正确率",
    comparator: GateComparator.Equal,
    threshold: 1,
    required: true
  },
  {
    metricId: "legacy_write_ingress_after_freeze",
    label: "旧写冻结后残留生产写次数",
    comparator: GateComparator.Equal,
    threshold: 0,
    required: true
  },
  {
    metricId: "dual_write_incidents",
    label: "双主写事件数",
    comparator: GateComparator.Equal,
    threshold: 0,
    required: true
  }
];

export function defaultGateMetricDefinitions(stage: CutoverStage): readonly GateMetricDefinition[] {
  return stage === CutoverStage.M4ReadCanary ? DEFAULT_M4_METRICS : DEFAULT_M5_METRICS;
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

export function evaluateGateMetrics(input: {
  stage: CutoverStage;
  definitions?: readonly GateMetricDefinition[];
  readings: readonly GateMetricReading[];
}): GateEvaluation {
  const definitions = input.definitions ?? defaultGateMetricDefinitions(input.stage);
  const readingMap = new Map(input.readings.map((reading) => [reading.metricId, reading]));

  const metrics: GateMetricResult[] = definitions.map((definition) => {
    const reading = readingMap.get(definition.metricId);
    if (!reading) {
      return {
        metricId: definition.metricId,
        label: definition.label,
        comparator: definition.comparator,
        threshold: definition.threshold,
        actual: null,
        status: MetricStatus.Fail,
        required: definition.required,
        reason: "missing_reading"
      };
    }

    const passed = compare(reading.actual, definition.comparator, definition.threshold);

    return {
      metricId: definition.metricId,
      label: definition.label,
      comparator: definition.comparator,
      threshold: definition.threshold,
      actual: reading.actual,
      status: passed ? MetricStatus.Pass : MetricStatus.Fail,
      required: definition.required,
      reason: passed ? undefined : "threshold_not_met",
      unit: reading.unit,
      sampleSize: reading.sampleSize,
      notes: reading.notes
    };
  });

  const blockingReasons = metrics
    .filter((metric) => metric.required && metric.status === MetricStatus.Fail)
    .map((metric) => `${metric.metricId}:${metric.reason ?? "failed"}`);

  return {
    stage: input.stage,
    decision: blockingReasons.length === 0 ? GateDecision.Pass : GateDecision.Hold,
    metrics,
    blockingReasons
  };
}
