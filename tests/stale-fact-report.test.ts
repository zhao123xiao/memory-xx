import assert from "node:assert/strict";
import test from "node:test";

import { buildStaleFactReport, type StaleFactReportRow } from "../app/governance/stale-fact-report";

function row(input: Partial<StaleFactReportRow> & Pick<StaleFactReportRow, "id" | "content">): StaleFactReportRow {
  return {
    id: input.id,
    scope_type: input.scope_type ?? "project",
    scope_id: input.scope_id ?? "memory-xx",
    title: input.title ?? input.id,
    content: input.content,
    memory_type: input.memory_type ?? "fact",
    lifecycle_status: input.lifecycle_status ?? "approved",
    review_state: input.review_state ?? "approved",
    is_current: input.is_current ?? true,
    fact_status: input.fact_status ?? "current",
    valid_at: input.valid_at ?? "2026-05-01T00:00:00.000Z",
    invalid_at: input.invalid_at ?? null,
    observed_at: input.observed_at ?? "2026-05-01T00:00:00.000Z",
    updated_at: input.updated_at ?? "2026-05-01T00:00:00.000Z",
    relation_id: input.relation_id ?? null,
    relation_type: input.relation_type ?? null,
    relation_direction: input.relation_direction ?? null,
    related_memory_id: input.related_memory_id ?? null,
    related_title: input.related_title ?? null,
    related_content: input.related_content ?? null,
    related_lifecycle_status: input.related_lifecycle_status ?? null,
    related_is_current: input.related_is_current ?? null,
    relation_created_at: input.relation_created_at ?? null,
  };
}

test("stale fact report flags current facts superseded by newer facts", () => {
  const report = buildStaleFactReport({
    generatedAt: "2026-06-05T00:00:00.000Z",
    rows: [
      row({
        id: "old-port",
        content: "API uses port 4001.",
        relation_id: "rel-1",
        relation_type: "supersedes",
        relation_direction: "inbound",
        related_memory_id: "new-port",
        related_title: "Current API port",
        related_content: "API uses port 5100.",
        related_lifecycle_status: "approved",
        related_is_current: true,
        relation_created_at: "2026-05-20T00:00:00.000Z",
      }),
    ],
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.summary.by_reason.superseded_current_fact, 1);
  assert.equal(report.candidates[0]?.memory_id, "old-port");
  assert.equal(report.candidates[0]?.suggested_action, "mark_invalid_or_superseded");
  assert.equal(report.candidates[0]?.related_memory_id, "new-port");
});

test("stale fact report flags unresolved current fact contradictions", () => {
  const report = buildStaleFactReport({
    rows: [
      row({
        id: "port-a",
        content: "API uses port 4001.",
        relation_id: "rel-2",
        relation_type: "contradicts",
        relation_direction: "outbound",
        related_memory_id: "port-b",
        related_content: "API uses port 5100.",
        related_lifecycle_status: "approved",
        related_is_current: true,
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.summary.by_reason.contradicted_current_fact, 1);
  assert.equal(report.candidates[0]?.suggested_action, "human_temporal_review");
  assert.equal(report.candidates[0]?.relation_type, "contradicts");
});

test("stale fact report excludes non-current, invalidated, and non-fact rows", () => {
  const report = buildStaleFactReport({
    rows: [
      row({
        id: "already-invalid",
        content: "Old status.",
        fact_status: "superseded",
        invalid_at: "2026-05-20T00:00:00.000Z",
        relation_type: "supersedes",
        relation_direction: "inbound",
        related_memory_id: "new",
        related_lifecycle_status: "approved",
        related_is_current: true,
      }),
      row({
        id: "procedure",
        content: "Run TMPDIR=/tmp before tsx.",
        memory_type: "procedure",
        relation_type: "contradicts",
        related_memory_id: "other",
        related_lifecycle_status: "approved",
        related_is_current: true,
      }),
      row({
        id: "archived",
        content: "Archived fact.",
        is_current: false,
        relation_type: "supersedes",
        related_memory_id: "new",
        related_lifecycle_status: "approved",
        related_is_current: true,
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 0);
  assert.deepEqual(report.candidates, []);
});
