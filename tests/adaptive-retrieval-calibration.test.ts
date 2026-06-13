import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdaptiveRetrievalCalibrationReport,
} from "../app/governance/adaptive-retrieval-calibration";
import type {
  RecallFeedbackEventRow,
  RecallTraceRow,
} from "../app/db/schema/tables";
import type { JsonObject } from "../app/shared";

function trace(input: {
  readonly id: string;
  readonly queryType: string;
  readonly projectId?: string;
  readonly ranked?: readonly Record<string, unknown>[];
  readonly memoryIds?: readonly string[];
}): RecallTraceRow {
  return {
    id: input.id,
    queryHash: `hash-${input.id}`,
    queryExcerpt: `query ${input.id}`,
    actorId: "tester",
    scopeContext: { project_ids: [input.projectId ?? "memory-xx"] },
    queryType: input.queryType,
    strategy: "hybrid",
    degradeLevel: 0,
    results: (input.ranked
      ? { ranked: [...input.ranked], memory_ids: input.ranked.map((item) => String(item.memory_id)) }
      : { memory_ids: [...(input.memoryIds ?? [])] }) as JsonObject,
    audit: {},
    createdAt: "2026-06-05T00:00:00.000Z",
  };
}

function feedback(input: {
  readonly id: string;
  readonly recallTraceId: string;
  readonly feedbackType: string;
  readonly suspicious?: boolean;
}): RecallFeedbackEventRow {
  return {
    id: input.id,
    recallTraceId: input.recallTraceId,
    memoryId: null,
    actorId: "tester",
    feedbackType: input.feedbackType,
    suspicious: input.suspicious ?? false,
    reason: null,
    metadata: {},
    createdAt: "2026-06-05T00:00:00.000Z",
  };
}

test("adaptive calibration reports per-scope distance gap score and feedback metrics", () => {
  const report = buildAdaptiveRetrievalCalibrationReport({
    traces: [
      trace({
        id: "trace-good-1",
        queryType: "current_state_query",
        ranked: [
          { memory_id: "a", vector_distance: 0.22, final_score: 0.91, rerank_score: 0.88 },
          { memory_id: "b", vector_distance: 0.39, final_score: 0.64, rerank_score: 0.61 },
        ],
      }),
      trace({
        id: "trace-good-2",
        queryType: "current_state_query",
        ranked: [
          { memory_id: "c", vector_distance: 0.24, final_score: 0.89, rerank_score: 0.84 },
          { memory_id: "d", vector_distance: 0.36, final_score: 0.62, rerank_score: 0.60 },
        ],
      }),
      trace({ id: "trace-empty", queryType: "current_state_query", memoryIds: [] }),
    ],
    feedbackEvents: [
      feedback({ id: "fb-1", recallTraceId: "trace-good-1", feedbackType: "used_in_context" }),
      feedback({ id: "fb-2", recallTraceId: "trace-good-2", feedbackType: "adopted" }),
      feedback({ id: "fb-suspicious", recallTraceId: "trace-good-2", feedbackType: "false_positive", suspicious: true }),
    ],
    minTraces: 2,
  });

  const cohort = report.cohorts.find((item) =>
    item.scope_key === "project:memory-xx" &&
    item.query_type === "current_state_query"
  );

  assert.equal(report.summary.traces, 3);
  assert.equal(report.summary.feedback_events, 2);
  assert.equal(report.summary.suspicious_feedback_events, 1);
  assert.equal(report.summary.production_cohorts, 1);
  assert.equal(report.summary.production_actionable_cohorts, 0);
  assert.equal(cohort?.trace_count, 3);
  assert.equal(cohort?.empty_recall_count, 1);
  assert.equal(cohort?.empty_recall_rate, 0.3333);
  assert.equal(cohort?.avg_top1_distance, 0.23);
  assert.equal(cohort?.avg_top1_top2_gap, 0.145);
  assert.equal(cohort?.avg_top1_rerank_score, 0.86);
  assert.equal(cohort?.negative_feedback_rate, 0);
  assert.equal(cohort?.suggested_action, "hold");
  assert.equal(cohort?.apply_allowed, false);
  assert.deepEqual(cohort?.blockers, ["report_only"]);
});

