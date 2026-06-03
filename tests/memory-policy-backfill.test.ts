import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBackfillGovernanceAction,
  buildBackfillMetadata,
  isBackfillAlreadyApplied,
  planPendingPolicyBackfill,
} from "../app/governance/memory-policy-backfill";

test("pending policy backfill groups safe historical cleanup actions without approving records", () => {
  const result = planPendingPolicyBackfill([
    {
      id: "m-explicit",
      scope_type: "project",
      scope_id: "p-1",
      title: "临时验证",
      content: "只是验证 Codex JSONL bridge 到 worker 的临时事件，不需要记住。",
      memory_type: "fact",
      metadata: { source: "conversation_ingest" },
      created_by: "klee",
    },
    {
      id: "m-unknown",
      scope_type: "project",
      scope_id: "p-1",
      title: "未知来源",
      content: "source=unknown, agent_id=klee 的候选需要隔离",
      memory_type: "fact",
      metadata: { source: "unknown" },
      created_by: "klee",
    },
    {
      id: "m-test",
      scope_type: "project",
      scope_id: "p-1",
      title: "perf-1",
      content: "perf-1",
      memory_type: "fact",
      metadata: { source: "conversation_ingest" },
      created_by: "klee",
    },
    {
      id: "m-audit",
      scope_type: "project",
      scope_id: "p-1",
      title: "审计报告",
      content: "L4 quality report audit evidence for recall gate",
      memory_type: "fact",
      metadata: { source: "conversation_ingest", memory_class: "audit_evidence" },
      created_by: "klee",
    },
    {
      id: "m-review",
      scope_type: "user",
      scope_id: "u-1",
      title: "稳定偏好",
      content: "用户偏好用中文回答架构问题",
      memory_type: "preference",
      metadata: { source: "conversation_ingest" },
      created_by: "klee",
    },
  ]);

  assert.deepEqual(result.groups.would_reject_by_policy.map((item) => item.id), ["m-explicit"]);
  assert.deepEqual(result.groups.would_quarantine.map((item) => item.id), ["m-unknown"]);
  assert.deepEqual(result.groups.would_mark_test_only.map((item) => item.id), ["m-test"]);
  assert.deepEqual(result.groups.would_mark_audit_only.map((item) => item.id), ["m-audit"]);
  assert.deepEqual(result.groups.would_keep_review.map((item) => item.id), ["m-review"]);
  assert.equal(result.summary.would_approve, 0);
});

test("pending policy backfill metadata is idempotent and carries run evidence", () => {
  const item = planPendingPolicyBackfill([{
    id: "m-noise",
    scope_type: "project",
    scope_id: "p-1",
    title: "继续",
    content: "user: 继续",
    memory_type: "fact",
    metadata: { source: "conversation_ingest" },
    created_by: "klee",
  }]).groups.would_reject_by_policy[0];
  assert.ok(item);

  const metadata = buildBackfillMetadata(
    { source: "conversation_ingest" },
    item,
    { runId: "policy-backfill-run-1", appliedAt: "2026-06-01T00:00:00.000Z" },
  );

  assert.equal(metadata.memory_class, "runtime_noise");
  assert.equal(metadata.recall_policy, "never");
  assert.deepEqual(metadata.memory_policy_backfill, {
    applied_at: "2026-06-01T00:00:00.000Z",
    run_id: "policy-backfill-run-1",
    policy_action: "reject_by_policy",
    memory_class: "runtime_noise",
    recall_policy: "never",
    reasons: ["runtime_noise_signal"],
  });
  assert.equal(isBackfillAlreadyApplied(metadata, item), true);
});

test("pending policy backfill governance action records before and after state", () => {
  const item = planPendingPolicyBackfill([{
    id: "m-quarantine",
    scope_type: "project",
    scope_id: "p-1",
    title: "unknown",
    content: "unknown source sample",
    memory_type: "fact",
    metadata: { source: "unknown" },
    created_by: "klee",
  }]).groups.would_quarantine[0];
  assert.ok(item);

  const action = buildBackfillGovernanceAction({
    runId: "policy-backfill-run-1",
    row: {
      id: "m-quarantine",
      scope_type: "project",
      scope_id: "p-1",
      title: "unknown",
      content: "unknown source sample",
      memory_type: "fact",
      metadata: { source: "unknown" },
      created_by: "klee",
    },
    item,
    beforeState: {
      lifecycle_status: "candidate",
      review_state: "pending",
      is_current: true,
    },
    afterState: {
      lifecycle_status: "candidate",
      review_state: "pending",
      is_current: true,
      recall_policy: "never",
    },
  });

  assert.equal(action.actionType, "memory_policy_backfill");
  assert.equal(action.memoryId, "m-quarantine");
  assert.equal(action.status, "applied");
  assert.equal(action.evidence.memory_class, "unknown_source_quarantine");
  assert.equal(action.evidence.backfill_run_id, "policy-backfill-run-1");
  assert.equal(action.afterState.recall_policy, "never");
});
