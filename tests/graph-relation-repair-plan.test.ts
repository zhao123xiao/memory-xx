import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGraphRelationRepairPlan,
  type GraphRelationRepairPlanRow,
} from "../app/governance/graph-relation-repair-plan";

function row(input: Partial<GraphRelationRepairPlanRow> & Pick<GraphRelationRepairPlanRow, "relation_id">): GraphRelationRepairPlanRow {
  return {
    relation_id: input.relation_id,
    relation_type: input.relation_type ?? "supports",
    relation_memory_id: input.relation_memory_id ?? "source-1",
    relation_related_memory_id: input.relation_related_memory_id ?? "target-old",
    source_exists: input.source_exists ?? true,
    source_lifecycle_status: input.source_lifecycle_status ?? "approved",
    source_is_current: input.source_is_current ?? true,
    source_created_by: input.source_created_by ?? null,
    source_agent_id: input.source_agent_id ?? null,
    source_title: input.source_title ?? null,
    source_metadata: input.source_metadata ?? null,
    target_exists: input.target_exists ?? true,
    target_lifecycle_status: input.target_lifecycle_status ?? "approved",
    target_is_current: input.target_is_current ?? false,
    target_created_by: input.target_created_by ?? null,
    target_agent_id: input.target_agent_id ?? null,
    target_title: input.target_title ?? null,
    target_metadata: input.target_metadata ?? null,
    relation_metadata: input.relation_metadata ?? null,
    successor_memory_id: input.successor_memory_id ?? null,
    successor_lifecycle_status: input.successor_lifecycle_status ?? null,
    successor_is_current: input.successor_is_current ?? null,
    successor_count: input.successor_count ?? 0,
    updated_at: input.updated_at ?? "2026-06-05T00:00:00.000Z",
  };
}

test("graph relation repair plan suggests retarget when stale target has one current approved successor", () => {
  const report = buildGraphRelationRepairPlan({
    rows: [
      row({
        relation_id: "rel-1",
        relation_type: "supports",
        relation_related_memory_id: "target-old",
        successor_memory_id: "target-current",
        successor_lifecycle_status: "approved",
        successor_is_current: true,
        successor_count: 1,
      }),
    ],
    generatedAt: "2026-06-05T00:00:00.000Z",
  });

  assert.equal(report.ok, true);
  assert.equal(report.generated_at, "2026-06-05T00:00:00.000Z");
  assert.equal(report.report_only, true);
  assert.equal(report.apply_allowed, false);
  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.summary.production_candidates, 1);
  assert.equal(report.summary.test_only_candidates, 0);
  assert.equal(report.summary.by_action.retarget_relation_to_successor, 1);
  assert.deepEqual(report.summary.top_actions, [
    {
      action: "retarget_relation_to_successor",
      count: 1,
    },
  ]);
  assert.equal(report.candidates[0]?.candidate_type, "graph_relation_repair");
  assert.equal(report.candidates[0]?.lane, "production");
  assert.equal(report.candidates[0]?.suggested_action, "retarget_relation_to_successor");
  assert.equal(report.candidates[0]?.suggested_related_memory_id, "target-current");
  assert.equal(report.candidates[0]?.apply_allowed, false);
  assert.deepEqual(report.candidates[0]?.blockers, ["report_only", "requires_human_review"]);
});

test("graph relation repair plan allows guarded apply for unique approved successor retarget", () => {
  const report = buildGraphRelationRepairPlan({
    rows: [
      row({
        relation_id: "rel-guarded",
        relation_type: "supports",
        relation_memory_id: "source-current",
        relation_related_memory_id: "target-old",
        successor_memory_id: "target-current",
        successor_lifecycle_status: "approved",
        successor_is_current: true,
        successor_count: 1,
      }),
    ],
    applyMode: "guarded",
  });

  assert.equal(report.report_only, false);
  assert.equal(report.apply_allowed, true);
  assert.equal(report.summary.apply_allowed, true);
  assert.equal(report.summary.apply_allowed_candidates, 1);
  assert.equal(report.candidates[0]?.apply_allowed, true);
  assert.deepEqual(report.candidates[0]?.blockers, []);
  assert.deepEqual(report.candidates[0]?.apply_plan, {
    kind: "graph_relation_retarget",
    relation_id: "rel-guarded",
    source_memory_id: "source-current",
    old_related_memory_id: "target-old",
    new_related_memory_id: "target-current",
  });
});

