import {
  ChecklistStatus,
  GateDecision,
  LegacyAssetState,
  LegacyAssetTier,
  RetirementAction,
  type LegacyAssetRecord,
  type LegacyAssetRegisterSummary,
  type RetirementActionValidation,
  type RetirementExecutionPrerequisites,
  type RetirementReadinessResult
} from "./types";

function createTierCounter(): Record<LegacyAssetTier, number> {
  return {
    [LegacyAssetTier.Production]: 0,
    [LegacyAssetTier.RollbackAnchor]: 0,
    [LegacyAssetTier.Evidence]: 0,
    [LegacyAssetTier.Evaluation]: 0
  };
}

function createActionCounter(): Record<RetirementAction, number> {
  return {
    [RetirementAction.Freeze]: 0,
    [RetirementAction.ReadOnlyRetain]: 0,
    [RetirementAction.FormalRetire]: 0
  };
}

function createStateCounter(): Record<LegacyAssetState, number> {
  return {
    [LegacyAssetState.Active]: 0,
    [LegacyAssetState.Frozen]: 0,
    [LegacyAssetState.ReadOnly]: 0,
    [LegacyAssetState.Retired]: 0
  };
}

export function summarizeLegacyAssetRegister(assets: readonly LegacyAssetRecord[]): LegacyAssetRegisterSummary {
  const byTier = createTierCounter();
  const byAction = createActionCounter();
  const byState = createStateCounter();

  for (const asset of assets) {
    byTier[asset.tier] += 1;
    byAction[asset.targetAction] += 1;
    byState[asset.currentState] += 1;
  }

  return {
    totalAssets: assets.length,
    byTier,
    byAction,
    byState,
    destructiveCandidates: assets
      .filter((asset) => asset.targetAction === RetirementAction.FormalRetire)
      .map((asset) => asset.assetId)
  };
}

export function validateRetirementAction(
  asset: LegacyAssetRecord,
  prerequisites: RetirementExecutionPrerequisites
): RetirementActionValidation {
  const reasons: string[] = [];

  if ((asset.tier === LegacyAssetTier.Evidence || asset.tier === LegacyAssetTier.Evaluation) && asset.targetAction === RetirementAction.FormalRetire) {
    reasons.push("protected_tier_cannot_formally_retire");
  }

  if (asset.tier === LegacyAssetTier.RollbackAnchor && asset.targetAction === RetirementAction.FormalRetire && prerequisites.rollbackWindowOpen) {
    reasons.push("rollback_anchor_requires_window_close");
  }

  if (asset.targetAction === RetirementAction.Freeze && asset.currentState === LegacyAssetState.Retired) {
    reasons.push("cannot_freeze_retired_asset");
  }

  if (asset.targetAction === RetirementAction.ReadOnlyRetain && asset.currentState === LegacyAssetState.Retired) {
    reasons.push("cannot_retain_retired_asset");
  }

  if (asset.targetAction === RetirementAction.FormalRetire) {
    if (asset.currentState === LegacyAssetState.Active) {
      reasons.push("formal_retirement_requires_prior_freeze_or_readonly");
    }
    if (asset.requiresApproval && !prerequisites.approvalId) {
      reasons.push("missing_approval");
    }
    if (asset.requiresSnapshot && !prerequisites.snapshotId) {
      reasons.push("missing_snapshot");
    }
    if (!prerequisites.recoveryRunbook) {
      reasons.push("missing_recovery_runbook");
    }
  }

  if (asset.targetAction === RetirementAction.ReadOnlyRetain && asset.requiresSnapshot && !prerequisites.snapshotId) {
    reasons.push("readonly_retention_requires_snapshot");
  }

  return {
    allowed: reasons.length === 0,
    reasons
  };
}

export function evaluateRetirementReadiness(input: {
  checks: readonly {
    id: string;
    label: string;
    required: boolean;
    status: ChecklistStatus;
  }[];
  validations: readonly { assetId: string; validation: RetirementActionValidation }[];
}): RetirementReadinessResult {
  const blockingReasons = [
    ...input.checks.filter((check) => check.required && check.status !== ChecklistStatus.Pass).map((check) => check.id),
    ...input.validations
      .filter((entry) => !entry.validation.allowed)
      .flatMap((entry) => entry.validation.reasons.map((reason) => `${entry.assetId}:${reason}`))
  ];

  return {
    status: blockingReasons.length === 0 ? GateDecision.Pass : GateDecision.Hold,
    checks: input.checks,
    blockingReasons
  };
}
