import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMarkdownDocument,
  classifyMarkdownDocuments,
  type MarkdownCandidate,
  type MarkdownGovernanceCurrentState,
} from "../app/knowledge/markdown-governance";

const currentState: MarkdownGovernanceCurrentState = {
  now: "2026-06-03T00:00:00.000Z",
  runtimeOk: true,
  candidateCurrent: 31,
  qdrantDrift: false,
  p1GatePass: true,
  productionGuardOk: false,
};

function candidate(overrides: Partial<MarkdownCandidate>): MarkdownCandidate {
  return {
    path: "/workspace/local/docs/memory-xx/operations/example.md",
    relative_path: "docs/memory-xx/operations/example.md",
    size_bytes: 1024,
    modified_at: "2026-04-17T00:00:00.000Z",
    content: "# Example\n\nCurrent memory-xx operation note.",
    content_hash: "hash",
    ...overrides,
  };
}

test("closed open-items register is obsolete and should not be imported", () => {
  const result = classifyMarkdownDocument(candidate({
    path: "/workspace/local/docs/memory-xx/operations/open-items-register.md",
    relative_path: "docs/memory-xx/operations/open-items-register.md",
    modified_at: "2026-04-17T00:00:00.000Z",
    content: [
      "# Open Items Register",
      "O-01 ~ O-04 签收链已全部正式闭环。",
      "Rollback 窗口已确认（2026-04-14 签收，窗口至 2026-04-30）。",
      "正式关闭需 rollback 窗口观察期（至 2026-04-30）无明显报错。",
    ].join("\n"),
  }), currentState);

  assert.equal(result.lifecycle, "archive_obsolete_no_import");
  assert.equal(result.doc_type, "status_register");
  assert.equal(result.verified_against_current_state, true);
  assert.match(result.classification_reason, /closed_or_expired_status_register/u);
});

test("latest test report with currently useful failures is imported as project evidence", () => {
  const result = classifyMarkdownDocument(candidate({
    path: "/workspace/local/memory-xx-test-report-2026-06-02.md",
    relative_path: "memory-xx-test-report-2026-06-02.md",
    modified_at: "2026-06-02T00:00:00.000Z",
    content: [
      "# Memory-v2 完整测试报告",
      "**测试日期:** 2026-06-02",
      "| filter_mode=all | 403 | ❌ FAIL | admin token 也需额外 scope grant |",
      "| MCP 协议 | 17/17 | PASS | HTTP 传输是正确测试方式 |",
    ].join("\n"),
  }), currentState);

  assert.equal(result.lifecycle, "import_current");
  assert.equal(result.doc_type, "test_report");
  assert.equal(result.collection, "project:memory-xx:docs");
  assert.equal(result.verified_against_current_state, true);
  assert.match(result.classification_reason, /recent_test_report_with_actionable_evidence/u);
});

test("older draft plans are marked duplicate when a newer verified report covers the same topic", () => {
  const oldPlan = candidate({
    path: "/workspace/local/docs/memory-xx/operations/recall-phase2-optimization-plan.md",
    relative_path: "docs/memory-xx/operations/recall-phase2-optimization-plan.md",
    modified_at: "2026-04-14T00:00:00.000Z",
    content: "# memory-xx Recall 第二阶段优化方案\n\n当前 recall 仍不稳定，需要后续优化。",
  });
  const newerReport = candidate({
    path: "/workspace/local/services/memory-xx/reports/memory-xx-functionality-gap-assessment-20260602.md",
    relative_path: "services/memory-xx/reports/memory-xx-functionality-gap-assessment-20260602.md",
    modified_at: "2026-06-02T00:00:00.000Z",
    content: "# Memory XX Gap Assessment\n\nP1 gate 通过，Qdrant drift 为 0，recall 当前主链路正常。",
  });

  const results = classifyMarkdownDocuments([oldPlan, newerReport], currentState);
  const old = results.find((item) => item.path === oldPlan.path);
  const newer = results.find((item) => item.path === newerReport.path);

  assert.ok(old);
  assert.ok(newer);
  assert.equal(old.lifecycle, "archive_duplicate_no_import");
  assert.match(old.classification_reason, /superseded_by_newer_memory_xx_report/u);
  assert.equal(newer.lifecycle, "import_current");
});

test("third-party markdown is excluded before content classification", () => {
  const result = classifyMarkdownDocument(candidate({
    path: "/workspace/local/openclaw/node_modules/pkg/README.md",
    relative_path: "openclaw/node_modules/pkg/README.md",
    content: "# Third party package",
  }), currentState);

  assert.equal(result.lifecycle, "exclude_third_party");
  assert.equal(result.doc_type, "third_party");
  assert.match(result.classification_reason, /excluded_path/u);
});

test("ambiguous markdown stays quarantined for manual review", () => {
  const result = classifyMarkdownDocument(candidate({
    path: "/workspace/local/notes/random.md",
    relative_path: "notes/random.md",
    modified_at: "2026-05-01T00:00:00.000Z",
    content: "# Random\n\nSome notes without memory-xx status, report evidence, or current operational value.",
  }), currentState);

  assert.equal(result.lifecycle, "quarantine_uncertain");
  assert.equal(result.collection, null);
  assert.match(result.classification_reason, /insufficient_current_project_signal/u);
});
