import assert from "node:assert/strict";
import test from "node:test";

import {
  ChecklistStatus,
  GateDecision,
  LegacyAssetState,
  LegacyAssetTier,
  RetirementAction,
  RetirementHandoverRuntimeChain
} from "../app";

test("retirement handover runtime chain emits executable evidence for freeze/readonly/retire split", () => {
  const runtime = new RetirementHandoverRuntimeChain();

  const result = runtime.run({
    generatedAt: "2026-04-13T13:00:00.000Z",
    assets: [
      {
        assetId: "legacy-markdown",
        label: "MEMORY.md + memory/",
        tier: LegacyAssetTier.Evidence,
        currentState: LegacyAssetState.ReadOnly,
        targetAction: RetirementAction.ReadOnlyRetain,
        requiresApproval: false,
        requiresSnapshot: true,
        owner: "docs-owner",
        retentionUntil: "2026-07-01"
      },
      {
        assetId: "legacy-sqlite",
        label: "data/memory/memory.db",
        tier: LegacyAssetTier.RollbackAnchor,
        currentState: LegacyAssetState.ReadOnly,
        targetAction: RetirementAction.ReadOnlyRetain,
        requiresApproval: true,
        requiresSnapshot: true,
        owner: "ops-owner",
        retentionUntil: "2026-06-01"
      },
      {
        assetId: "legacy-recall-bridge",
        label: "SourceOfTruthStore",
        tier: LegacyAssetTier.Production,
        currentState: LegacyAssetState.Frozen,
        targetAction: RetirementAction.FormalRetire,
        requiresApproval: true,
        requiresSnapshot: true,
        owner: "platform-owner"
      }
    ],
    prerequisites: {
      "legacy-markdown": {
        snapshotId: "snap-md-1",
        checksum: "sha256:1",
        recoveryRunbook: "docs/memory-xx/runbooks/retirement-handover.md",
        rollbackWindowOpen: true
      },
      "legacy-sqlite": {
        approvalId: "appr-sqlite-1",
        approvedBy: "approver-a",
        snapshotId: "snap-sqlite-1",
        checksum: "sha256:2",
        recoveryRunbook: "docs/memory-xx/runbooks/retirement-handover.md",
        rollbackWindowOpen: true
      },
      "legacy-recall-bridge": {
        approvalId: "appr-retire-1",
        approvedBy: "approver-b",
        snapshotId: "snap-bridge-1",
        checksum: "sha256:3",
        recoveryRunbook: "docs/memory-xx/runbooks/retirement-handover.md",
        rollbackWindowOpen: false
      }
    },
    checks: [
      { id: "m5_gate", label: "M5 gate 已通过", required: true, status: ChecklistStatus.Pass },
      { id: "legacy_write_frozen", label: "旧写入口已冻结", required: true, status: ChecklistStatus.Pass },
      { id: "rollback_anchor_inventory", label: "回滚锚点已盘点", required: true, status: ChecklistStatus.Pass }
    ]
  });

  assert.equal(result.evidence.scorecard.decision, GateDecision.Pass);
  assert.equal(result.evidence.scorecard.readyForFormalRetirement, true);
  assert.equal(result.evidence.register.totalAssets, 3);
  assert.deepEqual(result.evidence.register.byAction, {
    [RetirementAction.Freeze]: 0,
    [RetirementAction.ReadOnlyRetain]: 2,
    [RetirementAction.FormalRetire]: 1
  });
  assert.deepEqual([...result.handover.readonlyAssets].sort(), ["legacy-markdown", "legacy-sqlite"]);
  assert.deepEqual(result.handover.formalRetirementCandidates, ["legacy-recall-bridge"]);
});

test("retirement handover runtime chain blocks formal retirement without guardrails", () => {
  const runtime = new RetirementHandoverRuntimeChain();

  const result = runtime.run({
    assets: [
      {
        assetId: "qdrant-shadow",
        label: "openclaw_mem0_4096",
        tier: LegacyAssetTier.RollbackAnchor,
        currentState: LegacyAssetState.Active,
        targetAction: RetirementAction.FormalRetire,
        requiresApproval: true,
        requiresSnapshot: true,
        owner: "vector-owner"
      },
      {
        assetId: "mem0-federation-eval",
        label: "services/mem0/federation/*",
        tier: LegacyAssetTier.Evaluation,
        currentState: LegacyAssetState.ReadOnly,
        targetAction: RetirementAction.FormalRetire,
        requiresApproval: false,
        requiresSnapshot: false,
        owner: "eval-owner"
      }
    ],
    prerequisites: {
      "qdrant-shadow": {
        rollbackWindowOpen: true
      },
      "mem0-federation-eval": {
        rollbackWindowOpen: false
      }
    },
    checks: [
      { id: "m5_gate", label: "M5 gate 已通过", required: true, status: ChecklistStatus.Pass },
      { id: "retirement_approval_chain", label: "退役审批链已建立", required: true, status: ChecklistStatus.Fail }
    ]
  });

  assert.equal(result.evidence.scorecard.decision, GateDecision.Hold);
  assert.equal(result.evidence.scorecard.readyForFormalRetirement, false);
  assert.ok(result.evidence.scorecard.blockingReasons.includes("retirement_approval_chain"));
  assert.ok(result.evidence.scorecard.blockingReasons.includes("qdrant-shadow:rollback_anchor_requires_window_close"));
  assert.ok(result.evidence.scorecard.blockingReasons.includes("qdrant-shadow:formal_retirement_requires_prior_freeze_or_readonly"));
  assert.ok(result.evidence.scorecard.blockingReasons.includes("qdrant-shadow:missing_approval"));
  assert.ok(result.evidence.scorecard.blockingReasons.includes("qdrant-shadow:missing_snapshot"));
  assert.ok(result.evidence.scorecard.blockingReasons.includes("qdrant-shadow:missing_recovery_runbook"));
  assert.ok(result.evidence.scorecard.blockingReasons.includes("mem0-federation-eval:protected_tier_cannot_formally_retire"));
  assert.deepEqual(result.handover.formalRetirementCandidates, ["qdrant-shadow"]);
  assert.equal(result.handover.openRisks.length, result.evidence.scorecard.blockingReasons.length);
});
