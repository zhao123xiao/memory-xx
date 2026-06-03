import { RollbackDrillOutcome, type RollbackDrillResult, type RollbackDrillStepResult, type ReadRoute, type WriteAuthority, type CutoverStage } from "./types";

export interface RollbackDrillHarnessOptions {
  readonly maxDurationSeconds: number;
}

export interface RollbackDrillInput {
  readonly drillId: string;
  readonly stage: CutoverStage;
  readonly restoredReadRoute: ReadRoute;
  readonly restoredWriteAuthority: WriteAuthority;
  readonly durationSeconds: number;
  readonly steps: readonly RollbackDrillStepResult[];
}

export class RollbackDrillHarness {
  private readonly options: RollbackDrillHarnessOptions;

  constructor(options: RollbackDrillHarnessOptions) {
    this.options = options;
  }

  run(input: RollbackDrillInput): RollbackDrillResult {
    const reasons: string[] = [];

    if (input.durationSeconds > this.options.maxDurationSeconds) {
      reasons.push("rollback_exceeded_slo");
    }

    for (const step of input.steps) {
      if (step.status === RollbackDrillOutcome.Fail) {
        reasons.push(`step_failed:${step.stepId}`);
      }
    }

    return {
      ...input,
      outcome: reasons.length === 0 ? RollbackDrillOutcome.Pass : RollbackDrillOutcome.Fail,
      reasons
    };
  }
}
