import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecallFeedbackPolicyCandidates,
  buildRecallQualityFeedbackReport,
} from "../app/governance/recall-quality-feedback";
import { ScopeType, type JsonObject } from "../app/shared";
import type {
  MemoryRecordRow,
  RecallFeedbackEventRow,
  RecallTraceRow,
} from "../app/db/schema/tables";

function trace(input: {
  readonly id: string;
  readonly queryType: string;
  readonly memoryIds?: readonly string[];
  readonly createdAt?: string;
}): RecallTraceRow {
  return {
    id: input.id,
    queryHash: `hash-${input.id}`,
    queryExcerpt: `query ${input.id}`,
    actorId: "tester",
    scopeContext: { project_ids: ["memory-xx"] },
    queryType: input.queryType,
    strategy: "hybrid",
    degradeLevel: 0,
    results: { memory_ids: [...(input.memoryIds ?? [])] },
    audit: {},
    createdAt: input.createdAt ?? "2026-06-05T00:00:00.000Z",
  };
}

function feedback(input: {
  readonly id: string;
  readonly recallTraceId: string;
  readonly feedbackType: string;
  readonly memoryId?: string | null;
  readonly suspicious?: boolean;
}): RecallFeedbackEventRow {
  return {
    id: input.id,
    recallTraceId: input.recallTraceId,
    memoryId: input.memoryId ?? null,
    actorId: "tester",
    feedbackType: input.feedbackType,
    suspicious: input.suspicious ?? false,
    reason: null,
    metadata: {},
    createdAt: "2026-06-05T00:00:00.000Z",
  };
}

function memory(input: {
  readonly id: string;
  readonly memoryClass: string;
  readonly cognitiveType: string;
}): MemoryRecordRow {
  return {
    id: input.id,
    requestId: `req-${input.id}`,
    scopeType: ScopeType.Project,
    scopeId: "memory-xx",
    content: `memory ${input.id}`,
    title: null,
    summary: null,
    metadata: {
      memory_class: input.memoryClass,
      cognitive_type: input.cognitiveType,
    } as JsonObject,
    contentEmbedding: null,
    dedupeKey: null,
    lifecycleStatus: "approved" as MemoryRecordRow["lifecycleStatus"],
    reviewState: "not_required" as MemoryRecordRow["reviewState"],
    isCurrent: true,
    version: 1,
    createdBy: "tester",
    updatedBy: "tester",
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
    tenantId: "default",
    agentId: "tester",
    governanceStatus: "normal",
    visibility: "scope_only",
    memoryType: null,
    embeddingGeneration: null,
    memoryLayer: "episodic",
    factStatus: "current",
    validAt: null,
    invalidAt: null,
    observedAt: null,
    expiresAt: null,
    episodeId: null,
    importance: 1,
    memoryStrength: 1,
    decayPolicy: "default",
  };
}

