import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGraphOrphanReport,
  type GraphOrphanReportRow,
} from "../app/governance/graph-orphan-report";

function row(input: Partial<GraphOrphanReportRow> & Pick<GraphOrphanReportRow, "id">): GraphOrphanReportRow {
  return {
    id: input.id,
    scope_type: input.scope_type ?? "project",
    scope_id: input.scope_id ?? "memory-xx",
    title: input.title ?? input.id,
    memory_type: input.memory_type ?? "fact",
    lifecycle_status: input.lifecycle_status ?? "approved",
    review_state: input.review_state ?? "approved",
    is_current: input.is_current ?? true,
    episode_id: "episode_id" in input ? input.episode_id ?? null : "episode-1",
    has_entity_link: input.has_entity_link ?? true,
    has_relation: input.has_relation ?? true,
    relation_id: input.relation_id ?? null,
    relation_type: input.relation_type ?? null,
    relation_memory_id: input.relation_memory_id ?? null,
    relation_related_memory_id: input.relation_related_memory_id ?? null,
    related_exists: input.related_exists ?? null,
    related_lifecycle_status: input.related_lifecycle_status ?? null,
    related_is_current: input.related_is_current ?? null,
    updated_at: input.updated_at ?? "2026-06-05T00:00:00.000Z",
  };
}

test("graph orphan report flags approved current records missing graph structure", () => {
  const report = buildGraphOrphanReport({
    rows: [
      row({ id: "missing-episode", memory_type: "status", episode_id: null }),
      row({ id: "missing-entity", has_entity_link: false }),
      row({ id: "missing-relation", memory_type: "procedure", has_relation: false }),
      row({ id: "candidate", lifecycle_status: "candidate", episode_id: null, has_entity_link: false, has_relation: false }),
    ],
    generatedAt: "2026-06-05T00:00:00.000Z",
  });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, true);
  assert.equal(report.summary.total_candidates, 3);
  assert.equal(report.summary.by_reason.missing_episode, 1);
  assert.equal(report.summary.by_reason.missing_entity_link, 1);
  assert.equal(report.summary.by_reason.missing_relation, 1);
  assert.equal(report.summary.production_candidates, 3);
  assert.equal(report.summary.test_only_candidates, 0);
  assert.equal(report.candidates[0]?.suggested_action, "review_graph_enrichment");
  assert.equal(report.candidates[0]?.lane, "production");
});