test("adaptive calibration suggests tightening on false-positive pressure and loosening on empty recall pressure", () => {
  const report = buildAdaptiveRetrievalCalibrationReport({
    traces: [
      trace({
        id: "trace-fp-1",
        queryType: "exact_lookup",
        projectId: "dense-project",
        ranked: [
          { memory_id: "fp-a", distance: 0.18, score: 0.86 },
          { memory_id: "fp-b", distance: 0.19, score: 0.85 },
        ],
      }),
      trace({
        id: "trace-fp-2",
        queryType: "exact_lookup",
        projectId: "dense-project",
        ranked: [
          { memory_id: "fp-c", distance: 0.17, score: 0.87 },
          { memory_id: "fp-d", distance: 0.18, score: 0.86 },
        ],
      }),
      trace({ id: "trace-null-1", queryType: "procedure_query", projectId: "sparse-project", memoryIds: [] }),
      trace({ id: "trace-null-2", queryType: "procedure_query", projectId: "sparse-project", memoryIds: [] }),
    ],
    feedbackEvents: [
      feedback({ id: "fb-fp-1", recallTraceId: "trace-fp-1", feedbackType: "false_positive" }),
      feedback({ id: "fb-fp-2", recallTraceId: "trace-fp-2", feedbackType: "not_relevant" }),
    ],
    minTraces: 2,
    falsePositiveGuardRate: 0.25,
    emptyRecallPressureRate: 0.5,
  });

  const dense = report.cohorts.find((item) => item.scope_key === "project:dense-project");
  const sparse = report.cohorts.find((item) => item.scope_key === "project:sparse-project");

  assert.equal(dense?.suggested_action, "tighten_threshold");
  assert.equal(dense?.reason, "negative_feedback_pressure");
  assert.equal(dense?.apply_allowed, false);
  assert.equal(dense?.blockers.includes("negative_feedback_guard"), true);
  assert.equal(sparse?.suggested_action, "loosen_threshold");
  assert.equal(sparse?.reason, "empty_recall_pressure");
  assert.equal(sparse?.avg_top1_distance, null);
});

test("adaptive calibration records sample-size guard before threshold eligibility", () => {
  const report = buildAdaptiveRetrievalCalibrationReport({
    traces: [
      trace({ id: "trace-one", queryType: "procedure_query", projectId: "small-scope", memoryIds: ["m1"] }),
    ],
    feedbackEvents: [],
    minTraces: 5,
  });

  const cohort = report.cohorts.find((item) => item.scope_key === "project:small-scope");

  assert.equal(cohort?.suggested_action, "collect_more_samples");
  assert.equal(cohort?.threshold_decision.action, "collect_more_samples");
  assert.equal(cohort?.threshold_decision.sample_size_ok, false);
  assert.equal(cohort?.threshold_decision.false_positive_guard_ok, true);
  assert.equal(cohort?.threshold_decision.eligible_for_apply, false);
  assert.equal(cohort?.threshold_decision.audit.sample_size.minimum_traces, 5);
  assert.equal(cohort?.threshold_decision.audit.sample_size.observed_traces, 1);
  assert.equal(cohort?.threshold_decision.audit.guardrails.report_only, true);
  assert.equal(cohort?.threshold_decision.audit.blockers.includes("sample_size_below_minimum"), true);
  assert.equal(report.summary.production_actionable_cohorts, 0);
  assert.equal(report.summary.production_sampling_cohorts, 1);
});

test("adaptive calibration separates explicit memory lookups from production threshold cohorts", () => {
  const report = buildAdaptiveRetrievalCalibrationReport({
    traces: [
      {
        ...trace({
          id: "explicit-a",
          queryType: "project_context",
          memoryIds: [],
        }),
        scopeContext: { memory_ids: ["explicit-a"] },
      },
      {
        ...trace({
          id: "project-a",
          queryType: "project_context",
          projectId: "memory-xx",
          memoryIds: ["m1"],
        }),
        scopeContext: { project_ids: ["memory-xx"] },
      },
    ],
    feedbackEvents: [],
    minTraces: 1,
  });

  const explicit = report.cohorts.find((item) => item.scope_key === "memory:explicit-a");
  const project = report.cohorts.find((item) => item.scope_key === "project:memory-xx");

  assert.equal(report.summary.cohorts, 2);
  assert.equal(report.summary.production_cohorts, 1);
  assert.equal(report.summary.explicit_lookup_cohorts, 1);
  assert.equal(explicit?.lane, "explicit_lookup");
  assert.equal(explicit?.suggested_action, "hold");
  assert.equal(explicit?.reason, "explicit_memory_lookup_not_threshold_calibration");
  assert.equal(explicit?.threshold_decision.eligible_for_apply, false);
  assert.equal(explicit?.blockers.includes("explicit_memory_lookup"), true);
  assert.equal(project?.lane, "production");
});