test("recall quality feedback aggregates by memory class, cognitive type, and query type", () => {
  const report = buildRecallQualityFeedbackReport({
    traces: [
      trace({ id: "trace-1", queryType: "current_state_query", memoryIds: ["semantic-1", "episodic-1"] }),
      trace({ id: "trace-2", queryType: "current_state_query", memoryIds: ["semantic-1"] }),
      trace({ id: "trace-3", queryType: "procedure_query", memoryIds: ["procedure-1"] }),
      trace({ id: "trace-4", queryType: "current_state_query", memoryIds: [] }),
    ],
    feedbackEvents: [
      feedback({ id: "fb-1", recallTraceId: "trace-1", memoryId: "semantic-1", feedbackType: "used_in_context" }),
      feedback({ id: "fb-2", recallTraceId: "trace-1", memoryId: "episodic-1", feedbackType: "false_positive" }),
      feedback({ id: "fb-3", recallTraceId: "trace-2", memoryId: "semantic-1", feedbackType: "not_relevant" }),
      feedback({ id: "fb-4", recallTraceId: "trace-3", memoryId: "procedure-1", feedbackType: "adopted" }),
      feedback({ id: "fb-5", recallTraceId: "trace-4", feedbackType: "false_null" }),
      feedback({ id: "fb-suspicious", recallTraceId: "trace-3", memoryId: "procedure-1", feedbackType: "false_positive", suspicious: true }),
    ],
    memories: [
      memory({ id: "semantic-1", memoryClass: "long_term_fact", cognitiveType: "semantic" }),
      memory({ id: "episodic-1", memoryClass: "operational_issue", cognitiveType: "episodic" }),
      memory({ id: "procedure-1", memoryClass: "procedure", cognitiveType: "procedural" }),
    ],
    minFeedback: 2,
  });

  const semantic = report.cohorts.find((cohort) =>
    cohort.memory_class === "long_term_fact" &&
    cohort.cognitive_type === "semantic" &&
    cohort.query_type === "current_state_query"
  );
  const episodic = report.cohorts.find((cohort) =>
    cohort.memory_class === "operational_issue" &&
    cohort.cognitive_type === "episodic" &&
    cohort.query_type === "current_state_query"
  );
  const falseNull = report.cohorts.find((cohort) =>
    cohort.memory_class === "no_memory_returned" &&
    cohort.cognitive_type === "none" &&
    cohort.query_type === "current_state_query"
  );

  assert.equal(report.summary.feedback_events, 5);
  assert.equal(report.summary.suspicious_feedback_events, 1);
  assert.equal(semantic?.positive_count, 1);
  assert.equal(semantic?.negative_count, 1);
  assert.equal(semantic?.negative_rate, 0.5);
  assert.equal(semantic?.suggested_action, "review_policy_corpus");
  assert.equal(episodic?.false_positive_count, 1);
  assert.equal(episodic?.suggested_action, "review_temporal_filter");
  assert.equal(falseNull?.false_null_count, 1);
  assert.equal(falseNull?.suggested_action, "open_repair_queue");
});

test("recall quality feedback emits policy corpus and repair candidates from repeated failures", () => {
  const report = buildRecallQualityFeedbackReport({
    traces: [
      trace({ id: "trace-semantic-1", queryType: "current_state_query", memoryIds: ["semantic-1"] }),
      trace({ id: "trace-semantic-2", queryType: "current_state_query", memoryIds: ["semantic-1"] }),
      trace({ id: "trace-episodic-1", queryType: "current_state_query", memoryIds: ["episodic-1"] }),
      trace({ id: "trace-null-1", queryType: "procedure_query", memoryIds: [] }),
      trace({ id: "trace-null-2", queryType: "procedure_query", memoryIds: [] }),
    ],
    feedbackEvents: [
      feedback({ id: "fb-semantic-used", recallTraceId: "trace-semantic-1", memoryId: "semantic-1", feedbackType: "used_in_context" }),
      feedback({ id: "fb-semantic-bad", recallTraceId: "trace-semantic-2", memoryId: "semantic-1", feedbackType: "not_relevant" }),
      feedback({ id: "fb-episodic-fp", recallTraceId: "trace-episodic-1", memoryId: "episodic-1", feedbackType: "false_positive" }),
      feedback({ id: "fb-null-1", recallTraceId: "trace-null-1", feedbackType: "false_null" }),
      feedback({ id: "fb-null-2", recallTraceId: "trace-null-2", feedbackType: "false_null" }),
    ],
    memories: [
      memory({ id: "semantic-1", memoryClass: "long_term_fact", cognitiveType: "semantic" }),
      memory({ id: "episodic-1", memoryClass: "operational_issue", cognitiveType: "episodic" }),
    ],
    minFeedback: 2,
  });

  const candidates = buildRecallFeedbackPolicyCandidates({
    report,
    runId: "feedback-run-1",
  });

  assert.deepEqual(candidates.map((candidate) => candidate.candidate_type), [
    "policy_corpus",
    "temporal_filter_review",
    "repair_queue",
  ]);
  assert.equal(candidates[0]?.sample_id, "feedback-run-1:current_state_query:long_term_fact:semantic");
  assert.equal(candidates[0]?.expected_policy_action, "review_policy_corpus");
  assert.equal(candidates[1]?.expected_policy_action, "review_temporal_filter");
  assert.equal(candidates[2]?.expected_policy_action, "open_repair_queue");
  assert.equal(candidates[2]?.metadata.false_null_count, 2);
});