test("graph orphan report flags broken relation targets without mutating graph", () => {
  const report = buildGraphOrphanReport({
    rows: [
      row({
        id: "relation-missing-target",
        relation_id: "rel-1",
        relation_type: "supports",
        relation_memory_id: "memory-a",
        relation_related_memory_id: "memory-missing",
        related_exists: false,
      }),
      row({
        id: "relation-stale-target",
        relation_id: "rel-2",
        relation_type: "same_issue_as",
        relation_memory_id: "memory-a",
        relation_related_memory_id: "memory-old",
        related_exists: true,
        related_lifecycle_status: "approved",
        related_is_current: false,
      }),
      row({
        id: "relation-candidate-target",
        relation_id: "rel-3",
        relation_type: "derived_procedure_from",
        relation_memory_id: "memory-a",
        relation_related_memory_id: "memory-candidate",
        related_exists: true,
        related_lifecycle_status: "candidate",
        related_is_current: true,
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 3);
  assert.equal(report.summary.by_reason.missing_relation_target, 1);
  assert.equal(report.summary.by_reason.non_current_relation_target, 1);
  assert.equal(report.summary.by_reason.non_approved_relation_target, 1);
  assert.equal(report.candidates[0]?.suggested_action, "review_relation_repair_or_archive");
  assert.equal(report.candidates.every((candidate) => candidate.apply_allowed === false), true);
});

test("graph orphan report excludes test fixture relations from production storage debt", () => {
  const report = buildGraphOrphanReport({
    rows: [
      row({
        id: "l18-fixture",
        title: "[L18 GRAPH FIXTURE] Qdrant 4096 decision",
        relation_id: "relation:l18-fixture:path",
        relation_type: "supports",
        relation_memory_id: "l18-fixture",
        relation_related_memory_id: "l18_path_qdrant",
        source_created_by: "l18-graph-recall",
        source_metadata: { source: "L18-graph-recall", fixture: true },
        relation_metadata: { source: "L18-graph-recall" },
        related_exists: false,
      }),
      row({
        id: "cross-layer-e2e",
        title: "Cross-layer E2E test - #e2e-crosslayer-a8f12f",
        lifecycle_status: "tombstone",
        is_current: false,
        relation_id: "rel_140666b1-8fb",
        relation_type: "refines",
        relation_memory_id: "cross-layer-e2e",
        relation_related_memory_id: "cross-layer-e2e-old",
        source_created_by: "main",
        related_created_by: "main",
        related_title: "Cross-layer E2E test - #e2e-crosslayer-6b3e9c",
        related_exists: true,
        related_lifecycle_status: "tombstone",
        related_is_current: false,
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 0);
  assert.deepEqual(report.candidates, []);
});

test("graph orphan report keeps test-scope debt visible but out of production readiness", () => {
  const report = buildGraphOrphanReport({
    rows: [
      row({
        id: "api-test-memory",
        scope_type: "workspace",
        scope_id: "current-instance",
        title: "API Test Memory 1780390258",
        memory_type: "status",
        episode_id: null,
        has_entity_link: false,
        has_relation: false,
      }),
      row({
        id: "test-project-relation",
        scope_type: "project",
        scope_id: "accuracy-test",
        title: "AI 模型使用",
        relation_id: "relation_debt_episode_123",
        relation_type: "supports",
        relation_memory_id: "test-project-relation",
        relation_related_memory_id: "old-test-memory",
        related_exists: true,
        related_lifecycle_status: "approved",
        related_is_current: false,
      }),
      row({
        id: "prod-relation",
        scope_type: "project",
        scope_id: "xiaoxiao-default",
        title: "production relation",
        relation_id: "rel-production",
        relation_type: "supports",
        relation_memory_id: "prod-relation",
        relation_related_memory_id: "old-prod-memory",
        related_exists: true,
        related_lifecycle_status: "approved",
        related_is_current: false,
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 5);
  assert.equal(report.summary.test_only_candidates, 4);
  assert.equal(report.summary.production_candidates, 1);
  assert.equal(report.summary.by_lane.test_only, 4);
  assert.equal(report.summary.by_lane.production, 1);
  assert.deepEqual(
    report.candidates.map((candidate) => [candidate.memory_id, candidate.reason, candidate.lane]),
    [
      ["api-test-memory", "missing_entity_link", "test_only"],
      ["api-test-memory", "missing_episode", "test_only"],
      ["api-test-memory", "missing_relation", "test_only"],
      ["prod-relation", "non_current_relation_target", "production"],
      ["test-project-relation", "non_current_relation_target", "test_only"],
    ],
  );
});

test("graph orphan report keeps tombstoned relation endpoints out of production readiness", () => {
  const report = buildGraphOrphanReport({
    rows: [
      row({
        id: "historical-relation-source",
        relation_id: "rel-historical",
        relation_type: "refines",
        relation_memory_id: "historical-source",
        relation_related_memory_id: "historical-target",
        lifecycle_status: "tombstone",
        is_current: false,
        related_exists: true,
        related_lifecycle_status: "tombstone",
        related_is_current: false,
      }),
      row({
        id: "production-relation-source",
        relation_id: "rel-production",
        relation_type: "refines",
        relation_memory_id: "production-source",
        relation_related_memory_id: "production-target",
        related_exists: true,
        related_lifecycle_status: "approved",
        related_is_current: false,
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 2);
  assert.equal(report.summary.production_candidates, 1);
  assert.equal(report.summary.test_only_candidates, 1);
  assert.deepEqual(
    report.candidates.map((candidate) => [candidate.memory_id, candidate.reason, candidate.lane]),
    [
      ["historical-relation-source", "non_current_relation_target", "test_only"],
      ["production-relation-source", "non_current_relation_target", "production"],
    ],
  );
});

test("graph orphan report does not require episode or relation edges for stable semantic memories", () => {
  const report = buildGraphOrphanReport({
    rows: [
      row({
        id: "stable-constraint",
        memory_type: "constraint",
        episode_id: null,
        has_relation: false,
      }),
      row({
        id: "stable-preference",
        memory_type: "preference",
        episode_id: null,
        has_relation: false,
      }),
    ],
  });

  assert.deepEqual(
    report.candidates.map((candidate) => [candidate.memory_id, candidate.reason]),
    [],
  );
  assert.equal(report.summary.production_candidates, 0);
});

test("graph orphan report summarizes top reasons for storage readiness triage", () => {
  const report = buildGraphOrphanReport({
    rows: [
      row({ id: "missing-all-1", memory_type: "status", episode_id: null, has_entity_link: false, has_relation: false }),
      row({ id: "missing-all-2", memory_type: "status", episode_id: null, has_entity_link: false, has_relation: false }),
      row({ id: "missing-relation-3", memory_type: "procedure", has_relation: false }),
      row({
        id: "relation-missing-target",
        relation_id: "rel-1",
        relation_type: "supports",
        related_exists: false,
      }),
    ],
  });

  assert.deepEqual(report.summary.top_reasons, [
    {
      reason: "missing_relation",
      count: 3,
      suggested_action: "review_graph_enrichment",
    },
    {
      reason: "missing_entity_link",
      count: 2,
      suggested_action: "review_graph_enrichment",
    },
    {
      reason: "missing_episode",
      count: 2,
      suggested_action: "review_graph_enrichment",
    },
  ]);
});
