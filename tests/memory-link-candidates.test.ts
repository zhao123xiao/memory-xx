import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMemoryLinkCandidateReport,
  type MemoryLinkCandidateRow,
  type ExistingMemoryRelationRow,
} from "../app/governance/memory-link-candidates";

function memory(input: Partial<MemoryLinkCandidateRow> & Pick<MemoryLinkCandidateRow, "id" | "content">): MemoryLinkCandidateRow {
  return {
    id: input.id,
    scope_type: input.scope_type ?? "project",
    scope_id: input.scope_id ?? "memory-xx",
    title: input.title ?? input.id,
    content: input.content,
    memory_type: input.memory_type ?? "fact",
    memory_class: input.memory_class ?? "long_term_fact",
    cognitive_type: input.cognitive_type ?? null,
    recall_policy: input.recall_policy ?? "default",
    lifecycle_status: input.lifecycle_status ?? "approved",
    review_state: input.review_state ?? "approved",
    is_current: input.is_current ?? true,
    topic: input.topic ?? "tsx-wsl",
    updated_at: input.updated_at ?? "2026-06-05T00:00:00.000Z",
  };
}

function relation(input: ExistingMemoryRelationRow): ExistingMemoryRelationRow {
  return input;
}

test("memory link candidates connect issue, fix, test evidence, and derived procedures", () => {
  const report = buildMemoryLinkCandidateReport({
    generatedAt: "2026-06-05T00:00:00.000Z",
    rows: [
      memory({
        id: "issue",
        title: "tsx WSL failure",
        content: "WSL 下运行 tsx 失败，Windows 临时目录 socket 不兼容。",
        memory_type: "status",
        memory_class: "operational_issue",
        cognitive_type: "episodic",
      }),
      memory({
        id: "fix",
        title: "tsx TMPDIR fix",
        content: "修复方法：运行 tsx 前设置 TMPDIR=/tmp。",
        memory_type: "fact",
        memory_class: "long_term_fact",
        cognitive_type: "semantic",
      }),
      memory({
        id: "test",
        title: "tsx fix verified",
        content: "验证通过：TMPDIR=/tmp node --import tsx --test tests/recall-context-bundle.test.ts exit 0。",
        memory_type: "fact",
        memory_class: "test_evidence",
        cognitive_type: "audit",
        recall_policy: "never",
      }),
      memory({
        id: "procedure",
        title: "tsx WSL runbook",
        content: "排障流程：WSL 中执行 tsx/npm run 前先设置 TMPDIR=/tmp。",
        memory_type: "procedure",
        memory_class: "procedure",
        cognitive_type: "procedural",
      }),
    ],
    existingRelations: [],
  });

  assert.equal(report.ok, true);
  assert.equal(report.report_only, true);
  assert.equal(report.apply_allowed, false);
  assert.equal(report.summary.total_candidates, 4);
  assert.equal(report.summary.by_relation_type.same_issue_as, 1);
  assert.equal(report.summary.by_relation_type.caused_by, 1);
  assert.equal(report.summary.by_relation_type.supports, 1);
  assert.equal(report.summary.by_relation_type.derived_procedure_from, 1);
  assert.ok(report.candidates.every((candidate) => candidate.apply_allowed === false));
  assert.ok(report.candidates.every((candidate) => candidate.blockers.includes("requires_human_review")));

  assert.ok(report.candidates.some((candidate) =>
    candidate.relation_type === "same_issue_as" &&
    candidate.memory_id === "issue" &&
    candidate.related_memory_id === "fix"
  ));
  assert.ok(report.candidates.some((candidate) =>
    candidate.relation_type === "caused_by" &&
    candidate.memory_id === "test" &&
    candidate.related_memory_id === "fix"
  ));
  assert.ok(report.candidates.some((candidate) =>
    candidate.relation_type === "derived_procedure_from" &&
    candidate.memory_id === "procedure" &&
    candidate.related_memory_id === "issue"
  ));
});

test("memory link candidates skip existing relation pairs and unrelated scopes", () => {
  const report = buildMemoryLinkCandidateReport({
    rows: [
      memory({
        id: "issue",
        content: "WSL 下运行 tsx 失败，Windows 临时目录 socket 不兼容。",
        memory_class: "operational_issue",
        cognitive_type: "episodic",
      }),
      memory({
        id: "fix",
        content: "修复方法：运行 tsx 前设置 TMPDIR=/tmp。",
        memory_class: "long_term_fact",
        cognitive_type: "semantic",
      }),
      memory({
        id: "other-scope-fix",
        scope_id: "other-project",
        content: "修复方法：运行 tsx 前设置 TMPDIR=/tmp。",
        memory_class: "long_term_fact",
        cognitive_type: "semantic",
      }),
    ],
    existingRelations: [
      relation({
        memory_id: "issue",
        related_memory_id: "fix",
        relation_type: "same_issue_as",
      }),
    ],
  });

  assert.equal(report.summary.total_candidates, 0);
  assert.deepEqual(report.candidates, []);
});
