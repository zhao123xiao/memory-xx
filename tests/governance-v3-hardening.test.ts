import assert from "node:assert/strict";
import test from "node:test";

import {
  GovernanceRepository,
  InMemoryWriteDatabase,
  LifecycleStatus,
  ReviewState,
  ScopeType,
  adjustSilentApproveThreshold,
  activeSilentApproveThreshold,
  feedbackLineageContribution,
  projectionLifecycleOperation,
  scoreTestPollution,
  stableGovernanceSelectorHash,
  withWriteTransaction,
} from "../app";

test("silent approve threshold uses updated_at cooldown and conservative adjustment", () => {
  const raised = adjustSilentApproveThreshold({
    currentThreshold: 0.90,
    defaultThreshold: 0.90,
    now: "2026-05-20T10:00:00.000Z",
    stats: { sampleSize: 20, falsePositiveRate: 0.06, adoptionRate: 0.2, cleanRunCount: 2 },
  });
  assert.equal(raised.threshold, 0.93);
  assert.equal(raised.cleanRunCount, 0);
  assert.equal(raised.reason, "false_positive_guardrail");

  const cooldown = adjustSilentApproveThreshold({
    currentThreshold: 0.93,
    defaultThreshold: 0.90,
    lastUpdatedAt: "2026-05-20T09:00:00.000Z",
    now: "2026-05-21T08:00:00.000Z",
    stats: { sampleSize: 50, falsePositiveRate: 0.10, adoptionRate: 0.1, cleanRunCount: 0 },
  });
  assert.equal(cooldown.threshold, 0.93);
  assert.equal(cooldown.reason, "cooldown_active");

  const lowered = adjustSilentApproveThreshold({
    currentThreshold: 0.95,
    defaultThreshold: 0.90,
    lastUpdatedAt: "2026-05-18T08:00:00.000Z",
    now: "2026-05-20T09:00:00.000Z",
    stats: { sampleSize: 50, falsePositiveRate: 0.00, adoptionRate: 0.5, cleanRunCount: 2 },
  });
  assert.equal(lowered.threshold, 0.94);
  assert.equal(lowered.reason, "clean_runs_relaxation");
});

test("governance policy override exposes active silent approve threshold", async () => {
  const db = new InMemoryWriteDatabase(() => "2026-05-20T10:00:00.000Z");
  const repo = new GovernanceRepository();
  const selector = { agent_id: "agent-a", scope_type: "project", memory_type: "decision", source: "smart-write" };
  const selectorHash = stableGovernanceSelectorHash(selector);
  const override = await withWriteTransaction(db, (tx) => repo.upsertPolicyOverride(tx, {
    selectorHash,
    selector,
    policyType: "silent_approve",
    threshold: 0.95,
    defaultThreshold: 0.90,
    autoApproveEnabled: false,
    expiresAt: "2026-05-21T10:00:00.000Z",
  }));
  assert.deepEqual(activeSilentApproveThreshold(override, 0.90), {
    threshold: 0.95,
    autoApproveEnabled: false,
    source: "governance_override",
  });
});

test("scope freeze blocks configured automatic actions only until expiry", async () => {
  const db = new InMemoryWriteDatabase(() => "2026-05-20T10:00:00.000Z");
  const repo = new GovernanceRepository();
  await withWriteTransaction(db, (tx) => repo.createFreeze(tx, {
    scopeType: ScopeType.Project,
    scopeId: "legacy",
    actions: ["auto_lifecycle", "low_confidence_promote", "recall_repair_apply"],
    reason: "manual audit",
    actorId: "tester",
    expiresAt: "2026-05-21T10:00:00.000Z",
  }));
  assert.equal(await withWriteTransaction(db, (tx) => repo.isScopeFrozen(tx, ScopeType.Project, "legacy", "auto_lifecycle")), true);
  assert.equal(await withWriteTransaction(db, (tx) => repo.isScopeFrozen(tx, ScopeType.Project, "legacy", "manual_review")), false);
  assert.equal(await withWriteTransaction(db, (tx) => repo.isScopeFrozen(tx, ScopeType.Project, "legacy", "auto_lifecycle", "2026-05-22T10:00:00.000Z")), false);
});

test("projection lifecycle follows approved archived tombstone superseded policy", () => {
  const base = { reviewState: ReviewState.NotRequired, isCurrent: true };
  assert.equal(projectionLifecycleOperation({ ...base, lifecycleStatus: LifecycleStatus.Approved }), "upsert_recallable");
  assert.equal(projectionLifecycleOperation({ ...base, lifecycleStatus: LifecycleStatus.Archived, isCurrent: false }), "delete_point");
  assert.equal(projectionLifecycleOperation({ ...base, lifecycleStatus: LifecycleStatus.Tombstone, isCurrent: false }), "delete_point");
  assert.equal(projectionLifecycleOperation({ ...base, lifecycleStatus: LifecycleStatus.Superseded, isCurrent: false }), "delete_point");
});

test("test pollution evidence requires score >= 2 for automatic tombstone", () => {
  const weak = scoreTestPollution({
    scopeId: "project-alpha",
    source: "benchmark",
    content: "regular benchmark note",
    metadata: {},
  });
  assert.equal(weak.score, 1);
  assert.equal(weak.autoTombstoneAllowed, false);

  const strong = scoreTestPollution({
    scopeId: "mcp-user-flow-smoke",
    source: "benchmark",
    content: "Unified API test sample",
    metadata: { governance_test_pollution: true },
  });
  assert.equal(strong.score >= 2, true);
  assert.equal(strong.autoTombstoneAllowed, true);
});

test("feedback lineage weakly inherits positive signals and keeps negative as audit risk", () => {
  const result = feedbackLineageContribution({
    confirmed: 2,
    used: 1,
    adopted: 1,
    wrong: 3,
    notRelevant: 1,
  });
  assert.equal(result.strengthDelta, 0.08);
  assert.equal(result.lineageRisk.inherited_negative_feedback_count, 4);
  assert.equal(result.lineageRisk.negative_feedback_not_inherited_to_strength, true);
});

test("governance run alert fires on three consecutive failed or skipped runs", async () => {
  const db = new InMemoryWriteDatabase(() => "2026-05-20T10:00:00.000Z");
  const repo = new GovernanceRepository();
  await withWriteTransaction(db, async (tx) => {
    await repo.tryBeginRun(tx, { jobType: "projection_governance", mode: "apply", status: "failed", error: "boom" });
    await repo.tryBeginRun(tx, { jobType: "projection_governance", mode: "apply", status: "skipped_lock_held" });
    await repo.tryBeginRun(tx, { jobType: "projection_governance", mode: "apply", status: "failed", error: "boom" });
    const alert = await repo.recordRunAlertIfNeeded(tx, {
      jobType: "projection_governance",
      scheduleIntervalMs: 60 * 60 * 1000,
    });
    assert.equal(alert?.actionType, "governance_run_alert");
  });
});
