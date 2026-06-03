import { validateCutoverBoundary, summarizeReadRouteAudit } from "./cutover";
import { evaluateGateMetrics } from "./gates";
import { PreflightChecklistRunner } from "./preflight";
import { GateDecision, type CutoverEvidencePack, type CutoverBoundaryFreeze, type GateMetricReading, type PreflightChecklistItem, type ReadRouteAuditEvent } from "./types";
import { RollbackDrillHarness, type RollbackDrillInput } from "./rollback";

export interface CutoverGateRuntimeChainInput {
  readonly generatedAt?: string;
  readonly boundary: CutoverBoundaryFreeze;
  readonly metrics: readonly GateMetricReading[];
  readonly checklist: readonly PreflightChecklistItem[];
  readonly auditEvents: readonly ReadRouteAuditEvent[];
  readonly rollbackDrill?: RollbackDrillInput;
}

export class CutoverGateRuntimeChain {
  private readonly checklistRunner: PreflightChecklistRunner;
  private readonly rollbackHarness: RollbackDrillHarness;

  constructor(options?: { readonly rollbackMaxDurationSeconds?: number }) {
    this.checklistRunner = new PreflightChecklistRunner();
    this.rollbackHarness = new RollbackDrillHarness({
      maxDurationSeconds: options?.rollbackMaxDurationSeconds ?? 300
    });
  }

  async run(input: CutoverGateRuntimeChainInput): Promise<CutoverEvidencePack> {
    const boundaryValidation = validateCutoverBoundary(input.boundary);
    const gate = evaluateGateMetrics({
      stage: input.boundary.stage,
      readings: input.metrics
    });
    const checklist = await this.checklistRunner.run(input.boundary.stage, input.checklist);
    const canaryAudit = summarizeReadRouteAudit(input.auditEvents);
    const rollback = input.rollbackDrill ? this.rollbackHarness.run(input.rollbackDrill) : undefined;

    const blockingReasons = [
      ...boundaryValidation.reasons,
      ...gate.blockingReasons,
      ...checklist.failedRequiredItems,
      ...(rollback && rollback.outcome !== "pass" ? rollback.reasons : [])
    ];

    return {
      stage: input.boundary.stage,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      boundary: input.boundary,
      boundaryValidation,
      gate,
      checklist,
      canaryAudit,
      rollback,
      scorecard: {
        decision: blockingReasons.length === 0 ? GateDecision.Pass : GateDecision.Hold,
        readyForNextStage: blockingReasons.length === 0,
        blockingReasons
      }
    };
  }
}
