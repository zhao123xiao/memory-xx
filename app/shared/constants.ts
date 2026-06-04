import {
  FilterMode,
  LifecycleStatus,
  OutboxEventType,
  ReviewState,
  ScopeType,
  type ApiPrefixMap
} from "./types";

export const API_PREFIXES: ApiPrefixMap = {
  base: "/api/memory/xx",
  write: "/api/memory/xx/write",
  ingest: "/api/memory/xx/ingest",
  review: "/api/memory/xx/review",
  recall: "/api/memory/xx/recall",
  orchestrator: "/api/memory/xx/orchestrator",
  projection: "/api/memory/xx/projection",
  ops: "/api/memory/xx/ops"
};

export const LONG_TERM_SCOPE_TYPES = [
  ScopeType.User,
  ScopeType.Project,
  ScopeType.Workspace,
  ScopeType.Global
] as const satisfies ReadonlyArray<ScopeType>;

export const RUNTIME_SCOPE_TYPES = [ScopeType.Run, ScopeType.Task] as const satisfies ReadonlyArray<ScopeType>;

export const DEFAULT_FILTER_MODE = FilterMode.Default;

export const EFFECTIVE_RECALLABLE_ALLOWED_LIFECYCLE_STATUSES = [
  LifecycleStatus.Approved
] as const satisfies ReadonlyArray<LifecycleStatus>;

export const EFFECTIVE_RECALLABLE_ALLOWED_REVIEW_STATES = [
  ReviewState.Approved,
  ReviewState.SilentApproved,
  ReviewState.NotRequired
] as const satisfies ReadonlyArray<ReviewState>;

export const OUTBOX_EVENT_TYPES = [
  OutboxEventType.MemoryCreated,
  OutboxEventType.MemoryUpdated,
  OutboxEventType.MemoryFeedbackRecorded,
  OutboxEventType.MemoryCandidateUpdated,
  OutboxEventType.MemoryLifecycleChanged,
  OutboxEventType.MemoryReviewChanged,
  OutboxEventType.MemorySuperseded,
  OutboxEventType.MemoryTombstoned,
  OutboxEventType.MemoryRelationChanged,
  OutboxEventType.MemorySourceChanged,
  OutboxEventType.MemoryEmbeddingRefreshed,
  OutboxEventType.ProjectionRebuildRequested,
  OutboxEventType.MigrationShadowLoaded,
  OutboxEventType.CacheInvalidateRequested
] as const satisfies ReadonlyArray<OutboxEventType>;
