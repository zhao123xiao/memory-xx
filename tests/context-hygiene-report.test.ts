import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContextHygieneReport,
  type ContextHygieneReportRow,
} from "../app/governance/context-hygiene-report";

function row(input: Partial<ContextHygieneReportRow> & Pick<ContextHygieneReportRow, "id" | "content">): ContextHygieneReportRow {
  return {
    id: input.id,
    scope_type: input.scope_type ?? "project",
    scope_id: input.scope_id ?? "memory-xx",
    title: input.title ?? input.id,
    content: input.content,
    memory_type: input.memory_type ?? "fact",
    memory_class: input.memory_class ?? null,
    cognitive_type: input.cognitive_type ?? null,
    recall_policy: input.recall_policy ?? "default",
    memory_layer: input.memory_layer ?? null,
    lifecycle_status: input.lifecycle_status ?? "approved",
    review_state: input.review_state ?? "approved",
    is_current: input.is_current ?? true,
    updated_at: input.updated_at ?? "2026-06-05T00:00:00.000Z",
  };
}

test("context hygiene report flags episodic and audit memories leaking into default recall", () => {
  const report = buildContextHygieneReport({
    generatedAt: "2026-06-05T00:00:00.000Z",
    rows: [
      row({
        id: "release-progress",
        content: "CI job is still in progress.",
        memory_class: "runtime_noise",
        cognitive_type: "episodic",
        recall_policy: "default",
      }),
      row({
        id: "audit-material",
        content: "Open source audit evidence.",
        memory_class: "audit_evidence",
        cognitive_type: "audit",
        recall_policy: "default",
      }),
      row({
        id: "stable-fact",
        content: "memory-xx uses context bundles.",
        memory_class: "constraint",
        cognitive_type: "semantic",
        recall_policy: "default",
      }),
      row({
        id: "runbook",
        content: "Use TMPDIR=/tmp before tsx.",
        memory_class: "procedure",
        cognitive_type: "procedural",
        recall_policy: "default",
      }),
    ],
  });

  assert.equal(report.ok, true);
  assert.equal(report.report_only, true);
  assert.equal(report.apply_allowed, false);
  assert.equal(report.summary.total_rows, 4);
  assert.equal(report.summary.total_candidates, 2);
  assert.equal(report.summary.by_reason.episodic_default_recall_leakage, 1);
  assert.equal(report.summary.by_reason.audit_default_recall_leakage, 1);
  assert.equal(report.candidates[0]?.memory_id, "release-progress");
  assert.equal(report.candidates[0]?.suggested_recall_policy, "explicit_only");
  assert.equal(report.candidates[1]?.memory_id, "audit-material");
  assert.equal(report.candidates[1]?.suggested_recall_policy, "never");
});

test("context hygiene report infers cognitive type for legacy rows missing persisted metadata", () => {
  const report = buildContextHygieneReport({
    rows: [
      row({
        id: "legacy-episodic",
        content: "Release job was in progress at one point.",
        cognitive_type: null,
        memory_layer: "episodic",
        recall_policy: "default",
      }),
      row({
        id: "legacy-audit",
        content: "Audit-only evidence should not be default recall.",
        cognitive_type: null,
        memory_layer: "audit",
        recall_policy: "default",
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 2);
  assert.equal(report.candidates[0]?.memory_id, "legacy-episodic");
  assert.equal(report.candidates[0]?.cognitive_type, "episodic");
  assert.equal(report.candidates[0]?.reason, "episodic_default_recall_leakage");
  assert.equal(report.candidates[1]?.memory_id, "legacy-audit");
  assert.equal(report.candidates[1]?.cognitive_type, "audit");
  assert.equal(report.candidates[1]?.reason, "audit_default_recall_leakage");
});
