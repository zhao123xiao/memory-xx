import {
  LifecycleStatus,
  OutboxEventType,
  ReviewState,
  ScopeType,
  type JsonObject
} from "../../shared/types";
import type { RecallRepairRootCauseType } from "../../recall/recall-repair";
import {
  IngestRequestStatus,
  OutboxDispatchStatus,
  WriteCommandType,
  type StoredIngestResult
} from "../../shared/contracts/write";

export type SequenceName =
  | "memory_record"
  | "memory_source"
  | "memory_relation"
  | "memory_event"
  | "outbox_event"
  | "migration_audit"
  | "low_confidence_buffer"
  | "write_ticket"
  | "memory_feedback_event"
  | "recall_trace"
  | "recall_feedback_event"
  | "recall_repair_queue"
  | "cache_invalidation_request"
  | "knowledge_scope_grant"
  | "intelligence_compare_observation";

export interface MemoryRecordRow {
  readonly id: string;
  readonly requestId: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly content: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly metadata: JsonObject;
  readonly contentEmbedding?: readonly number[] | null;
  readonly dedupeKey: string | null;
  readonly lifecycleStatus: LifecycleStatus;
  readonly reviewState: ReviewState;
  readonly isCurrent: boolean;
  readonly version: number;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly governanceStatus: string;
  readonly visibility: string;
  readonly memoryType: string | null;
  readonly embeddingGeneration: string | null;
readonly memoryLayer: string;  readonly factStatus: string;  readonly validAt: string | null;  readonly invalidAt: string | null;  readonly observedAt: string | null;  readonly expiresAt: string | null;  readonly episodeId: string | null;  readonly importance: number;  readonly memoryStrength: number;  readonly decayPolicy: string;
}

