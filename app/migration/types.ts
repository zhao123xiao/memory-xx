import type { JsonObject } from "../shared";
import type { RecallRequest, RecallResponse } from "../recall";

export enum MigrationStage {
  M0 = "M0",
  M1 = "M1",
  M2 = "M2",
  M3 = "M3"
}

export enum MigrationJobType {
  Extract = "extract",
  Transform = "transform",
  Load = "load",
  Rebuild = "rebuild",
  ShadowCompare = "shadow_compare",
  Replay = "replay"
}

export enum MigrationSourceSystem {
  Markdown = "markdown",
  Sqlite = "sqlite",
  Qdrant = "qdrant",
  EmbeddingCache = "embedding_cache",
  Mem0 = "mem0",
  MemoryV2 = "memory_v2"
}

export enum MigrationAuditStatus {
  Pending = "pending",
  Running = "running",
  Succeeded = "succeeded",
  SucceededWithDiff = "succeeded_with_diff",
  Failed = "failed",
  Skipped = "skipped",
  ManualReview = "manual_review"
}

export enum ShadowDiffCategory {
  DefaultFilterViolation = "default_filter_violation",
  ScopeViolation = "scope_violation",
  ZeroHitRegression = "zero_hit_regression",
  DegradeRegression = "degrade_regression",
  ResultMismatch = "result_mismatch",
  CandidateTimeout = "candidate_timeout"
}

export enum ShadowDiffSeverity {
  Info = "info",
  Warning = "warning",
  Critical = "critical"
}

export interface MigrationAuditEntry {
  readonly auditId: string;
  readonly migrationRunId: string;
  readonly batchId: string;
  readonly stage: MigrationStage;
  readonly jobType: MigrationJobType;
  readonly sourceSystem: MigrationSourceSystem;
  readonly sourceLocator: string;
  readonly targetTableOrAsset: string;
  readonly targetRecordId: string | null;
  readonly status: MigrationAuditStatus;
  readonly attempt: number;
  readonly checksumBefore?: string;
  readonly checksumAfter?: string;
  readonly rowCountExpected?: number;
  readonly rowCountLoaded?: number;
  readonly diffSummary?: string;
  readonly errorCode?: string;
  readonly errorDetailRef?: string;
  readonly operator: string;
  readonly workerId: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly metadata: JsonObject;
}

export interface AppendMigrationAuditEntryInput {
  readonly migrationRunId: string;
  readonly batchId: string;
  readonly stage: MigrationStage;
  readonly jobType: MigrationJobType;
  readonly sourceSystem: MigrationSourceSystem;
  readonly sourceLocator: string;
  readonly targetTableOrAsset: string;
  readonly targetRecordId?: string | null;
  readonly status: MigrationAuditStatus;
  readonly attempt?: number;
  readonly checksumBefore?: string;
  readonly checksumAfter?: string;
  readonly rowCountExpected?: number;
  readonly rowCountLoaded?: number;
  readonly diffSummary?: string;
  readonly errorCode?: string;
  readonly errorDetailRef?: string;
  readonly operator?: string;
  readonly workerId?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly metadata?: JsonObject;
}

export interface MigrationAuditRepositoryPort {
  append(input: AppendMigrationAuditEntryInput): Promise<MigrationAuditEntry>;
  listByRun(migrationRunId: string): Promise<MigrationAuditEntry[]>;
}

export interface ShadowDiff {
  readonly category: ShadowDiffCategory;
  readonly severity: ShadowDiffSeverity;
  readonly code: string;
  readonly summary: string;
  readonly details: JsonObject;
}

export interface ShadowCaseResult<TCaseId extends string = string> {
  readonly caseId: TCaseId;
  readonly diffs: readonly ShadowDiff[];
  readonly severity: ShadowDiffSeverity;
  readonly passed: boolean;
}

export interface ShadowScorecard {
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly diffCounts: Readonly<Record<ShadowDiffCategory, number>>;
  readonly severityCounts: Readonly<Record<ShadowDiffSeverity, number>>;
  readonly highestSeverity: ShadowDiffSeverity;
  readonly rerunRecommended: boolean;
  readonly rerunStrategy: string;
}

export interface LegacyRecallRuntime {
  execute(request: RecallRequest): Promise<RecallResponse>;
}

export type RecallShadowMatchMode =
  | "exact_ordered_set"
  | "top1_must_match_allow_tail";

export interface RecallShadowCase {
  readonly caseId: string;
  readonly request: RecallRequest;
  readonly expectedLegacy: RecallResponse;
  readonly matchMode?: RecallShadowMatchMode;
}

export interface RecallShadowCaseResult extends ShadowCaseResult {
  readonly legacy: RecallResponse;
  readonly candidate: RecallResponse;
}

export interface RecallShadowCompareResult {
  readonly runId: string;
  readonly cases: readonly RecallShadowCaseResult[];
  readonly scorecard: ShadowScorecard;
}
