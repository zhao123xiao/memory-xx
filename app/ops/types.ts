export enum CutoverStage {
  M4ReadCanary = "m4_read_canary",
  M5WriteCutover = "m5_write_cutover"
}

export enum GateDecision {
  Pass = "pass",
  Hold = "hold",
  Fail = "fail"
}

export enum GateComparator {
  GreaterThanOrEqual = "gte",
  LessThanOrEqual = "lte",
  Equal = "eq"
}

export enum MetricStatus {
  Pass = "pass",
  Fail = "fail"
}

export enum ReadRoute {
  Legacy = "legacy",
  RecallV2 = "recall_v2",
  Canary = "canary",
  Rollback = "rollback"
}

export enum WriteAuthority {
  Legacy = "legacy",
  Shadow = "shadow",
  RecallV2 = "recall_v2"
}

export enum ChecklistStatus {
  Pass = "pass",
  Fail = "fail",
  Skip = "skip"
}

export enum RollbackDrillOutcome {
  Pass = "pass",
  Fail = "fail"
}

export interface GateMetricDefinition {
  readonly metricId: string;
  readonly label: string;
  readonly comparator: GateComparator;
  readonly threshold: number;
  readonly required: boolean;
}

export interface GateMetricReading {
  readonly metricId: string;
  readonly actual: number;
  readonly unit?: string;
  readonly sampleSize?: number;
  readonly notes?: string;
}

export interface GateMetricResult {
  readonly metricId: string;
  readonly label: string;
  readonly comparator: GateComparator;
  readonly threshold: number;
  readonly actual: number | null;
  readonly status: MetricStatus;
  readonly required: boolean;
  readonly reason?: string;
  readonly unit?: string;
  readonly sampleSize?: number;
  readonly notes?: string;
}

export interface GateEvaluation {
  readonly stage: CutoverStage;
  readonly decision: GateDecision;
  readonly metrics: readonly GateMetricResult[];
  readonly blockingReasons: readonly string[];
}

export interface CutoverBoundaryFreeze {
  readonly stage: CutoverStage;
  readonly readRoute: ReadRoute;
  readonly writeAuthority: WriteAuthority;
  readonly legacyWriteFrozen: boolean;
  readonly newWriteCanAcceptProduction: boolean;
  readonly dualWriteAllowed: boolean;
  readonly notes?: string;
}

export interface BoundaryValidationResult {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

export interface CanaryCohort {
  readonly waveId: string;
  readonly trafficPercent: number;
  readonly queryTypes: readonly string[];
  readonly actorScopes: readonly string[];
}

export interface ReadRouteAuditEvent {
  readonly requestId: string;
  readonly readPath: "legacy" | "recall_v2";
  readonly route: ReadRoute;
  readonly cutoverWave: string;
  readonly queryType: string;
  readonly allowedScopeSet: readonly string[];
  readonly fallbackTriggered: boolean;
  readonly rollbackMarker?: string;
  readonly degradeReason?: string;
}

export interface CanaryAuditSummary {
  readonly totalEvents: number;
  readonly byReadPath: Readonly<Record<string, number>>;
  readonly fallbackCount: number;
  readonly rollbackMarkedCount: number;
}

export interface PreflightChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  run(): Promise<ChecklistStatus> | ChecklistStatus;
}

export interface PreflightChecklistResult {
  readonly stage: CutoverStage;
  readonly status: GateDecision;
  readonly items: readonly {
    id: string;
    label: string;
    required: boolean;
    status: ChecklistStatus;
  }[];
  readonly failedRequiredItems: readonly string[];
}

export interface RollbackDrillStepResult {
  readonly stepId: string;
  readonly status: RollbackDrillOutcome;
  readonly detail: string;
}

export interface RollbackDrillResult {
  readonly drillId: string;
  readonly stage: CutoverStage;
  readonly outcome: RollbackDrillOutcome;
  readonly restoredReadRoute: ReadRoute;
  readonly restoredWriteAuthority: WriteAuthority;
  readonly durationSeconds: number;
  readonly steps: readonly RollbackDrillStepResult[];
  readonly reasons: readonly string[];
}

export interface CutoverEvidencePack {
  readonly stage: CutoverStage;
  readonly generatedAt: string;
  readonly boundary: CutoverBoundaryFreeze;
  readonly boundaryValidation: BoundaryValidationResult;
  readonly gate: GateEvaluation;
  readonly checklist: PreflightChecklistResult;
  readonly canaryAudit: CanaryAuditSummary;
  readonly rollback?: RollbackDrillResult;
  readonly scorecard: {
    decision: GateDecision;
    readyForNextStage: boolean;
    blockingReasons: readonly string[];
  };
}

export enum RetirementAction {
  Freeze = "freeze",
  ReadOnlyRetain = "read_only_retain",
  FormalRetire = "formal_retire"
}

export enum LegacyAssetTier {
  Production = "production",
  RollbackAnchor = "rollback_anchor",
  Evidence = "evidence",
  Evaluation = "evaluation"
}

export enum LegacyAssetState {
  Active = "active",
  Frozen = "frozen",
  ReadOnly = "read_only",
  Retired = "retired"
}

export interface LegacyAssetRecord {
  readonly assetId: string;
  readonly label: string;
  readonly tier: LegacyAssetTier;
  readonly currentState: LegacyAssetState;
  readonly targetAction: RetirementAction;
  readonly requiresApproval: boolean;
  readonly requiresSnapshot: boolean;
  readonly owner: string;
  readonly retentionUntil?: string;
  readonly notes?: string;
}

export interface RetirementExecutionPrerequisites {
  readonly approvalId?: string;
  readonly approvedBy?: string;
  readonly snapshotId?: string;
  readonly checksum?: string;
  readonly recoveryRunbook?: string;
  readonly rollbackWindowOpen: boolean;
}

export interface RetirementActionValidation {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

export interface LegacyAssetRegisterSummary {
  readonly totalAssets: number;
  readonly byTier: Readonly<Record<LegacyAssetTier, number>>;
  readonly byAction: Readonly<Record<RetirementAction, number>>;
  readonly byState: Readonly<Record<LegacyAssetState, number>>;
  readonly destructiveCandidates: readonly string[];
}

export interface RetirementReadinessCheck {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly status: ChecklistStatus;
}

export interface RetirementReadinessResult {
  readonly status: GateDecision;
  readonly checks: readonly RetirementReadinessCheck[];
  readonly blockingReasons: readonly string[];
}

export interface RetirementEvidencePack {
  readonly generatedAt: string;
  readonly register: LegacyAssetRegisterSummary;
  readonly actionValidation: readonly {
    assetId: string;
    action: RetirementAction;
    validation: RetirementActionValidation;
  }[];
  readonly readiness: RetirementReadinessResult;
  readonly scorecard: {
    decision: GateDecision;
    readyForFormalRetirement: boolean;
    blockingReasons: readonly string[];
  };
}

export interface HandoverPack {
  readonly generatedAt: string;
  readonly owners: readonly {
    assetId: string;
    owner: string;
    targetAction: RetirementAction;
    retentionUntil?: string;
  }[];
  readonly readonlyAssets: readonly string[];
  readonly formalRetirementCandidates: readonly string[];
  readonly openRisks: readonly string[];
}
