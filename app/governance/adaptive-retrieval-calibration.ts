import type {
  RecallFeedbackEventRow,
  RecallTraceRow,
} from "../db/schema/tables";

export type AdaptiveRetrievalSuggestedAction =
  | "hold"
  | "tighten_threshold"
  | "loosen_threshold"
  | "collect_more_samples";

export type AdaptiveRetrievalThresholdDelta = "none" | "tighten" | "loosen";

export interface AdaptiveRetrievalThresholdDecisionAudit {
  readonly sample_size: {
    readonly observed_traces: number;
    readonly minimum_traces: number;
    readonly ok: boolean;
  };
  readonly feedback: {
    readonly feedback_count: number;
    readonly negative_feedback_rate: number;
    readonly false_positive_rate: number;
    readonly guard_rate: number;
    readonly guard_ok: boolean;
  };
  readonly recall_pressure: {
    readonly empty_recall_rate: number;
    readonly pressure_rate: number;
    readonly pressure_detected: boolean;
  };
  readonly guardrails: {
    readonly report_only: boolean;
  };
  readonly blockers: readonly string[];
}

export interface AdaptiveRetrievalThresholdDecision {
  readonly action: AdaptiveRetrievalSuggestedAction;
  readonly proposed_threshold_delta: AdaptiveRetrievalThresholdDelta;
  readonly sample_size_ok: boolean;
  readonly false_positive_guard_ok: boolean;
  readonly eligible_for_apply: boolean;
  readonly reason: string;
  readonly audit: AdaptiveRetrievalThresholdDecisionAudit;
}

export interface AdaptiveRetrievalCalibrationCohort {
  readonly scope_key: string;
  readonly query_type: string;
  readonly lane: "production" | "explicit_lookup";
  readonly trace_count: number;
  readonly empty_recall_count: number;
  readonly empty_recall_rate: number;
  readonly feedback_count: number;
  readonly negative_feedback_count: number;
  readonly false_positive_count: number;
  readonly negative_feedback_rate: number;
  readonly avg_top1_distance: number | null;
  readonly avg_top1_top2_gap: number | null;
  readonly avg_top1_score: number | null;
  readonly avg_top1_rerank_score: number | null;
  readonly suggested_action: AdaptiveRetrievalSuggestedAction;
  readonly reason: string;
  readonly threshold_decision: AdaptiveRetrievalThresholdDecision;
  readonly apply_allowed: boolean;
  readonly apply_plan?: AdaptiveRetrievalApplyPlan;
  readonly blockers: readonly string[];
}

export interface AdaptiveRetrievalCalibrationReport {
  readonly summary: {
    readonly traces: number;
    readonly feedback_events: number;
    readonly suspicious_feedback_events: number;
    readonly cohorts: number;
    readonly production_cohorts: number;
    readonly production_actionable_cohorts: number;
    readonly production_sampling_cohorts: number;
    readonly explicit_lookup_cohorts: number;
    readonly report_only: boolean;
    readonly apply_allowed_cohorts: number;
  };
  readonly cohorts: readonly AdaptiveRetrievalCalibrationCohort[];
}

export interface AdaptiveRetrievalApplyPlan {
  readonly kind: "adaptive_retrieval_threshold_delta";
  readonly scope_key: string;
  readonly query_type: string;
  readonly delta: Exclude<AdaptiveRetrievalThresholdDelta, "none">;
  readonly max_delta: number;
}

export interface BuildAdaptiveRetrievalCalibrationReportInput {
  readonly traces: readonly RecallTraceRow[];
  readonly feedbackEvents: readonly RecallFeedbackEventRow[];
  readonly minTraces?: number;
  readonly falsePositiveGuardRate?: number;
  readonly emptyRecallPressureRate?: number;
  readonly applyMode?: "report_only" | "guarded";
  readonly maxThresholdDelta?: number;
}

interface RankedMetric {
  readonly memory_id: string;
  readonly distance: number | null;
  readonly score: number | null;
  readonly rerank_score: number | null;
}

interface FeedbackCounts {
  feedback_count: number;
  negative_feedback_count: number;
  false_positive_count: number;
}

