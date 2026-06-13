import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTemporalValidityDebtReport,
  type TemporalValidityDebtRow,
} from "../app/governance/temporal-validity-debt-report";

function row(input: Partial<TemporalValidityDebtRow> & Pick<TemporalValidityDebtRow, "id" | "content">): TemporalValidityDebtRow {
  return {
    id: input.id,
    scope_type: input.scope_type ?? "project",
    scope_id: input.scope_id ?? "memory-xx",
    title: input.title ?? input.id,
    content: input.content,
    memory_type: input.memory_type ?? "fact",
    memory_class: input.memory_class ?? "long_term_fact",
    cognitive_type: input.cognitive_type ?? "semantic",
    recall_policy: input.recall_policy ?? "default",
    lifecycle_status: input.lifecycle_status ?? "approved",
    review_state: input.review_state ?? "approved",
    is_current: input.is_current ?? true,
    fact_status: input.fact_status ?? "current",
    valid_at: "valid_at" in input ? input.valid_at ?? null : null,
    invalid_at: "invalid_at" in input ? input.invalid_at ?? null : null,
    observed_at: "observed_at" in input ? input.observed_at ?? null : "2026-05-20T00:00:00.000Z",
    review_at: "review_at" in input ? input.review_at ?? null : null,
    expires_at: "expires_at" in input ? input.expires_at ?? null : null,
    updated_at: input.updated_at ?? "2026-06-05T00:00:00.000Z",
  };
}

test("temporal validity debt report flags current facts missing validity metadata", () => {
  const report = buildTemporalValidityDebtReport({
    generatedAt: "2026-06-05T00:00:00.000Z",
    rows: [
      row({
        id: "api-port",
        content: "memory-xx API uses port 5100.",
        valid_at: null,
        observed_at: null,
      }),
    ],
  });

  assert.equal(report.ok, true);
  assert.equal(report.report_only, true);
  assert.equal(report.apply_allowed, false);
  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.summary.by_reason.current_fact_missing_valid_at, 1);
  assert.equal(report.summary.by_suggested_action.review_temporal_metadata, 1);
  assert.equal(report.candidates[0]?.memory_id, "api-port");
  assert.equal(report.candidates[0]?.suggested_action, "review_temporal_metadata");
  assert.deepEqual(report.candidates[0]?.blockers, ["report_only", "requires_human_review"]);
});

test("temporal validity debt report flags progress snapshots that need review_at and recall isolation", () => {
  const report = buildTemporalValidityDebtReport({
    rows: [
      row({
        id: "ci-progress",
        content: "GitHub CI build-and-test 还在跑，当前进度约 98%。",
        memory_type: "status",
        memory_class: "operational_issue",
        cognitive_type: "episodic",
        recall_policy: "default",
        observed_at: "2026-06-05T00:00:00.000Z",
        review_at: null,
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.summary.by_reason.progress_snapshot_missing_review_at, 1);
  assert.equal(report.summary.by_reason.episodic_current_default_recall, 1);
  assert.equal(report.summary.by_suggested_action.isolate_temporal_snapshot, 1);
  assert.equal(report.candidates[0]?.suggested_recall_policy, "explicit_only");
  assert.equal(report.candidates[0]?.suggested_fact_status, "historical");
});

test("temporal validity debt report treats isolated historical snapshots as reviewed", () => {
  const report = buildTemporalValidityDebtReport({
    rows: [
      row({
        id: "isolated-progress",
        content: "GitHub CI build-and-test 还在跑，当前进度约 98%。",
        memory_type: "status",
        memory_class: "operational_issue",
        cognitive_type: "episodic",
        recall_policy: "explicit_only",
        fact_status: "historical",
        observed_at: "2026-06-05T00:00:00.000Z",
        review_at: null,
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 0);
});

test("temporal validity debt report does not treat lessons or runbooks as progress snapshots", () => {
  const report = buildTemporalValidityDebtReport({
    rows: [
      row({
        id: "cleanup-lesson",
        title: "[LESSON:operational] Memory V2 cleanup 误操事件与防重犯约束",
        content: "误操事件：node_modules 已通过 npm install 恢复；后续执行 cleanup 前必须确认路径。",
        memory_type: "lesson",
        memory_class: "procedural_constraint",
        cognitive_type: null,
        recall_policy: "default",
        valid_at: "2026-06-02T00:00:00.000Z",
        observed_at: "2026-06-02T00:00:00.000Z",
      }),
      row({
        id: "manifest-runbook",
        title: "embedding manifest 不一致修复步骤",
        content: "修复命令：memory:embedding-manifest status，然后 refresh --force-reconcile。",
        memory_type: "preference",
        memory_class: "preference",
        cognitive_type: null,
        recall_policy: "default",
        valid_at: "2026-06-02T00:00:00.000Z",
        observed_at: "2026-06-02T00:00:00.000Z",
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 0);
});

test("temporal validity debt report separates test-only corpus rows from production debt", () => {
  const report = buildTemporalValidityDebtReport({
    rows: [
      row({
        id: "policy-corpus",
        scope_type: "global",
        scope_id: "memory-policy-eval-memory-benchmark-50k-v1",
        title: "policy-corpus:beam:beam-123",
        content: "Can you summarize how my job search progressed? LLM response should contain expected text.",
        recall_policy: "test_only",
        memory_class: "long_term_fact",
        cognitive_type: null,
        observed_at: "2026-05-31T00:00:00.000Z",
      }),
      row({
        id: "release-progress",
        title: "GitHub CI progress",
        content: "GitHub CI build-and-test 还在跑，当前进度约 98%。",
        memory_type: "status",
        cognitive_type: "episodic",
        recall_policy: "default",
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 2);
  assert.equal(report.summary.production_candidates, 1);
  assert.equal(report.summary.test_only_candidates, 1);
  assert.equal(report.candidates.find((candidate) => candidate.memory_id === "policy-corpus")?.lane, "test_only");
  assert.equal(report.candidates.find((candidate) => candidate.memory_id === "release-progress")?.lane, "production");
});

test("temporal validity debt report flags historical facts that remain current", () => {
  const report = buildTemporalValidityDebtReport({
    rows: [
      row({
        id: "old-port",
        content: "Old API port was 4001 before the migration.",
        memory_type: "fact",
        cognitive_type: "semantic",
        recall_policy: "default",
        fact_status: "current",
        valid_at: "2026-04-01T00:00:00.000Z",
        invalid_at: "2026-05-20T00:00:00.000Z",
      }),
      row({
        id: "archived",
        content: "Archived fact.",
        is_current: false,
        invalid_at: "2026-05-20T00:00:00.000Z",
      }),
    ],
  });

  assert.equal(report.summary.total_rows, 2);
  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.summary.by_reason.invalidated_fact_still_current, 1);
  assert.equal(report.candidates[0]?.memory_id, "old-port");
  assert.equal(report.candidates[0]?.suggested_action, "review_temporal_metadata");
  assert.equal(report.candidates[0]?.suggested_fact_status, "historical");
});
