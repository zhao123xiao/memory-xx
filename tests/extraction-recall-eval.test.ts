import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExtractionRecallEvalReport,
  buildExtractionRecallEvalPolicyCandidates,
} from "../app/governance/extraction-recall-eval";
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
    createdAt: "2026-06-05T00:00:00.000Z",
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
  readonly memoryClass?: string;
  readonly cognitiveType?: string;
  readonly policyAction?: string;
  readonly recallPolicy?: string;
  readonly source?: string;
  readonly nestedPolicy?: boolean;
}): MemoryRecordRow {
  const policy = {
    ...(input.memoryClass ? { memory_class: input.memoryClass } : {}),
    ...(input.cognitiveType ? { cognitive_type: input.cognitiveType } : {}),
    ...(input.policyAction ? { policy_action: input.policyAction } : {}),
    ...(input.recallPolicy ? { recall_policy: input.recallPolicy } : {}),
  };
  const metadata: JsonObject = input.nestedPolicy
    ? { source: input.source ?? "conversation_ingest", auto_approval_policy: { memory_policy: policy } }
    : { source: input.source ?? "conversation_ingest", ...policy };

  return {
    id: input.id,
    requestId: `req-${input.id}`,
    scopeType: ScopeType.Project,
    scopeId: "memory-xx",
    content: `memory ${input.id}`,
    title: null,
    summary: null,
    metadata,
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
    memoryLayer: "semantic",
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

test("extraction recall eval compares write policy decisions against downstream feedback", () => {
  const report = buildExtractionRecallEvalReport({
    traces: [
      trace({ id: "trace-1", queryType: "current_state_query", memoryIds: ["episodic-1"] }),
      trace({ id: "trace-2", queryType: "current_state_query", memoryIds: ["episodic-1"] }),
      trace({ id: "trace-3", queryType: "procedure_query", memoryIds: ["procedure-1"] }),
      trace({ id: "trace-4", queryType: "procedure_query", memoryIds: [] }),
      trace({ id: "trace-5", queryType: "procedure_query", memoryIds: [] }),
    ],
    feedbackEvents: [
      feedback({ id: "fb-1", recallTraceId: "trace-1", memoryId: "episodic-1", feedbackType: "false_positive" }),
      feedback({ id: "fb-2", recallTraceId: "trace-2", memoryId: "episodic-1", feedbackType: "not_relevant" }),
      feedback({ id: "fb-3", recallTraceId: "trace-3", memoryId: "procedure-1", feedbackType: "adopted" }),
      feedback({ id: "fb-4", recallTraceId: "trace-4", feedbackType: "false_null" }),
      feedback({ id: "fb-5", recallTraceId: "trace-5", feedbackType: "false_null" }),
      feedback({ id: "fb-suspicious", recallTraceId: "trace-3", memoryId: "procedure-1", feedbackType: "false_positive", suspicious: true }),
    ],
    memories: [
      memory({
        id: "episodic-1",
        memoryClass: "operational_issue",
        cognitiveType: "episodic",
        policyAction: "create_memory",
        recallPolicy: "default",
      }),
      memory({
        id: "procedure-1",
        memoryClass: "procedure",
        cognitiveType: "procedural",
        policyAction: "create_memory",
        recallPolicy: "default",
        nestedPolicy: true,
      }),
    ],
    minFeedback: 2,
  });

  const episodic = report.cohorts.find((cohort) =>
    cohort.memory_class === "operational_issue" &&
    cohort.cognitive_type === "episodic" &&
    cohort.query_type === "current_state_query"
  );
  const falseNull = report.false_null_cohorts.find((cohort) => cohort.query_type === "procedure_query");

  assert.equal(report.summary.feedback_events, 5);
  assert.equal(report.summary.suspicious_feedback_events, 1);
  assert.equal(episodic?.policy_action, "create_memory");
  assert.equal(episodic?.recall_policy, "default");
  assert.equal(episodic?.false_positive_count, 1);
  assert.equal(episodic?.negative_rate, 1);
  assert.equal(episodic?.mismatch_kind, "episodic_default_recall_leakage");
  assert.equal(episodic?.suggested_action, "tighten_extraction_or_recall_policy");
  assert.equal(falseNull?.false_null_count, 2);
  assert.equal(falseNull?.suggested_action, "add_repair_training_sample");
});

test("extraction recall eval emits report-only policy and repair candidates", () => {
  const report = buildExtractionRecallEvalReport({
    traces: [
      trace({ id: "trace-fp", queryType: "current_state_query", memoryIds: ["memory-fp"] }),
      trace({ id: "trace-fn", queryType: "debug_recall", memoryIds: [] }),
    ],
    feedbackEvents: [
      feedback({ id: "fb-fp", recallTraceId: "trace-fp", memoryId: "memory-fp", feedbackType: "false_positive" }),
      feedback({ id: "fb-fn", recallTraceId: "trace-fn", feedbackType: "false_null" }),
    ],
    memories: [
      memory({
        id: "memory-fp",
        memoryClass: "runtime_noise",
        cognitiveType: "audit",
        policyAction: "create_memory",
        recallPolicy: "default",
        source: "codex-session-tail",
      }),
    ],
    minFeedback: 1,
  });

  const candidates = buildExtractionRecallEvalPolicyCandidates({
    report,
    runId: "extraction-eval-run-1",
  });

  assert.deepEqual(candidates.map((candidate) => candidate.candidate_type), [
    "policy_corpus",
    "repair_queue",
  ]);
  assert.equal(candidates[0]?.sample_id, "extraction-eval-run-1:current_state_query:runtime_noise:audit:create_memory:default");
  assert.equal(candidates[0]?.metadata.mismatch_kind, "audit_default_recall_leakage");
  assert.equal(candidates[1]?.sample_id, "extraction-eval-run-1:debug_recall:false_null");
  assert.equal(candidates[1]?.metadata.false_null_count, 1);
});