interface MutableCohort {
  scope_key: string;
  query_type: string;
  trace_count: number;
  empty_recall_count: number;
  feedback_count: number;
  negative_feedback_count: number;
  false_positive_count: number;
  top1_distances: number[];
  top1_top2_gaps: number[];
  top1_scores: number[];
  top1_rerank_scores: number[];
}

const NEGATIVE_FEEDBACK = new Set(["ignored", "not_relevant", "false_positive"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function firstString(value: unknown): string | null {
  const values = stringArray(value);
  return values[0] ?? null;
}

function scopeKey(trace: RecallTraceRow): string {
  const context = trace.scopeContext;
  const memoryId = firstString(context.memory_ids);
  if (memoryId) return `memory:${memoryId}`;
  const projectId = firstString(context.project_ids);
  if (projectId) return `project:${projectId}`;
  const userId = typeof context.user_id === "string" && context.user_id.trim() ? context.user_id.trim() : null;
  if (userId) return `user:${userId}`;
  const workspaceId = typeof context.workspace_id === "string" && context.workspace_id.trim() ? context.workspace_id.trim() : null;
  if (workspaceId) return `workspace:${workspaceId}`;
  return "scope:unknown";
}

function laneForScope(scope: string): AdaptiveRetrievalCalibrationCohort["lane"] {
  return scope.startsWith("memory:") ? "explicit_lookup" : "production";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function rankedMetrics(trace: RecallTraceRow): readonly RankedMetric[] {
  const ranked = recordArray(trace.results.ranked);
  return ranked
    .map((item): RankedMetric => ({
      memory_id: String(item.memory_id ?? item.id ?? ""),
      distance: numberValue(item.vector_distance ?? item.distance ?? item.qdrant_distance),
      score: numberValue(item.final_score ?? item.score),
      rerank_score: numberValue(item.rerank_score ?? item.model_score),
    }))
    .filter((item) => item.memory_id.length > 0);
}

function memoryIds(trace: RecallTraceRow, ranked: readonly RankedMetric[]): readonly string[] {
  if (ranked.length > 0) return ranked.map((item) => item.memory_id);
  return stringArray(trace.results.memory_ids);
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function feedbackCountsByTrace(feedbackEvents: readonly RecallFeedbackEventRow[]): Map<string, FeedbackCounts> {
  const byTrace = new Map<string, FeedbackCounts>();
  for (const event of feedbackEvents) {
    if (event.suspicious) continue;
    const existing = byTrace.get(event.recallTraceId) ?? {
      feedback_count: 0,
      negative_feedback_count: 0,
      false_positive_count: 0,
    };
    existing.feedback_count += 1;
    if (NEGATIVE_FEEDBACK.has(event.feedbackType)) existing.negative_feedback_count += 1;
    if (event.feedbackType === "false_positive") existing.false_positive_count += 1;
    byTrace.set(event.recallTraceId, existing);
  }
  return byTrace;
}

function thresholdDecisionFor(input: {
  readonly traceCount: number;
  readonly minTraces: number;
  readonly lane: AdaptiveRetrievalCalibrationCohort["lane"];
  readonly feedbackCount: number;
  readonly emptyRecallRate: number;
  readonly negativeFeedbackRate: number;
  readonly falsePositiveRate: number;
  readonly falsePositiveGuardRate: number;
  readonly emptyRecallPressureRate: number;
  readonly reportOnly: boolean;
}): AdaptiveRetrievalThresholdDecision {
  const sampleSizeOk = input.traceCount >= input.minTraces;
  const falsePositiveGuardOk =
    input.falsePositiveRate < input.falsePositiveGuardRate &&
    input.negativeFeedbackRate < input.falsePositiveGuardRate;
  const emptyRecallPressure = input.emptyRecallRate >= input.emptyRecallPressureRate;
  let action: AdaptiveRetrievalSuggestedAction = "hold";
  let reason = "within_guardrails";
  let proposedThresholdDelta: AdaptiveRetrievalThresholdDelta = "none";
  const blockers: string[] = input.reportOnly ? ["report_only"] : [];

  if (input.lane === "explicit_lookup") {
    action = "hold";
    reason = "explicit_memory_lookup_not_threshold_calibration";
    blockers.push("explicit_memory_lookup");
  } else if (!sampleSizeOk) {
    action = "collect_more_samples";
    reason = "sample_size_below_minimum";
    blockers.push("sample_size_below_minimum");
  } else if (!falsePositiveGuardOk) {
    action = "tighten_threshold";
    reason = "negative_feedback_pressure";
    proposedThresholdDelta = "tighten";
    blockers.push("negative_feedback_guard");
  } else if (emptyRecallPressure) {
    action = "loosen_threshold";
    reason = "empty_recall_pressure";
    proposedThresholdDelta = "loosen";
  }

  const eligibleForApply =
    input.lane === "production" &&
    sampleSizeOk &&
    falsePositiveGuardOk &&
    (action === "tighten_threshold" || action === "loosen_threshold");

  return {
    action,
    proposed_threshold_delta: proposedThresholdDelta,
    sample_size_ok: sampleSizeOk,
    false_positive_guard_ok: falsePositiveGuardOk,
    eligible_for_apply: eligibleForApply,
    reason,
    audit: {
      sample_size: {
        observed_traces: input.traceCount,
        minimum_traces: input.minTraces,
        ok: sampleSizeOk,
      },
      feedback: {
        feedback_count: input.feedbackCount,
        negative_feedback_rate: input.negativeFeedbackRate,
        false_positive_rate: input.falsePositiveRate,
        guard_rate: input.falsePositiveGuardRate,
        guard_ok: falsePositiveGuardOk,
      },
      recall_pressure: {
        empty_recall_rate: input.emptyRecallRate,
        pressure_rate: input.emptyRecallPressureRate,
        pressure_detected: emptyRecallPressure,
      },
      guardrails: {
        report_only: input.reportOnly,
      },
      blockers,
    },
  };
}

export function buildAdaptiveRetrievalCalibrationReport(
  input: BuildAdaptiveRetrievalCalibrationReportInput
): AdaptiveRetrievalCalibrationReport {
  const minTraces = input.minTraces ?? 20;
  const falsePositiveGuardRate = input.falsePositiveGuardRate ?? 0.05;
  const emptyRecallPressureRate = input.emptyRecallPressureRate ?? 0.5;
  const reportOnly = input.applyMode !== "guarded";
  const maxThresholdDelta = input.maxThresholdDelta ?? 0.01;
  const feedbackByTrace = feedbackCountsByTrace(input.feedbackEvents);
  const cohorts = new Map<string, MutableCohort>();
  const suspiciousFeedback = input.feedbackEvents.filter((event) => event.suspicious).length;

  function cohortFor(trace: RecallTraceRow): MutableCohort {
    const key = `${scopeKey(trace)}\u0000${trace.queryType}`;
    const existing = cohorts.get(key);
    if (existing) return existing;
    const created: MutableCohort = {
      scope_key: scopeKey(trace),
      query_type: trace.queryType,
      trace_count: 0,
      empty_recall_count: 0,
      feedback_count: 0,
      negative_feedback_count: 0,
      false_positive_count: 0,
      top1_distances: [],
      top1_top2_gaps: [],
      top1_scores: [],
      top1_rerank_scores: [],
    };
    cohorts.set(key, created);
    return created;
  }

  for (const trace of input.traces) {
    const cohort = cohortFor(trace);
    const ranked = rankedMetrics(trace);
    const ids = memoryIds(trace, ranked);
    const feedback = feedbackByTrace.get(trace.id);
    cohort.trace_count += 1;
    if (ids.length === 0) cohort.empty_recall_count += 1;
    if (feedback) {
      cohort.feedback_count += feedback.feedback_count;
      cohort.negative_feedback_count += feedback.negative_feedback_count;
      cohort.false_positive_count += feedback.false_positive_count;
    }

    const top1 = ranked[0];
    const top2 = ranked[1];
    if (top1?.distance !== null && top1?.distance !== undefined) cohort.top1_distances.push(top1.distance);
    if (top1?.distance !== null && top1?.distance !== undefined && top2?.distance !== null && top2?.distance !== undefined) {
      cohort.top1_top2_gaps.push(Math.max(0, top2.distance - top1.distance));
    }
    if (top1?.score !== null && top1?.score !== undefined) cohort.top1_scores.push(top1.score);
    if (top1?.rerank_score !== null && top1?.rerank_score !== undefined) cohort.top1_rerank_scores.push(top1.rerank_score);
  }

  const rows = [...cohorts.values()]
    .map((cohort): AdaptiveRetrievalCalibrationCohort => {
      const emptyRecallRate = cohort.trace_count > 0 ? round(cohort.empty_recall_count / cohort.trace_count) : 0;
      const negativeFeedbackRate = cohort.feedback_count > 0 ? round(cohort.negative_feedback_count / cohort.feedback_count) : 0;
      const falsePositiveRate = cohort.feedback_count > 0 ? round(cohort.false_positive_count / cohort.feedback_count) : 0;
      const thresholdDecision = thresholdDecisionFor({
        traceCount: cohort.trace_count,
        minTraces,
        lane: laneForScope(cohort.scope_key),
        feedbackCount: cohort.feedback_count,
        emptyRecallRate,
        negativeFeedbackRate,
        falsePositiveRate,
        falsePositiveGuardRate,
        emptyRecallPressureRate,
        reportOnly,
      });
      const applyPlan = buildApplyPlan({
        scopeKey: cohort.scope_key,
        queryType: cohort.query_type,
        decision: thresholdDecision,
        maxThresholdDelta,
      });
      return {
        scope_key: cohort.scope_key,
        query_type: cohort.query_type,
        lane: laneForScope(cohort.scope_key),
        trace_count: cohort.trace_count,
        empty_recall_count: cohort.empty_recall_count,
        empty_recall_rate: emptyRecallRate,
        feedback_count: cohort.feedback_count,
        negative_feedback_count: cohort.negative_feedback_count,
        false_positive_count: cohort.false_positive_count,
        negative_feedback_rate: negativeFeedbackRate,
        avg_top1_distance: average(cohort.top1_distances),
        avg_top1_top2_gap: average(cohort.top1_top2_gaps),
        avg_top1_score: average(cohort.top1_scores),
        avg_top1_rerank_score: average(cohort.top1_rerank_scores),
        suggested_action: thresholdDecision.action,
        reason: thresholdDecision.reason,
        threshold_decision: thresholdDecision,
        apply_allowed: applyPlan !== undefined,
        ...(applyPlan ? { apply_plan: applyPlan } : {}),
        blockers: thresholdDecision.audit.blockers,
      };
    })
    .sort((left, right) =>
      left.scope_key.localeCompare(right.scope_key) ||
      left.query_type.localeCompare(right.query_type)
    );

  return {
    summary: {
      traces: input.traces.length,
      feedback_events: input.feedbackEvents.length - suspiciousFeedback,
      suspicious_feedback_events: suspiciousFeedback,
      cohorts: rows.length,
      production_cohorts: rows.filter((row) => row.lane === "production").length,
      production_actionable_cohorts: rows.filter((row) =>
        row.lane === "production" &&
        (row.suggested_action === "tighten_threshold" || row.suggested_action === "loosen_threshold")
      ).length,
      production_sampling_cohorts: rows.filter((row) =>
        row.lane === "production" &&
        row.suggested_action === "collect_more_samples"
      ).length,
      explicit_lookup_cohorts: rows.filter((row) => row.lane === "explicit_lookup").length,
      report_only: reportOnly,
      apply_allowed_cohorts: rows.filter((row) => row.apply_allowed).length,
    },
    cohorts: rows,
  };
}

function buildApplyPlan(input: {
  readonly scopeKey: string;
  readonly queryType: string;
  readonly decision: AdaptiveRetrievalThresholdDecision;
  readonly maxThresholdDelta: number;
}): AdaptiveRetrievalApplyPlan | undefined {
  if (!input.decision.eligible_for_apply) return undefined;
  if (input.decision.audit.guardrails.report_only) return undefined;
  if (input.decision.proposed_threshold_delta === "none") return undefined;
  if (input.decision.audit.blockers.length > 0) return undefined;
  return {
    kind: "adaptive_retrieval_threshold_delta",
    scope_key: input.scopeKey,
    query_type: input.queryType,
    delta: input.decision.proposed_threshold_delta,
    max_delta: input.maxThresholdDelta,
  };
}
