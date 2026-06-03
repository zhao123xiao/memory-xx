import assert from "node:assert/strict";
import test from "node:test";

import { planAutonomousPendingClosure, type PendingAutonomousClosureRow } from "../app/governance/memory-auto-approval-sweep";
import { buildPendingCanaryTrainingReport } from "../app/governance/pending-canary-training-report";

function row(input: {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
}): PendingAutonomousClosureRow {
  return {
    id: input.id,
    scope_type: "project",
    scope_id: "memory-xx",
    title: "canary sample",
    content: input.content,
    memory_type: "fact",
    metadata: { source: "conversation_ingest", agent_id: "codex", ...input.metadata },
    created_by: "codex",
  };
}

test("pending canary training report preserves sweep labels and assistant evidence", () => {
  const rows = [
    row({
      id: "status",
      content: "assistant: 已验证 memory:qdrant-reconcile 输出 missing/stale/payload_drift/orphan 均为 0，Qdrant drift 为 0。",
      metadata: { source_role: "assistant", evidence_refs: ["memory:qdrant-reconcile -- --json"] },
    }),
    row({
      id: "plan",
      content: "assistant: <proposed_plan> # Memory XX Pending Canary 修复计划\n## Summary\n完善自动审批规则。",
      metadata: { source_role: "assistant" },
    }),
  ];
  const plan = planAutonomousPendingClosure(rows);
  const report = buildPendingCanaryTrainingReport({
    runId: "pending-canary-20260603-v1",
    generatedAt: "2026-06-03T00:00:00.000Z",
    rows,
    plan,
  });

  assert.equal(report.ok, true);
  assert.equal(report.pending_count, 2);
  assert.equal(report.sweep_summary.would_approve_default, 1);
  assert.equal(report.sweep_summary.would_event_log_only, 1);
  assert.equal(report.sweep_summary.would_keep_pending, 0);
  assert.equal(report.samples[0]?.assistant_memory_kind, "status_snapshot");
  assert.equal(report.samples[0]?.evidence_level, "tool_observed");
  assert.equal(report.samples[1]?.assistant_memory_kind, "proposed_plan");
  assert.equal(report.samples[1]?.recall_policy, "never");
  assert.equal(report.samples[1]?.policy_action, "reject_by_policy");
});
