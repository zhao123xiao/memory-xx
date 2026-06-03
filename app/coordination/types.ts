import { ScopeType } from "../shared";

export enum CoordinationTaskStatus {
  Queued = "queued",
  Leased = "leased",
  Running = "running",
  RetryWait = "retry_wait",
  Succeeded = "succeeded",
  FailedFinal = "failed_final",
  Dlq = "dlq",
  Recovered = "recovered",
  Abandoned = "abandoned"
}

export enum PriorityLane {
  P0Critical = "p0_critical",
  P1High = "p1_high",
  P2Normal = "p2_normal",
  P3Background = "p3_background"
}

export enum RetryClassification {
  Retriable = "retriable",
  NonRetriable = "non_retriable"
}

export enum DlqReason {
  MaxAttemptsExceeded = "max_attempts_exceeded",
  NonRetriableError = "non_retriable_error",
  LeaseExpired = "lease_expired",
  FencingRejected = "fencing_rejected",
  LockConflict = "lock_conflict",
  HandlerUnavailable = "handler_unavailable",
  RecoveryRejected = "recovery_rejected"
}

export enum LockScope {
  Task = "task",
  Scope = "scope",
  Projection = "projection",
  Cache = "cache",
  Worker = "worker"
}

export enum PresenceState {
  Alive = "alive",
  Stale = "stale",
  Offline = "offline"
}

export enum GenerationKind {
  Scope = "scope",
  QueryFamily = "query_family",
  Vector = "vector"
}

export enum IdempotencyStatus {
  Processing = "processing",
  Succeeded = "succeeded",
  FailedRetriable = "failed_retriable",
  FailedFinal = "failed_final"
}

export enum RecoveryReason {
  LeaseExpired = "lease_expired",
  DlqReplay = "dlq_replay",
  ManualRequeue = "manual_requeue",
  PresenceRepair = "presence_repair"
}

export interface CoordinationScopeRef {
  readonly type: ScopeType;
  readonly id: string;
}

export interface CoordinationFailure {
  readonly code: string;
  readonly message: string;
  readonly retriable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CoordinationLease {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly acquiredAt: number;
  readonly deadlineAt: number;
  readonly lastRenewedAt: number;
}

export interface CoordinationRecoveryMetadata {
  readonly reason: RecoveryReason;
  readonly recoveredAt: number;
  readonly recoveredBy: string;
  readonly note?: string;
}

export interface CoordinationTaskSpec {
  readonly taskId: string;
  readonly taskType: string;
  readonly priority: PriorityLane;
  readonly scopes: readonly CoordinationScopeRef[];
  readonly payload?: unknown;
  readonly payloadRef?: string;
  readonly dedupeKey?: string;
  readonly idempotencyKey?: string;
  readonly singleFlightKey?: string;
  readonly enqueueAt: number;
  readonly visibleAt: number;
  readonly maxAttempts: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CoordinationTaskRecord extends CoordinationTaskSpec {
  readonly status: CoordinationTaskStatus;
  readonly attempt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly dedupeHits: number;
  readonly lastWorkerId?: string;
  readonly attemptStartedAt?: number;
  readonly completedAt?: number;
  readonly lease?: CoordinationLease;
  readonly lastError?: CoordinationFailure;
  readonly recovery?: CoordinationRecoveryMetadata;
}

export interface ClaimedCoordinationTask {
  readonly task: CoordinationTaskRecord;
  readonly lease: CoordinationLease;
}

export interface DistributedLock {
  readonly lockScope: LockScope;
  readonly resourceId: string;
  readonly ownerId: string;
  readonly leaseId?: string;
  readonly fencingToken: number;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

export interface CoordinationGenerationKey {
  readonly kind: GenerationKind;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly facet?: string;
}

export interface CoordinationGenerationRecord {
  readonly key: CoordinationGenerationKey;
  readonly value: number;
  readonly updatedAt: number;
  readonly reason: string;
  readonly lastSourceEventId?: string;
}

export interface WorkerPresenceRecord {
  readonly workerId: string;
  readonly state: PresenceState;
  readonly capabilities: readonly string[];
  readonly currentLoad: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
  readonly staleAt: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RunRuntimeContext {
  readonly runId: string;
  readonly ownerId: string;
  readonly scopes: readonly CoordinationScopeRef[];
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface TaskRuntimeContext {
  readonly taskId: string;
  readonly parentRunId: string;
  readonly parentTaskId?: string;
  readonly scopes: readonly CoordinationScopeRef[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DedupeWindowRecord {
  readonly key: string;
  readonly firstTaskId: string;
  readonly firstSeenAt: number;
  readonly expiresAt: number;
  readonly hitCount: number;
}

export interface DedupeStatistics {
  readonly totalHits: number;
  readonly activeWindows: number;
}

export interface SingleFlightRecord {
  readonly key: string;
  readonly ownerId: string;
  readonly taskId?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface SingleFlightClaimResult {
  readonly acquired: boolean;
  readonly record: SingleFlightRecord;
}

export interface IdempotencyRecord {
  readonly key: string;
  readonly status: IdempotencyStatus;
  readonly ownerId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly result?: unknown;
  readonly failure?: CoordinationFailure;
}

export interface CoordinationLaneSnapshot {
  readonly lane: PriorityLane;
  readonly readyCount: number;
  readonly retryWaitCount: number;
  readonly leasedCount: number;
  readonly dlqCount: number;
  readonly oldestVisibleAt?: number;
  readonly oldestAgeMs?: number;
}

export interface CoordinationBacklogSnapshot {
  readonly takenAt: number;
  readonly lanes: readonly CoordinationLaneSnapshot[];
  readonly dedupeHits: number;
  readonly inflightCount: number;
}

export type CoordinationFinalStatus =
  | CoordinationTaskStatus.Succeeded
  | CoordinationTaskStatus.FailedFinal
  | CoordinationTaskStatus.Recovered;
