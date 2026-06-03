export enum LifecycleStatus {
  Candidate = "candidate",
  Approved = "approved",
  Rejected = "rejected",
  Archived = "archived",
  Superseded = "superseded",
  Tombstone = "tombstone"
}

export enum ReviewState {
  Pending = "pending",
  Approved = "approved",
  SilentApproved = "silent_approved",
  NotRequired = "not_required",
  Rejected = "rejected"
}

export enum FilterMode {
  Default = "default",
  Governance = "governance",
  All = "all",
  ShadowCompare = "shadow_compare"
}

export enum ScopeType {
  User = "user",
  Project = "project",
  Workspace = "workspace",
  Global = "global",
  Run = "run",
  Task = "task"
}

/**
 * Canonical visibility vocabulary shared by the v2.1 contract work.
 *
 * This enum is intentionally route/schema-facing: it can be reused by a
 * memory-level `visibility` field and by route-level allowance fields such as
 * `allowedVisibilities`, but the two concepts are not interchangeable.
 */
export enum Visibility {
  Shared = "shared",
  Personal = "personal",
  Research = "research",
  Governance = "governance",
  Execution = "execution"
}

export enum OutboxEventType {
  MemoryCreated = "memory.created",
  MemoryUpdated = "memory.updated",
  MemoryFeedbackRecorded = "memory.feedback.recorded",
  MemoryCandidateUpdated = "memory.candidate.updated",
  MemoryLifecycleChanged = "memory.lifecycle.changed",
  MemoryReviewChanged = "memory.review.changed",
  MemorySuperseded = "memory.superseded",
  MemoryTombstoned = "memory.tombstoned",
  MemoryRelationChanged = "memory.relation.changed",
  MemorySourceChanged = "memory.source.changed",
  MemoryEmbeddingRefreshed = "memory.embedding.refreshed",
  ProjectionRebuildRequested = "projection.rebuild.requested",
  MigrationShadowLoaded = "migration.shadow.loaded",
  CacheInvalidateRequested = "cache.invalidate.requested"
}

export interface MemoryGovernanceFields {
  lifecycleStatus: LifecycleStatus;
  isCurrent: boolean;
  reviewState: ReviewState;
  recallPolicy?: string | null;
}

export interface CanonicalPredicate<TInput> {
  readonly id: string;
  readonly description: string;
  readonly expression: string;
  readonly sqlWhereClause: string;
  evaluate(input: TInput): boolean;
}

export interface ApiPrefixMap {
  readonly base: string;
  readonly write: string;
  readonly ingest: string;
  readonly review: string;
  readonly recall: string;
  readonly orchestrator: string;
  readonly projection: string;
  readonly ops: string;
}

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

// --- Temporal Hierarchical Memory Types (P1) ---

export type MemoryLayer = 'core' | 'semantic' | 'episodic' | 'procedural' | 'recall' | 'archival' | 'audit';
export type FactStatus = 'current' | 'historical' | 'deprecated' | 'resurrected';
export type DecayPolicy = 'none' | 'time_based' | 'access_based' | 'importance_weighted';

export const RECALLABLE_MEMORY_LAYERS: readonly MemoryLayer[] = ['core', 'semantic', 'procedural', 'recall'] as const;
export const ALL_MEMORY_LAYERS: readonly MemoryLayer[] = ['core', 'semantic', 'episodic', 'procedural', 'recall', 'archival', 'audit'] as const;
export const CURRENT_FACT_STATUSES: readonly FactStatus[] = ['current', 'resurrected'] as const;