export interface MemorySourceRow {
  readonly id: string;
  readonly memoryId: string;
  readonly sourceType: string;
  readonly uri: string | null;
  readonly excerpt: string | null;
  readonly confidence: number | null;
  readonly capturedAt: string | null;
  readonly metadata: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryRelationRow {
  readonly id: string;
  readonly memoryId: string;
  readonly relatedMemoryId: string;
  readonly relationType: string;
  readonly direction: "outbound" | "bidirectional";
  readonly weight: number | null;
  readonly metadata: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryEventRow {
  readonly id: string;
  readonly memoryId: string;
  readonly requestId: string;
  readonly eventType: OutboxEventType;
  readonly actorId: string;
  readonly payload: JsonObject;
  readonly createdAt: string;
}

export interface IngestRequestRow {
  readonly requestId: string;
  readonly commandType: WriteCommandType;
  readonly payloadHash: string;
  readonly payloadJson: string;
  readonly actorId: string;
  readonly status: IngestRequestStatus;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly completedAt: string | null;
  readonly result: StoredIngestResult | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly recoverableAfter: string | null;
  readonly recoverable: boolean;
}

export interface OutboxEventRow {
  readonly id: string;
  readonly aggregateId: string;
  readonly requestId: string;
  readonly eventType: OutboxEventType;
  readonly payload: JsonObject;
  readonly payloadVersion: number;
  readonly dispatchStatus: OutboxDispatchStatus;
  readonly attempts: number;
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
  readonly dispatchedBy?: string | null;
  readonly dispatchStartedAt?: string | null;
  readonly projectionVerified?: boolean | null;
  readonly dispatchMetadata?: JsonObject;
}

export interface MigrationAuditRow {
  readonly id: string;
  readonly requestId: string | null;
  readonly targetTable: string;
  readonly targetId: string;
  readonly batchId: string | null;
  readonly action: string;
  readonly details: JsonObject;
  readonly createdAt: string;
}

export interface ExporterStateRow {
  readonly exporterName: string;
  readonly lastSuccessfulEventId: string | null;
  readonly cursor: string | null;
  readonly lastSuccessAt: string | null;
  readonly failureSummary: string | null;
  readonly isRebuilding: boolean;
  readonly updatedAt: string;
}

export type LowConfidenceBufferStatus = "pending_retry" | "retried" | "promoted" | "abandoned";

export interface LowConfidenceBufferRow {
  readonly id: string;
  readonly requestId: string;
  readonly actorId: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly inputText: string;
  readonly extraction: JsonObject;
  readonly qualityGate: JsonObject;
  readonly status: LowConfidenceBufferStatus;
  readonly retryCount: number;
  readonly nextRetryAt: string | null;
  readonly abandonedAt: string | null;
  readonly promotedMemoryId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WriteTicketStatus =
  | "pending_extraction"
  | "processing_extraction"
  | "completed"
  | "skipped_duplicate"
  | "needs_review"
  | "cancelled_low_quality"
  | "failed_extraction";

export interface WriteTicketRow {
  readonly id: string;
  readonly idempotencyKey: string | null;
  readonly actorId: string;
  readonly agentId: string;
  readonly status: WriteTicketStatus;
  readonly requestJson: JsonObject;
  readonly payloadHash: string | null;
  readonly resultJson: JsonObject | null;
  readonly createdMemoryId: string | null;
  readonly candidateMemoryId: string | null;
  readonly duplicateOfMemoryId: string | null;
  readonly failureReason: string | null;
  readonly expiresAt: string;
  readonly terminalAt: string | null;
  readonly archivedAt: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CacheInvalidationRequestStatus = "pending" | "processing" | "completed" | "failed";

export interface CacheInvalidationRequestRow {
  readonly id: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly reason: string;
  readonly status: CacheInvalidationRequestStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type KnowledgeGrantResourceType = "collection" | "repo";

export interface KnowledgeScopeGrantRow {
  readonly id: string;
  readonly agentId: string;
  readonly resourceType: KnowledgeGrantResourceType;
  readonly resourceId: string;
  readonly permissions: readonly string[];
  readonly expiresAt: string | null;
  readonly createdBy: string;
  readonly revokedAt: string | null;
  readonly metadata: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IntelligenceCompareObservationRow {
  readonly id: string;
  readonly observedAt: string;
  readonly primaryModel: string;
  readonly fallbackModel: string;
  readonly primaryLatencyMs: number;
  readonly fallbackLatencyMs: number;
  readonly primarySchemaValid: boolean;
  readonly fallbackSchemaValid: boolean;
  readonly memoryCountDiff: number;
  readonly confidenceDiff: number;
  readonly metadata: JsonObject;
  readonly createdAt: string;
}

export interface MemoryFeedbackEventRow {
  readonly id: string;
  readonly memoryId: string;
  readonly actorId: string;
  readonly feedbackType: string;
  readonly relatedMemoryId: string | null;
  readonly reason: string | null;
  readonly metadata: JsonObject;
  readonly governanceTriggered: boolean;
  readonly governanceActionId: string | null;
  readonly createdAt: string;
}

export interface RecallTraceRow {
  readonly id: string;
  readonly queryHash: string;
  readonly queryExcerpt: string;
  readonly actorId: string | null;
  readonly scopeContext: JsonObject;
  readonly queryType: string;
  readonly strategy: string;
  readonly degradeLevel: number;
  readonly results: JsonObject;
  readonly audit: JsonObject;
  readonly createdAt: string;
}

export interface RecallFeedbackEventRow {
  readonly id: string;
  readonly recallTraceId: string;
  readonly memoryId: string | null;
  readonly actorId: string;
  readonly feedbackType: string;
  readonly suspicious: boolean;
  readonly reason: string | null;
  readonly metadata: JsonObject;
  readonly createdAt: string;
}

export interface RecallRepairQueueRow {
  readonly id: string;
  readonly queryHash: string;
  readonly recallTraceId: string | null;
  readonly issueType: string;
  readonly count: number;
  readonly status: string;
  readonly details: JsonObject;
  readonly urgency: string;
  readonly rootCauseType: RecallRepairRootCauseType | null;
  readonly rootCause: string | null;
  readonly suggestedAction: string | null;
  readonly governanceActionId: string | null;
  readonly appliedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type GovernanceRunStatus = "running" | "success" | "failed" | "skipped_lock_held" | "partial";
export type GovernanceActionStatus = "reported" | "applied" | "skipped" | "reverted" | "failed";

export interface MemoryGovernanceRunRow {
  readonly id: string;
  readonly jobType: string;
  readonly mode: string;
  readonly policy: string | null;
  readonly status: GovernanceRunStatus;
  readonly lockKey: string;
  readonly leaseExpiresAt: string | null;
  readonly heartbeatAt: string | null;
  readonly leaseAcquiredBy: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly metrics: JsonObject;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryGovernanceActionRow {
  readonly id: string;
  readonly runId: string | null;
  readonly actionType: string;
  readonly scopeType: ScopeType | null;
  readonly scopeId: string | null;
  readonly memoryId: string | null;
  readonly relatedMemoryId: string | null;
  readonly selector: JsonObject;
  readonly evidence: JsonObject;
  readonly beforeState: JsonObject;
  readonly afterState: JsonObject;
  readonly outboxEventIds: readonly string[];
  readonly revertTokenHash: string | null;
  readonly revertExpiresAt: string | null;
  readonly revertedAt: string | null;
  readonly status: GovernanceActionStatus;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface MemoryGovernanceFreezeRow {
  readonly id: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly actions: readonly string[];
  readonly reason: string;
  readonly actorId: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly liftedAt: string | null;
}

export interface GovernancePolicyOverrideRow {
  readonly id: string;
  readonly selectorHash: string;
  readonly selector: JsonObject;
  readonly policyType: string;
  readonly threshold: number | null;
  readonly defaultThreshold: number | null;
  readonly autoApproveEnabled: boolean | null;
  readonly cleanRunCount: number;
  readonly lastCohortAt: string | null;
  readonly expiresAt: string;
  readonly reviewedAt: string | null;
  readonly metadata: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TrustedAgentRow {
  readonly id: string;
  readonly tokenHash: string;
  readonly agentId: string;
  readonly permissions: readonly string[];
  readonly scopes: JsonObject;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScopeGenerationStateRow {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly generation: number;
  readonly bumpedAt: string;
}

export interface WriteDatabaseState {
  readonly memoryRecords: MemoryRecordRow[];
  readonly memorySources: MemorySourceRow[];
  readonly memoryRelations: MemoryRelationRow[];
  readonly memoryEvents: MemoryEventRow[];
  readonly ingestRequests: IngestRequestRow[];
  readonly outboxEvents: OutboxEventRow[];
  readonly migrationAudit: MigrationAuditRow[];
  readonly exporterState: ExporterStateRow[];
  readonly lowConfidenceBuffer: LowConfidenceBufferRow[];
  readonly writeTickets: WriteTicketRow[];
  readonly writeTicketsArchive: WriteTicketRow[];
  readonly memoryFeedbackEvents: MemoryFeedbackEventRow[];
  readonly recallTraces: RecallTraceRow[];
  readonly recallFeedbackEvents: RecallFeedbackEventRow[];
  readonly recallRepairQueue: RecallRepairQueueRow[];
  readonly cacheInvalidationRequests: CacheInvalidationRequestRow[];
  readonly knowledgeScopeGrants: KnowledgeScopeGrantRow[];
  readonly intelligenceCompareObservations: IntelligenceCompareObservationRow[];
  readonly memoryGovernanceRuns?: MemoryGovernanceRunRow[];
  readonly memoryGovernanceActions?: MemoryGovernanceActionRow[];
  readonly memoryGovernanceFreezes?: MemoryGovernanceFreezeRow[];
  readonly governancePolicyOverrides?: GovernancePolicyOverrideRow[];
  readonly trustedAgents: TrustedAgentRow[];
  readonly scopeGenerations: ScopeGenerationStateRow[];
  readonly sequences: Record<SequenceName, number>;
}

export function createEmptyWriteDatabaseState(): WriteDatabaseState {
  return {
    memoryRecords: [],
    memorySources: [],
    memoryRelations: [],
    memoryEvents: [],
    ingestRequests: [],
    outboxEvents: [],
    migrationAudit: [],
    exporterState: [],
    lowConfidenceBuffer: [],
    writeTickets: [],
    writeTicketsArchive: [],
    memoryFeedbackEvents: [],
    recallTraces: [],
    recallFeedbackEvents: [],
    recallRepairQueue: [],
    cacheInvalidationRequests: [],
    knowledgeScopeGrants: [],
    intelligenceCompareObservations: [],
    memoryGovernanceRuns: [],
    memoryGovernanceActions: [],
    memoryGovernanceFreezes: [],
    governancePolicyOverrides: [],
    trustedAgents: [],
    scopeGenerations: [],
    sequences: {
      memory_record: 0,
      memory_source: 0,
      memory_relation: 0,
      memory_event: 0,
      outbox_event: 0,
      migration_audit: 0,
      low_confidence_buffer: 0,
      write_ticket: 0,
      memory_feedback_event: 0,
      recall_trace: 0,
      recall_feedback_event: 0,
      recall_repair_queue: 0,
      cache_invalidation_request: 0,
      knowledge_scope_grant: 0,
      intelligence_compare_observation: 0
    }
  };
}

export function cloneWriteDatabaseState(state: WriteDatabaseState): WriteDatabaseState {
  return {
    memoryRecords: state.memoryRecords.map((row) => ({
      ...row,
      metadata: { ...row.metadata },
      contentEmbedding: row.contentEmbedding ? [...row.contentEmbedding] : row.contentEmbedding
    })),
    memorySources: state.memorySources.map((row) => ({ ...row, metadata: { ...row.metadata } })),
    memoryRelations: state.memoryRelations.map((row) => ({ ...row, metadata: { ...row.metadata } })),
    memoryEvents: state.memoryEvents.map((row) => ({ ...row, payload: { ...row.payload } })),
    ingestRequests: state.ingestRequests.map((row) => ({
      ...row,
      result: row.result ? { ...row.result } : null
    })),
    outboxEvents: state.outboxEvents.map((row) => ({ ...row, payload: { ...row.payload } })),
    migrationAudit: state.migrationAudit.map((row) => ({ ...row, details: { ...row.details } })),
    exporterState: state.exporterState.map((row) => ({ ...row })),
    lowConfidenceBuffer: state.lowConfidenceBuffer.map((row) => ({
      ...row,
      extraction: { ...row.extraction },
      qualityGate: { ...row.qualityGate }
    })),
    writeTickets: state.writeTickets.map((row) => ({
      ...row,
      requestJson: { ...row.requestJson },
      resultJson: row.resultJson ? { ...row.resultJson } : null
    })),
    writeTicketsArchive: state.writeTicketsArchive.map((row) => ({
      ...row,
      requestJson: { ...row.requestJson },
      resultJson: row.resultJson ? { ...row.resultJson } : null
    })),
    memoryFeedbackEvents: state.memoryFeedbackEvents.map((row) => ({
      ...row,
      metadata: { ...row.metadata }
    })),
    recallTraces: state.recallTraces.map((row) => ({
      ...row,
      scopeContext: { ...row.scopeContext },
      results: { ...row.results },
      audit: { ...row.audit }
    })),
    recallFeedbackEvents: state.recallFeedbackEvents.map((row) => ({
      ...row,
      metadata: { ...row.metadata }
    })),
    recallRepairQueue: state.recallRepairQueue.map((row) => ({
      ...row,
      details: { ...row.details }
    })),
    cacheInvalidationRequests: state.cacheInvalidationRequests.map((row) => ({ ...row })),
    knowledgeScopeGrants: state.knowledgeScopeGrants.map((row) => ({
      ...row,
      permissions: [...row.permissions],
      metadata: { ...row.metadata }
    })),
    intelligenceCompareObservations: state.intelligenceCompareObservations.map((row) => ({
      ...row,
      metadata: { ...row.metadata }
    })),
    memoryGovernanceRuns: (state.memoryGovernanceRuns ?? []).map((row) => ({
      ...row,
      metrics: { ...row.metrics }
    })),
    memoryGovernanceActions: (state.memoryGovernanceActions ?? []).map((row) => ({
      ...row,
      selector: { ...row.selector },
      evidence: { ...row.evidence },
      beforeState: { ...row.beforeState },
      afterState: { ...row.afterState },
      outboxEventIds: [...row.outboxEventIds]
    })),
    memoryGovernanceFreezes: (state.memoryGovernanceFreezes ?? []).map((row) => ({
      ...row,
      actions: [...row.actions]
    })),
    governancePolicyOverrides: (state.governancePolicyOverrides ?? []).map((row) => ({
      ...row,
      selector: { ...row.selector },
      metadata: { ...row.metadata }
    })),
    trustedAgents: state.trustedAgents.map((row) => ({
      ...row,
      permissions: [...row.permissions],
      scopes: { ...row.scopes }
    })),
    scopeGenerations: state.scopeGenerations.map((row) => ({ ...row })),
    sequences: { ...state.sequences }
  };
}

// --- Temporal Memory Tables (P1) ---

export interface MemoryEpisodeRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly occurredAt: string | null;
  readonly endedAt: string | null;
  readonly metadata: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryEntityRow {
  readonly id: string;
  readonly entityType: string;
  readonly name: string;
  readonly canonicalName: string | null;
  readonly metadata: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryEntityLinkRow {
  readonly id: string;
  readonly entityId: string;
  readonly memoryId: string;
  readonly role: string;
  readonly confidence: number;
  readonly createdAt: string;
}
