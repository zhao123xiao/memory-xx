import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGraphSuccessorDiscoveryCandidateReport,
  type GraphSuccessorDiscoveryMemoryRow,
  type GraphSuccessorDiscoveryRepairRow,
} from "../app/governance/graph-successor-discovery-candidates";

function repair(input: Partial<GraphSuccessorDiscoveryRepairRow> & Pick<GraphSuccessorDiscoveryRepairRow, "relation_id">): GraphSuccessorDiscoveryRepairRow {
  return {
    relation_id: input.relation_id,
    relation_type: input.relation_type ?? "supports",
    source_memory_id: input.source_memory_id ?? "source-1",
    source_scope_type: input.source_scope_type ?? "project",
    source_scope_id: input.source_scope_id ?? "memory-xx",
    target_memory_id: input.target_memory_id ?? "old-api-port",
    target_scope_type: input.target_scope_type ?? "project",
    target_scope_id: input.target_scope_id ?? "memory-xx",
    target_title: input.target_title ?? "API port",
    target_content: input.target_content ?? "memory-xx API used port 4001 before migration.",
    target_topic: input.target_topic ?? "api-port",
    target_updated_at: input.target_updated_at ?? "2026-05-01T00:00:00.000Z",
    source_lifecycle_status: input.source_lifecycle_status,
    source_is_current: input.source_is_current,
    review_blocker: input.review_blocker ?? "missing_successor",
  };
}

function memory(input: Partial<GraphSuccessorDiscoveryMemoryRow> & Pick<GraphSuccessorDiscoveryMemoryRow, "id" | "content">): GraphSuccessorDiscoveryMemoryRow {
  return {
    id: input.id,
    scope_type: input.scope_type ?? "project",
    scope_id: input.scope_id ?? "memory-xx",
    title: input.title ?? input.id,
    content: input.content,
    topic: input.topic ?? "api-port",
    lifecycle_status: input.lifecycle_status ?? "approved",
    review_state: input.review_state ?? "approved",
    is_current: input.is_current ?? true,
    updated_at: input.updated_at ?? "2026-06-01T00:00:00.000Z",
  };
}

test("successor discovery proposes current approved same-scope memories for missing successor repairs", () => {
  const report = buildGraphSuccessorDiscoveryCandidateReport({
    generatedAt: "2026-06-05T00:00:00.000Z",
    repairs: [
      repair({ relation_id: "rel-api-port" }),
    ],
    memories: [
      memory({
        id: "new-api-port",
        title: "API port",
        content: "memory-xx API now uses port 5100 after migration.",
        updated_at: "2026-06-05T00:00:00.000Z",
      }),
      memory({
        id: "same-scope-weak",
        content: "unrelated release notes mention dashboard copy.",
      }),
    ],
  });

  assert.equal(report.ok, true);
  assert.equal(report.generated_at, "2026-06-05T00:00:00.000Z");
  assert.equal(report.report_only, true);
  assert.equal(report.apply_allowed, false);
  assert.equal(report.summary.total_repairs, 1);
  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.summary.by_suggested_action.review_successor_discovery, 1);
  assert.equal(report.summary.by_match_type.exact_topic, 1);
  assert.equal(report.candidates[0]?.candidate_type, "graph_successor_discovery");
  assert.equal(report.candidates[0]?.relation_id, "rel-api-port");
  assert.equal(report.candidates[0]?.old_target_memory_id, "old-api-port");
  assert.equal(report.candidates[0]?.candidate_successor_memory_id, "new-api-port");
  assert.equal(report.candidates[0]?.suggested_relation_type, "supersedes");
  assert.equal(report.candidates[0]?.suggested_repair_action, "retarget_relation_after_successor_approval");
  assert.equal(report.candidates[0]?.match_type, "exact_topic");
  assert.equal(report.candidates[0]?.apply_allowed, false);
  assert.deepEqual(report.candidates[0]?.blockers, ["report_only", "requires_human_review"]);
  assert.deepEqual(report.candidates[0]?.evidence.shared_terms.includes("migration"), true);
});

