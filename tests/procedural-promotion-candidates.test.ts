import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProceduralPromotionCandidateReport,
  type ProceduralPromotionMemoryRow,
} from "../app/governance/procedural-promotion-candidates";
import type {
  RecallFeedbackEventRow,
  RecallTraceRow,
} from "../app/db/schema/tables";
import type { JsonObject } from "../app/shared";

function memory(input: Partial<ProceduralPromotionMemoryRow> & Pick<ProceduralPromotionMemoryRow, "id" | "content">): ProceduralPromotionMemoryRow {
  return {
    id: input.id,
    scope_type: input.scope_type ?? "project",
    scope_id: input.scope_id ?? "memory-xx",
    title: input.title ?? input.id,
    content: input.content,
    memory_type: input.memory_type ?? "procedure",
    memory_class: input.memory_class ?? "procedure",
    cognitive_type: input.cognitive_type ?? "procedural",
    recall_policy: input.recall_policy ?? "default",
    metadata: input.metadata ?? {},
  };
}

function trace(input: {
  readonly id: string;
  readonly queryType?: string;
  readonly projectId?: string;
  readonly userId?: string;
  readonly workspaceId?: string;
  readonly memoryIds?: readonly string[];
}): RecallTraceRow {
  return {
    id: input.id,
    queryHash: `hash-${input.id}`,
    queryExcerpt: `query ${input.id}`,
    actorId: "tester",
    scopeContext: {
      ...(input.projectId ? { project_ids: [input.projectId] } : {}),
      ...(input.userId ? { user_id: input.userId } : {}),
      ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
      ...(input.memoryIds ? { memory_ids: [...input.memoryIds] } : {}),
    },
    queryType: input.queryType ?? "procedure_query",
    strategy: "hybrid",
    degradeLevel: 0,
    results: { memory_ids: [...(input.memoryIds ?? [])] } as JsonObject,
    audit: {},
    createdAt: "2026-06-05T00:00:00.000Z",
  };
}

function feedback(input: {
  readonly id: string;
  readonly traceId: string;
  readonly memoryId: string;
  readonly type?: string;
  readonly suspicious?: boolean;
}): RecallFeedbackEventRow {
  return {
    id: input.id,
    recallTraceId: input.traceId,
    memoryId: input.memoryId,
    actorId: "tester",
    feedbackType: input.type ?? "used_in_context",
    suspicious: input.suspicious ?? false,
    reason: null,
    metadata: {},
    createdAt: "2026-06-05T00:00:00.000Z",
  };
}

test("procedural promotion report emits cross-scope positive candidates without applying global promotion", () => {
  const report = buildProceduralPromotionCandidateReport({
    memories: [
      memory({
        id: "proc-tmpdir",
        content: "When tsx fails on WSL IPC sockets, rerun commands with TMPDIR=/tmp before retrying typecheck.",
      }),
    ],
    traces: [
      trace({ id: "trace-a", projectId: "memory-xx" }),
      trace({ id: "trace-b", projectId: "example-agent" }),
      trace({ id: "trace-c", projectId: "team-tools" }),
    ],
    feedbackEvents: [
      feedback({ id: "fb-a", traceId: "trace-a", memoryId: "proc-tmpdir" }),
      feedback({ id: "fb-b", traceId: "trace-b", memoryId: "proc-tmpdir", type: "adopted" }),
      feedback({ id: "fb-c", traceId: "trace-c", memoryId: "proc-tmpdir" }),
    ],
    minPositiveScopes: 2,
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.candidates[0]?.candidate_type, "cross_scope_procedural_promotion");
  assert.equal(report.candidates[0]?.memory_id, "proc-tmpdir");
  assert.deepEqual(report.candidates[0]?.positive_scope_keys, ["project:memory-xx", "project:example-agent", "project:team-tools"]);
  assert.equal(report.candidates[0]?.positive_feedback_count, 3);
  assert.equal(report.candidates[0]?.suggested_target_scope, "global:procedural-candidates");
  assert.equal(report.candidates[0]?.governor_required, true);
  assert.equal(report.candidates[0]?.apply_allowed, false);
  assert.deepEqual(report.candidates[0]?.blockers, ["report_only", "requires_human_review"]);
});

test("procedural promotion report uses trace scopes when no explicit memory id scope exists", () => {
  const report = buildProceduralPromotionCandidateReport({
    memories: [
      memory({
        id: "proc-retry",
        content: "If a local command fails because of tmp sockets, rerun it with TMPDIR=/tmp.",
      }),
    ],
    traces: [
      trace({ id: "trace-a", projectId: "memory-xx" }),
      trace({ id: "trace-b", projectId: "example-agent" }),
      trace({ id: "trace-c", userId: "user-a" }),
    ],
    feedbackEvents: [
      feedback({ id: "fb-a", traceId: "trace-a", memoryId: "proc-retry" }),
      feedback({ id: "fb-b", traceId: "trace-b", memoryId: "proc-retry" }),
      feedback({ id: "fb-c", traceId: "trace-c", memoryId: "proc-retry" }),
    ],
    minPositiveScopes: 2,
  });

  assert.equal(report.summary.total_candidates, 1);
  assert.deepEqual(report.candidates[0]?.positive_scope_keys, ["project:memory-xx", "project:example-agent", "user:user-a"]);
});

test("procedural promotion report blocks project-specific paths and secrets from promotion eligibility", () => {
  const report = buildProceduralPromotionCandidateReport({
    memories: [
      memory({
        id: "proc-private-path",
        content: "Use /home/example/services/memory-xx/.env with token sk_live_secret_value_12345 when debugging.",
      }),
    ],
    traces: [
      trace({ id: "trace-a", projectId: "memory-xx" }),
      trace({ id: "trace-b", projectId: "example-agent" }),
    ],
    feedbackEvents: [
      feedback({ id: "fb-a", traceId: "trace-a", memoryId: "proc-private-path" }),
      feedback({ id: "fb-b", traceId: "trace-b", memoryId: "proc-private-path" }),
    ],
    minPositiveScopes: 2,
  });

  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.candidates[0]?.privacy_scan.blocked, true);
  assert.equal(report.candidates[0]?.apply_allowed, false);
  assert.equal(report.candidates[0]?.blockers.includes("privacy_or_scope_leakage"), true);
});

test("procedural promotion ignores suspicious or negative feedback and non-procedural memories", () => {
  const report = buildProceduralPromotionCandidateReport({
    memories: [
      memory({ id: "proc-valid", content: "Procedure", memory_type: "ops_learning" }),
      memory({ id: "semantic", content: "Fact", memory_type: "fact", memory_class: "fact", cognitive_type: "semantic" }),
    ],
    traces: [
      trace({ id: "trace-a", projectId: "memory-xx" }),
      trace({ id: "trace-b", projectId: "example-agent" }),
    ],
    feedbackEvents: [
      feedback({ id: "fb-a", traceId: "trace-a", memoryId: "proc-valid", suspicious: true }),
      feedback({ id: "fb-b", traceId: "trace-b", memoryId: "proc-valid", type: "bad_result" }),
      feedback({ id: "fb-c", traceId: "trace-a", memoryId: "semantic" }),
      feedback({ id: "fb-d", traceId: "trace-b", memoryId: "semantic" }),
    ],
    minPositiveScopes: 2,
  });

  assert.equal(report.summary.total_candidates, 0);
});
