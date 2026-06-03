import { buildHandoverPack } from "./handover";
import { evaluateRetirementReadiness, summarizeLegacyAssetRegister, validateRetirementAction } from "./retirement";
import {
  ChecklistStatus,
  GateDecision,
  type HandoverPack,
  type LegacyAssetRecord,
  type RetirementEvidencePack,
  type RetirementExecutionPrerequisites
} from "./types";

export interface RetirementHandoverRuntimeChainInput {
  readonly generatedAt?: string;
  readonly assets: readonly LegacyAssetRecord[];
  readonly prerequisites: Readonly<Record<string, RetirementExecutionPrerequisites>>;
  readonly checks: readonly {
    id: string;
    label: string;
    required: boolean;
    status: ChecklistStatus;
  }[];
}

export interface RetirementHandoverRuntimeChainResult {
  readonly evidence: RetirementEvidencePack;
  readonly handover: HandoverPack;
}

export class RetirementHandoverRuntimeChain {
  run(input: RetirementHandoverRuntimeChainInput): RetirementHandoverRuntimeChainResult {
    const register = summarizeLegacyAssetRegister(input.assets);
    const actionValidation = input.assets.map((asset) => ({
      assetId: asset.assetId,
      action: asset.targetAction,
      validation: validateRetirementAction(asset, input.prerequisites[asset.assetId] ?? { rollbackWindowOpen: true })
    }));

    const readiness = evaluateRetirementReadiness({
      checks: input.checks,
      validations: actionValidation.map(({ assetId, validation }) => ({ assetId, validation }))
    });

    const generatedAt = input.generatedAt ?? new Date().toISOString();
    const evidence: RetirementEvidencePack = {
      generatedAt,
      register,
      actionValidation,
      readiness,
      scorecard: {
        decision: readiness.blockingReasons.length === 0 ? GateDecision.Pass : GateDecision.Hold,
        readyForFormalRetirement: readiness.blockingReasons.length === 0,
        blockingReasons: readiness.blockingReasons
      }
    };

    const handover = buildHandoverPack({
      generatedAt,
      assets: input.assets,
      blockingReasons: evidence.scorecard.blockingReasons
    });

    return { evidence, handover };
  }
}