test("successor discovery falls back to same-scope lexical match when topic metadata diverges", () => {
  const report = buildGraphSuccessorDiscoveryCandidateReport({
    repairs: [
      repair({
        relation_id: "rel-api-port",
        target_topic: "api-port-old-topic",
        target_content: "memory-xx API runtime used port 4001 before migration.",
      }),
    ],
    memories: [
      memory({
        id: "new-api-port",
        topic: "runtime-port",
        content: "memory-xx API runtime now uses port 5100 after migration.",
        updated_at: "2026-06-05T00:00:00.000Z",
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.summary.by_match_type.same_scope_lexical, 1);
  assert.deepEqual(report.summary.top_topic_alias_suggestions, [
    {
      source_topic: "api-port-old-topic",
      candidate_topic: "runtime-port",
      count: 1,
    },
  ]);
  assert.equal(report.candidates[0]?.candidate_successor_memory_id, "new-api-port");
  assert.equal(report.candidates[0]?.match_type, "same_scope_lexical");
  assert.deepEqual(report.candidates[0]?.topic_alias_suggestion, {
    source_topic: "api-port-old-topic",
    candidate_topic: "runtime-port",
  });
});

test("successor discovery skips non-missing-successor repairs, cross-scope rows, stale rows, and the old target itself", () => {
  const report = buildGraphSuccessorDiscoveryCandidateReport({
    repairs: [
      repair({ relation_id: "rel-ok", review_blocker: "ambiguous_successor" }),
      repair({ relation_id: "rel-missing" }),
    ],
    memories: [
      memory({
        id: "old-api-port",
        content: "memory-xx API used port 4001 before migration.",
      }),
      memory({
        id: "cross-scope",
        scope_id: "other",
        content: "memory-xx API now uses port 5100 after migration.",
      }),
      memory({
        id: "candidate-record",
        content: "memory-xx API now uses port 5100 after migration.",
        lifecycle_status: "candidate",
      }),
      memory({
        id: "not-current",
        content: "memory-xx API now uses port 5100 after migration.",
        is_current: false,
      }),
    ],
  });

  assert.equal(report.summary.total_repairs, 2);
  assert.equal(report.summary.total_candidates, 0);
  assert.deepEqual(report.candidates, []);
});

test("successor discovery skips repairs whose relation source is no longer current approved", () => {
  const report = buildGraphSuccessorDiscoveryCandidateReport({
    repairs: [
      repair({
        relation_id: "rel-historical-source",
        source_lifecycle_status: "tombstone",
        source_is_current: false,
        target_topic: "api-port-old-topic",
        target_content: "memory-xx API runtime used port 4001 before migration.",
      }),
    ],
    memories: [
      memory({
        id: "new-api-port",
        topic: "runtime-port",
        content: "memory-xx API runtime now uses port 5100 after migration.",
        updated_at: "2026-06-05T00:00:00.000Z",
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 0);
  assert.deepEqual(report.summary.top_topic_alias_suggestions, []);
  assert.deepEqual(report.candidates, []);
});

test("successor discovery excludes test fixture repairs from production successor review", () => {
  const report = buildGraphSuccessorDiscoveryCandidateReport({
    repairs: [
      repair({
        relation_id: "relation:l18-fixture:path",
        target_title: "[L18 GRAPH FIXTURE] Qdrant 4096 decision",
        source_created_by: "l18-graph-recall",
        source_metadata: { source: "L18-graph-recall", fixture: true },
        relation_metadata: { source: "L18-graph-recall" },
      }),
    ],
    memories: [
      memory({
        id: "candidate-successor",
        content: "L18 graph recall fixture Qdrant 4096 dimensional embeddings remain indexed.",
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 0);
  assert.deepEqual(report.candidates, []);
});
