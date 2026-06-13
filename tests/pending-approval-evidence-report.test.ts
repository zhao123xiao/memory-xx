import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPendingApprovalEvidenceReport,
  buildPendingSafeClosePlan,
  type PendingApprovalEvidenceRow,
} from "../app/governance/pending-approval-evidence-report";

function row(input: {
  id: string;
  scopeId?: string;
  title: string;
  content: string;
  memoryType?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}): PendingApprovalEvidenceRow {
  return {
    id: input.id,
    scope_type: "project",
    scope_id: input.scopeId ?? "memory-xx",
    title: input.title,
    content: input.content,
    memory_type: input.memoryType ?? "constraint",
    metadata: {
      source: input.source ?? "conversation_ingest",
      agent_id: "codex",
      ...input.metadata,
    },
    created_by: "klee",
  };
}

test("pending approval evidence report explains stable approvals, topic drift, progress snapshots, and quarantine", () => {
  const report = buildPendingApprovalEvidenceReport({
    generatedAt: "2026-06-05T00:00:00.000Z",
    rows: [
      row({
        id: "stable-env",
        title: "WSL 下 tsx 运行需设置 TMPDIR=/tmp",
        content: "tsx 默认将 IPC pipe 放在 Windows 临时目录，WSL 下不支持这种 socket，需设置 TMPDIR=/tmp 才能运行。",
        memoryType: "preference",
      }),
      row({
        id: "memory-xx-drift",
        title: "memory-xx README 完善计划决策",
        content: "memory-xx README 完善计划：目标是完善公开 README，不写入真实私有路径。",
      }),
      row({
        id: "ci-progress",
        title: "full-stack-release-gate 已通过",
        content: "assistant: full-stack-release-gate 已通过。现在只剩 build-and-test 还在跑，继续等最后一个 job。",
      }),
      row({
        id: "unknown-source",
        title: "周度短时记忆晋升",
        content: "短时记忆晋升记录",
        source: "unknown",
        metadata: {
          memory_class: "unknown_source_quarantine",
          recall_policy: "never",
        },
      }),
    ],
  });

  assert.equal(report.ok, true);
  assert.equal(report.report_only, true);
  assert.equal(report.summary.total_rows, 4);
  assert.equal(report.summary.total_evidence_items, 4);
  assert.equal(report.summary.actionable_without_human_review, 3);
  assert.equal(report.summary.requires_human_review, 1);
  assert.equal(report.summary.by_recommended_lane.approve_candidate, 1);
  assert.equal(report.summary.by_recommended_lane.event_log_only, 2);
  assert.equal(report.summary.by_recommended_lane.quarantine_or_reject, 1);
  assert.equal(report.summary.by_signal.topic_drift, 1);
  assert.equal(report.summary.by_signal.progress_snapshot, 1);
  assert.equal(report.summary.by_signal.unknown_source, 1);
  assert.equal(report.summary.by_signal.stable_operational_fact, 1);

  const stable = report.evidence.find((item) => item.id === "stable-env");
  assert.ok(stable);
  assert.equal(stable.scope, "project:memory-xx");
  assert.equal(stable.title, "WSL 下 tsx 运行需设置 TMPDIR=/tmp");
  assert.match(stable.content_preview, /tsx 默认将 IPC pipe/);
  assert.equal(stable.source, "conversation_ingest");
  assert.equal(stable.created_by, "klee");
  assert.equal(stable.recommended_lane, "approve_candidate");
  assert.equal(stable.cognitive_type, "semantic");
  assert.equal(stable.recall_contract.target_recall_policy, "default");
  assert.deepEqual(stable.governance.required_before_apply, ["operator_approval", "scope_policy_gate"]);
  assert.match(stable.evidence_summary, /stable_operational_fact/);

  const drift = report.evidence.find((item) => item.id === "memory-xx-drift");
  assert.ok(drift);
  assert.equal(drift.recommended_lane, "event_log_only");
  assert.equal(drift.recall_contract.storage_target, "event_log_only");
  assert.equal(drift.recall_contract.default_recall_allowed, false);
  assert.ok(drift.signals.includes("topic_drift"));
  assert.ok(drift.governance.required_before_apply.includes("topic_scope_review"));

  const progress = report.evidence.find((item) => item.id === "ci-progress");
  assert.ok(progress);
  assert.equal(progress.recommended_lane, "event_log_only");
  assert.ok(progress.signals.includes("progress_snapshot"));
  assert.equal(progress.cognitive_type, "audit");

  const unknown = report.evidence.find((item) => item.id === "unknown-source");
  assert.ok(unknown);
  assert.equal(unknown.recommended_lane, "quarantine_or_reject");
  assert.equal(unknown.recall_contract.target_recall_policy, "never");
  assert.equal(unknown.governance.apply_allowed, false);
});

test("pending safe-close plan only includes non-default-recall closure lanes", () => {
  const report = buildPendingApprovalEvidenceReport({
    generatedAt: "2026-06-05T00:00:00.000Z",
    rows: [
      row({
        id: "stable-env",
        title: "WSL 下 tsx 运行需设置 TMPDIR=/tmp",
        content: "tsx 默认将 IPC pipe 放在 Windows 临时目录，WSL 下不支持这种 socket，需设置 TMPDIR=/tmp 才能运行。",
        memoryType: "preference",
      }),
      row({
        id: "memory-xx-drift",
        title: "memory-xx README 完善计划决策",
        content: "memory-xx README 完善计划：目标是完善公开 README，不写入真实私有路径。",
      }),
      row({
        id: "ci-progress",
        title: "full-stack-release-gate 已通过",
        content: "assistant: full-stack-release-gate 已通过。现在只剩 build-and-test 还在跑，继续等最后一个 job。",
      }),
      row({
        id: "keep",
        title: "新型未分类记忆",
        content: "这是一个还需要人工判断的候选，没有明显安全关闭证据。",
        memoryType: "fact",
      }),
      row({
        id: "unknown-source",
        title: "周度短时记忆晋升",
        content: "短时记忆晋升记录",
        source: "unknown",
        metadata: {
          memory_class: "unknown_source_quarantine",
          recall_policy: "never",
        },
      }),
    ],
  });

  const plan = buildPendingSafeClosePlan({
    report,
    runId: "pending-safe-close-20260605",
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.report_only, true);
  assert.equal(plan.apply_allowed, false);
  assert.deepEqual(plan.blockers, ["operator_approval_required", "apply_not_implemented"]);
  assert.equal(plan.summary.total_evidence_items, 5);
  assert.equal(plan.summary.safe_close_candidates, 3);
  assert.equal(plan.summary.excluded_for_human_review, 2);
  assert.equal(plan.summary.by_operation.event_log_only, 2);
  assert.equal(plan.summary.by_operation.reject_or_quarantine, 1);

  assert.deepEqual(
    plan.safe_close_candidates.map((candidate) => candidate.id).sort(),
    ["ci-progress", "memory-xx-drift", "unknown-source"],
  );
  assert.ok(plan.safe_close_candidates.every((candidate) => candidate.default_recall_allowed === false));
  assert.ok(plan.safe_close_candidates.every((candidate) => candidate.apply_allowed === false));
  assert.ok(plan.safe_close_candidates.every((candidate) => candidate.rollback_plan.action === "restore_candidate_state"));

  assert.deepEqual(
    plan.excluded_for_human_review.map((candidate) => candidate.id).sort(),
    ["keep", "stable-env"],
  );
});
