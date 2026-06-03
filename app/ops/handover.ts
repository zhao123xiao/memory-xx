import { LegacyAssetTier, RetirementAction, type HandoverPack, type LegacyAssetRecord } from "./types";

export function buildHandoverPack(input: {
  generatedAt?: string;
  assets: readonly LegacyAssetRecord[];
  blockingReasons: readonly string[];
}): HandoverPack {
  const readonlyAssets = input.assets
    .filter((asset) => asset.targetAction === RetirementAction.ReadOnlyRetain)
    .map((asset) => asset.assetId);

  const formalRetirementCandidates = input.assets
    .filter(
      (asset) =>
        asset.targetAction === RetirementAction.FormalRetire &&
        asset.tier !== LegacyAssetTier.Evaluation &&
        asset.tier !== LegacyAssetTier.Evidence
    )
    .map((asset) => asset.assetId);

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    owners: input.assets.map((asset) => ({
      assetId: asset.assetId,
      owner: asset.owner,
      targetAction: asset.targetAction,
      retentionUntil: asset.retentionUntil
    })),
    readonlyAssets,
    formalRetirementCandidates,
    openRisks: [...input.blockingReasons]
  };
}
