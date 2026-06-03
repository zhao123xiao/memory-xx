import {
  type RecallShadowCase,
  type RecallShadowCompareResult,
  type ShadowScorecard,
  type MigrationAuditRepositoryPort
} from "./types";
import { RecallShadowCompareHarness } from "./recall-shadow";
import { summarizeMigrationAuditRun, type MigrationAuditLedgerSummary } from "./audit-ledger";
import { createShadowScorecard } from "./scorecard";

export interface MigrationShadowRuntimeRunResult {
  readonly runId: string;
  readonly recall?: RecallShadowCompareResult;
  readonly scorecard: ShadowScorecard;
  readonly auditSummary: MigrationAuditLedgerSummary;
}

export interface MigrationShadowRuntimeOptions {
  readonly runId: string;
  readonly auditRepository: MigrationAuditRepositoryPort;
  readonly recallHarness?: RecallShadowCompareHarness;
}

export class MigrationShadowRuntimeChain {
  private readonly options: MigrationShadowRuntimeOptions;

  constructor(options: MigrationShadowRuntimeOptions) {
    this.options = options;
  }

  async run(input: {
    recallCases?: readonly RecallShadowCase[];
  }): Promise<MigrationShadowRuntimeRunResult> {
    const recall =
      this.options.recallHarness && input.recallCases
        ? await this.options.recallHarness.run(input.recallCases)
        : undefined;
    const combinedScorecard = createShadowScorecard([
      ...(recall?.cases ?? [])
    ]);

    return {
      runId: this.options.runId,
      recall,
      scorecard: combinedScorecard,
      auditSummary: await summarizeMigrationAuditRun(
        this.options.auditRepository,
        this.options.runId
      )
    };
  }
}
