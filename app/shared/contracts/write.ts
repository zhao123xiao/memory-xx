import {
  LONG_TERM_SCOPE_TYPES
} from "../constants";
import {
  LifecycleStatus,
  OutboxEventType,
  ReviewState,
  ScopeType,
  type JsonObject
} from "../types";

export enum WriteCommandType {
  CreateMemory = "memory.create",
  FeedbackMemory = "memory.feedback",
  ApproveMemory = "memory.approve",
  RejectMemory = "memory.reject",
  UpdateCandidateMemory = "memory.candidate.update",
  ArchiveMemory = "memory.archive",
  SupersedeMemory = "memory.supersede",
  TombstoneMemory = "memory.tombstone",
  RecallFeedback = "recall.feedback"
}

export enum IngestRequestStatus {
  Accepted = "accepted",
  Completed = "completed",
  Failed = "failed"
}

export enum OutboxDispatchStatus {
  Pending = "pending",
  Dispatched = "dispatched",
  Failed = "failed"
}

export const CREATE_MEMORY_ALLOWED_LIFECYCLE_STATUSES = [
  LifecycleStatus.Candidate,
  LifecycleStatus.Approved
] as const satisfies ReadonlyArray<LifecycleStatus>;

export const CREATE_MEMORY_DIRECT_APPROVAL_REVIEW_STATES = [
  ReviewState.Approved,
  ReviewState.SilentApproved,
  ReviewState.NotRequired
] as const satisfies ReadonlyArray<ReviewState>;

export interface MemorySourceInput {
  readonly sourceType: string;
  readonly uri?: string | null;
  readonly excerpt?: string | null;
  readonly confidence?: number | null;
  readonly capturedAt?: string | null;
  readonly metadata?: JsonObject | null;
}

export interface MemoryRelationInput {
  readonly relatedMemoryId: string;
  readonly relationType: string;
  readonly direction?: "outbound" | "bidirectional";
  readonly weight?: number | null;
  readonly metadata?: JsonObject | null;
}

export interface CreateMemoryCommand {
  readonly requestId: string;
  readonly actorId: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly content: string;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly metadata?: JsonObject | null;
  readonly dedupeKey?: string | null;
  readonly tenantId?: string | null;
  readonly agentId?: string | null;
  readonly governanceStatus?: string | null;
  readonly visibility?: string | null;
  readonly memoryType?: string | null;
  readonly contentEmbedding?: readonly number[] | null;
  readonly validAt?: string | null;
  readonly observedAt?: string | null;
  readonly expiresAt?: string | null;
  readonly lifecycleStatus: LifecycleStatus.Candidate | LifecycleStatus.Approved;
  readonly reviewState: ReviewState.Pending | ReviewState.Approved | ReviewState.SilentApproved | ReviewState.NotRequired;
  readonly sources?: readonly MemorySourceInput[];
  readonly relations?: readonly MemoryRelationInput[];
}

export interface NormalizedCreateMemoryCommand {
  readonly requestId: string;
  readonly actorId: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly content: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly metadata: JsonObject;
  readonly dedupeKey: string | null;
  readonly tenantId: string;
  readonly agentId: string;
  readonly governanceStatus: string;
  readonly visibility: string;
  readonly memoryType: string | null;
  readonly contentEmbedding: readonly number[] | null;
  readonly validAt: string | null;
  readonly observedAt: string | null;
  readonly expiresAt: string | null;
  readonly lifecycleStatus: LifecycleStatus.Candidate | LifecycleStatus.Approved;
  readonly reviewState: ReviewState.Pending | ReviewState.Approved | ReviewState.SilentApproved | ReviewState.NotRequired;
  readonly sources: readonly MemorySourceInput[];
  readonly relations: readonly MemoryRelationInput[];
}

export interface StoredWriteResult {
  readonly commandType: WriteCommandType;
  readonly memoryId: string;
  readonly requestId: string;
  readonly lifecycleStatus: LifecycleStatus;
  readonly reviewState: ReviewState;
  readonly isCurrent: boolean;
  readonly version: number;
  readonly memoryEventType: OutboxEventType;
  readonly outboxEventType: OutboxEventType;
  readonly memoryEventId: string;
  readonly outboxEventId: string;
  readonly affectedMemoryIds?: readonly string[];
  readonly supersededMemoryId?: string | null;
}

export type StoredIngestResult = StoredWriteResult | JsonObject;

export interface RegisteredIngestRequest {
  readonly requestId: string;
  readonly commandType: WriteCommandType;
  readonly payloadHash: string;
  readonly payloadJson: string;
  readonly actorId: string;
}

export interface RequestReplayHit<TResult> {
  readonly kind: "replayed";
  readonly requestId: string;
  readonly storedResult: TResult;
}

export interface RequestAccepted {
  readonly kind: "accepted";
  readonly request: RegisteredIngestRequest;
}

export type RequestRegistrationResult<TResult> = RequestReplayHit<TResult> | RequestAccepted;

export function isLongTermScopeType(scopeType: ScopeType): boolean {
  return LONG_TERM_SCOPE_TYPES.includes(scopeType as (typeof LONG_TERM_SCOPE_TYPES)[number]);
}

export function canCreateMemoryWithState(
  lifecycleStatus: CreateMemoryCommand["lifecycleStatus"],
  reviewState: CreateMemoryCommand["reviewState"]
): boolean {
  if (lifecycleStatus === LifecycleStatus.Candidate) {
    return reviewState === ReviewState.Pending;
  }

  if (lifecycleStatus !== LifecycleStatus.Approved) {
    return false;
  }

  return CREATE_MEMORY_DIRECT_APPROVAL_REVIEW_STATES.includes(
    reviewState as (typeof CREATE_MEMORY_DIRECT_APPROVAL_REVIEW_STATES)[number]
  );
}