test("graph relation repair plan separates missing targets, stale targets without successor, and ambiguous successors", () => {
  const report = buildGraphRelationRepairPlan({
    rows: [
      row({
        relation_id: "rel-missing",
        relation_related_memory_id: "target-missing",
        target_exists: false,
        target_lifecycle_status: null,
        target_is_current: null,
      }),
      row({
        relation_id: "rel-stale",
        relation_related_memory_id: "target-stale",
        target_is_current: false,
        successor_count: 0,
      }),
      row({
        relation_id: "rel-ambiguous",
        relation_related_memory_id: "target-ambiguous",
        target_is_current: false,
        successor_memory_id: "target-current-a",
        successor_lifecycle_status: "approved",
        successor_is_current: true,
        successor_count: 2,
      }),
      row({
        relation_id: "rel-successor-not-current",
        relation_related_memory_id: "target-not-current",
        target_is_current: false,
        successor_memory_id: "target-next",
        successor_lifecycle_status: "candidate",
        successor_is_current: false,
        successor_count: 1,
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 4);
  assert.equal(report.summary.by_reason.missing_relation_target, 1);
  assert.equal(report.summary.by_reason.non_current_relation_target, 3);
  assert.equal(report.summary.by_action.archive_relation_or_restore_target, 1);
  assert.equal(report.summary.by_action.review_successor_before_retarget, 3);
  assert.deepEqual(report.summary.top_review_blockers, [
    {
      blocker: "ambiguous_successor",
      count: 1,
    },
    {
      blocker: "missing_successor",
      count: 1,
    },
    {
      blocker: "successor_not_approved_current",
      count: 1,
    },
  ]);
  assert.deepEqual(
    report.candidates.map((candidate) => [candidate.relation_id, candidate.suggested_action, candidate.review_blocker]),
    [
      ["rel-ambiguous", "review_successor_before_retarget", "ambiguous_successor"],
      ["rel-missing", "archive_relation_or_restore_target", "target_missing_or_source_missing"],
      ["rel-stale", "review_successor_before_retarget", "missing_successor"],
      ["rel-successor-not-current", "review_successor_before_retarget", "successor_not_approved_current"],
    ],
  );
});

test("graph relation repair plan excludes test fixture relations from production repair debt", () => {
  const report = buildGraphRelationRepairPlan({
    rows: [
      row({
        relation_id: "relation:l18-fixture:path",
        relation_memory_id: "l18-fixture",
        relation_related_memory_id: "l18_path_qdrant",
        source_created_by: "l18-graph-recall",
        source_title: "[L18 GRAPH FIXTURE] Qdrant 4096 decision",
        source_metadata: { source: "L18-graph-recall", fixture: true },
        relation_metadata: { source: "L18-graph-recall" },
        target_exists: false,
        target_lifecycle_status: null,
        target_is_current: null,
      }),
      row({
        relation_id: "rel_140666b1-8fb",
        relation_type: "refines",
        relation_memory_id: "cross-layer-e2e",
        relation_related_memory_id: "cross-layer-e2e-old",
        source_lifecycle_status: "tombstone",
        source_is_current: false,
        source_created_by: "main",
        source_title: "Cross-layer E2E test - #e2e-crosslayer-a8f12f",
        target_lifecycle_status: "tombstone",
        target_is_current: false,
        target_created_by: "main",
        target_title: "Cross-layer E2E test - #e2e-crosslayer-6b3e9c",
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 0);
  assert.deepEqual(report.candidates, []);
});

test("graph relation repair plan keeps test-scope relation debt out of production readiness", () => {
  const report = buildGraphRelationRepairPlan({
    rows: [
      row({
        relation_id: "relation_debt_episode_accuracy",
        relation_memory_id: "accuracy-source",
        relation_related_memory_id: "accuracy-target",
        source_title: "AI 模型使用",
      }),
      row({
        relation_id: "relation_debt_self_tombstone",
        relation_memory_id: "self-test",
        relation_related_memory_id: "self-test",
        source_title: "tombstone debug",
      }),
      row({
        relation_id: "rel-production",
        relation_memory_id: "production-source",
        relation_related_memory_id: "production-target",
        source_title: "production relation",
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 3);
  assert.equal(report.summary.test_only_candidates, 2);
  assert.equal(report.summary.production_candidates, 1);
  assert.equal(report.summary.by_lane.test_only, 2);
  assert.equal(report.summary.by_lane.production, 1);
  assert.deepEqual(
    report.candidates.map((candidate) => [candidate.relation_id, candidate.lane]),
    [
      ["rel-production", "production"],
      ["relation_debt_episode_accuracy", "test_only"],
      ["relation_debt_self_tombstone", "test_only"],
    ],
  );
});

test("graph relation repair plan keeps tombstoned source and target relations out of production readiness", () => {
  const report = buildGraphRelationRepairPlan({
    rows: [
      row({
        relation_id: "rel-historical",
        relation_memory_id: "historical-source",
        relation_related_memory_id: "historical-target",
        source_lifecycle_status: "tombstone",
        source_is_current: false,
        target_lifecycle_status: "tombstone",
        target_is_current: false,
      }),
      row({
        relation_id: "rel-production",
        relation_memory_id: "production-source",
        relation_related_memory_id: "production-target",
        source_lifecycle_status: "approved",
        source_is_current: true,
        target_lifecycle_status: "approved",
        target_is_current: false,
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 2);
  assert.equal(report.summary.production_candidates, 1);
  assert.equal(report.summary.test_only_candidates, 1);
  assert.deepEqual(
    report.candidates.map((candidate) => [candidate.relation_id, candidate.lane]),
    [
      ["rel-historical", "test_only"],
      ["rel-production", "production"],
    ],
  );
});
