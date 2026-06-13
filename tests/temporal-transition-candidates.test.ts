import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTemporalTransitionCandidateReport,
  type TemporalTransitionFactRow,
} from "../app/governance/temporal-transition-candidates";

function fact(input: Partial<TemporalTransitionFactRow> & Pick<TemporalTransitionFactRow, "id" | "content">): TemporalTransitionFactRow {
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
    topic: input.topic ?? "api-port",
    valid_at: input.valid_at ?? null,
    invalid_at: input.invalid_at ?? null,
    observed_at: input.observed_at ?? null,
    updated_at: input.updated_at ?? "2026-06-05T00:00:00.000Z",
  };
}

test("temporal transition candidates flag competing current facts with missing supersession edge", () => {
  const report = buildTemporalTransitionCandidateReport({
    generatedAt: "2026-06-05T00:00:00.000Z",
    rows: [
      fact({
        id: "api-port-new",
        content: "memory-xx API now uses port 5100.",
        valid_at: "2026-05-20T00:00:00.000Z",
        updated_at: "2026-06-05T00:00:00.000Z",
      }),
      fact({
        id: "api-port-old",
        content: "memory-xx API used port 4001 before migration.",
        valid_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-05-01T00:00:00.000Z",
      }),
    ],
    existingRelations: [],
  });

  assert.equal(report.ok, true);
  assert.equal(report.report_only, true);
  assert.equal(report.apply_allowed, false);
  assert.equal(report.summary.total_rows, 2);
  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.summary.by_suggested_relation.supersedes, 1);
  assert.equal(report.candidates[0]?.newer_memory_id, "api-port-new");
  assert.equal(report.candidates[0]?.older_memory_id, "api-port-old");
  assert.equal(report.candidates[0]?.suggested_relation_type, "supersedes");
  assert.equal(report.candidates[0]?.suggested_older_fact_status, "historical");
  assert.deepEqual(report.candidates[0]?.blockers, ["report_only", "requires_human_review"]);
  assert.deepEqual(report.candidates[0]?.evidence.conflicting_values, ["4001", "5100"]);
});

test("temporal transition candidates skip existing relations, episodic records, and cross-scope pairs", () => {
  const report = buildTemporalTransitionCandidateReport({
    rows: [
      fact({
        id: "api-port-new",
        content: "memory-xx API now uses port 5100.",
        updated_at: "2026-06-05T00:00:00.000Z",
      }),
      fact({
        id: "api-port-old",
        content: "memory-xx API used port 4001 before migration.",
        updated_at: "2026-05-01T00:00:00.000Z",
      }),
      fact({
        id: "status-noise",
        content: "CI progress is 98 percent.",
        memory_type: "status",
        cognitive_type: "episodic",
        topic: "api-port",
      }),
      fact({
        id: "other-scope",
        content: "memory-xx API uses port 6100 in another fork.",
        scope_id: "other-project",
        topic: "api-port",
      }),
    ],
    existingRelations: [
      {
        memory_id: "api-port-new",
        related_memory_id: "api-port-old",
        relation_type: "supersedes",
      },
    ],
  });

  assert.equal(report.summary.total_candidates, 0);
});