test("adaptive calibration blocks threshold eligibility when negative feedback guard trips", () => {
  const report = buildAdaptiveRetrievalCalibrationReport({
    traces: [
      trace({ id: "trace-fp-a", queryType: "exact_lookup", projectId: "noisy-scope", memoryIds: ["m1"] }),
      trace({ id: "trace-fp-b", queryType: "exact_lookup", projectId: "noisy-scope", memoryIds: ["m2"] }),
      trace({ id: "trace-fp-c", queryType: "exact_lookup", projectId: "noisy-scope", memoryIds: ["m3"] }),
    ],
    feedbackEvents: [
      feedback({ id: "fb-a", recallTraceId: "trace-fp-a", feedbackType: "false_positive" }),
      feedback({ id: "fb-b", recallTraceId: "trace-fp-b", feedbackType: "not_relevant" }),
      feedback({ id: "fb-c", recallTraceId: "trace-fp-c", feedbackType: "used_in_context" }),
    ],
    minTraces: 3,
    falsePositiveGuardRate: 0.5,
  });

  const cohort = report.cohorts.find((item) => item.scope_key === "project:noisy-scope");

  assert.equal(cohort?.suggested_action, "tighten_threshold");
  assert.equal(cohort?.threshold_decision.action, "tighten_threshold");
  assert.equal(cohort?.threshold_decision.sample_size_ok, true);
  assert.equal(cohort?.threshold_decision.false_positive_guard_ok, false);
  assert.equal(cohort?.threshold_decision.eligible_for_apply, false);
  assert.equal(cohort?.threshold_decision.audit.feedback.false_positive_rate, 0.3333);
  assert.equal(cohort?.threshold_decision.audit.feedback.negative_feedback_rate, 0.6667);
  assert.equal(cohort?.threshold_decision.audit.blockers.includes("negative_feedback_guard"), true);
});

test("adaptive calibration marks guarded empty-recall pressure as a report-only future apply candidate", () => {
  const report = buildAdaptiveRetrievalCalibrationReport({
    traces: [
      trace({ id: "trace-empty-a", queryType: "procedure_query", projectId: "sparse-stable", memoryIds: [] }),
      trace({ id: "trace-empty-b", queryType: "procedure_query", projectId: "sparse-stable", memoryIds: [] }),
      trace({ id: "trace-hit-c", queryType: "procedure_query", projectId: "sparse-stable", memoryIds: ["m3"] }),
    ],
    feedbackEvents: [
      feedback({ id: "fb-positive", recallTraceId: "trace-hit-c", feedbackType: "used_in_context" }),
    ],
    minTraces: 3,
    falsePositiveGuardRate: 0.25,
    emptyRecallPressureRate: 0.5,
  });

  const cohort = report.cohorts.find((item) => item.scope_key === "project:sparse-stable");

  assert.equal(cohort?.suggested_action, "loosen_threshold");
  assert.equal(cohort?.threshold_decision.action, "loosen_threshold");
  assert.equal(cohort?.threshold_decision.sample_size_ok, true);
  assert.equal(cohort?.threshold_decision.false_positive_guard_ok, true);
  assert.equal(cohort?.threshold_decision.eligible_for_apply, true);
  assert.equal(cohort?.threshold_decision.proposed_threshold_delta, "loosen");
  assert.deepEqual(cohort?.threshold_decision.audit.blockers, ["report_only"]);
  assert.equal(cohort?.apply_allowed, false);
});

test("adaptive calibration allows guarded apply only when explicitly enabled", () => {
  const report = buildAdaptiveRetrievalCalibrationReport({
    traces: [
      trace({ id: "trace-empty-enabled-a", queryType: "procedure_query", projectId: "sparse-enabled", memoryIds: [] }),
      trace({ id: "trace-empty-enabled-b", queryType: "procedure_query", projectId: "sparse-enabled", memoryIds: [] }),
      trace({ id: "trace-hit-enabled-c", queryType: "procedure_query", projectId: "sparse-enabled", memoryIds: ["m3"] }),
    ],
    feedbackEvents: [
      feedback({ id: "fb-enabled-positive", recallTraceId: "trace-hit-enabled-c", feedbackType: "used_in_context" }),
    ],
    minTraces: 3,
    falsePositiveGuardRate: 0.25,
    emptyRecallPressureRate: 0.5,
    applyMode: "guarded",
    maxThresholdDelta: 0.01,
  });

  const cohort = report.cohorts.find((item) => item.scope_key === "project:sparse-enabled");

  assert.equal(report.summary.report_only, false);
  assert.equal(cohort?.threshold_decision.eligible_for_apply, true);
  assert.equal(cohort?.threshold_decision.audit.guardrails.report_only, false);
  assert.deepEqual(cohort?.threshold_decision.audit.blockers, []);
  assert.equal(cohort?.apply_allowed, true);
  assert.deepEqual(cohort?.apply_plan, {
    kind: "adaptive_retrieval_threshold_delta",
    scope_key: "project:sparse-enabled",
    query_type: "procedure_query",
    delta: "loosen",
    max_delta: 0.01,
  });
});
