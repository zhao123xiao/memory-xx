import type { QueryResultRow } from "pg";
import type {
  GovernancePolicyOverrideRow,
  IntelligenceCompareObservationRow,
  KnowledgeScopeGrantRow,
  LowConfidenceBufferRow,
  MemoryGovernanceActionRow,
  MemoryGovernanceFreezeRow,
  MemoryGovernanceRunRow,
  CacheInvalidationRequestRow,
  MemoryFeedbackEventRow,
  RecallFeedbackEventRow,
  RecallRepairQueueRow,
  RecallTraceRow,
  WriteTicketRow,
} from "../schema/tables";
import type { JsonObject } from "../../shared";
import { normalizeRecallRepairRootCauseType } from "../../recall/recall-repair";
import { readNullablePgBoolean, readPgBoolean } from "../row-value-readers";

export function mapLowConfidenceBufferRow(row: QueryResultRow): LowConfidenceBufferRow {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    actorId: String(row.actor_id),
    scopeType: String(row.scope_type) as LowConfidenceBufferRow["scopeType"],
    scopeId: String(row.scope_id),
    inputText: String(row.input_text),
    extraction: asJsonObject(row.extraction),
    qualityGate: asJsonObject(row.quality_gate),
    status: String(row.status) as LowConfidenceBufferRow["status"],
    retryCount: Number(row.retry_count ?? 0),
    nextRetryAt: toOptionalIsoString(row.next_retry_at),
    abandonedAt: toOptionalIsoString(row.abandoned_at),
    promotedMemoryId: nullableString(row.promoted_memory_id),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export function mapWriteTicketRow(row: QueryResultRow): WriteTicketRow {
  return {
    id: String(row.id),
    idempotencyKey: nullableString(row.idempotency_key),
    actorId: String(row.actor_id),
    agentId: String(row.agent_id),
    status: String(row.status) as WriteTicketRow["status"],
    requestJson: asJsonObject(row.request_json),
    payloadHash: nullableString(row.payload_hash),
    resultJson: row.result_json ? asJsonObject(row.result_json) : null,
    createdMemoryId: nullableString(row.created_memory_id),
    candidateMemoryId: nullableString(row.candidate_memory_id),
    duplicateOfMemoryId: nullableString(row.duplicate_of_memory_id),
    failureReason: nullableString(row.failure_reason),
    expiresAt: toIsoString(row.expires_at),
    terminalAt: toOptionalIsoString(row.terminal_at),
    archivedAt: toOptionalIsoString(row.archived_at),
    leaseOwner: nullableString(row.lease_owner),
    leaseExpiresAt: toOptionalIsoString(row.lease_expires_at),
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: toOptionalIsoString(row.next_attempt_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export function mapCacheInvalidationRequestRow(row: QueryResultRow): CacheInvalidationRequestRow {
  return {
    id: String(row.id),
    scopeType: String(row.scope_type) as CacheInvalidationRequestRow["scopeType"],
    scopeId: String(row.scope_id),
    reason: String(row.reason ?? "unknown"),
    status: String(row.status) as CacheInvalidationRequestRow["status"],
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: toOptionalIsoString(row.next_attempt_at),
    lastError: nullableString(row.last_error),
    leaseOwner: nullableString(row.lease_owner),
    leaseExpiresAt: toOptionalIsoString(row.lease_expires_at),
    completedAt: toOptionalIsoString(row.completed_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export function mapKnowledgeScopeGrantRow(row: QueryResultRow): KnowledgeScopeGrantRow {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    resourceType: String(row.resource_type) as KnowledgeScopeGrantRow["resourceType"],
    resourceId: String(row.resource_id),
    permissions: readStringArray(row.permissions),
    expiresAt: toOptionalIsoString(row.expires_at),
    createdBy: String(row.created_by),
    revokedAt: toOptionalIsoString(row.revoked_at),
    metadata: asJsonObject(row.metadata),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export function mapIntelligenceCompareObservationRow(row: QueryResultRow): IntelligenceCompareObservationRow {
  return {
    id: String(row.id),
    observedAt: toIsoString(row.observed_at),
    primaryModel: String(row.primary_model),
    fallbackModel: String(row.fallback_model),
    primaryLatencyMs: Number(row.primary_latency_ms ?? 0),
    fallbackLatencyMs: Number(row.fallback_latency_ms ?? 0),
    primarySchemaValid: readPgBoolean(row.primary_schema_valid, "intelligence_compare_observations.primary_schema_valid"),
    fallbackSchemaValid: readPgBoolean(row.fallback_schema_valid, "intelligence_compare_observations.fallback_schema_valid"),
    memoryCountDiff: Number(row.memory_count_diff ?? 0),
    confidenceDiff: Number(row.confidence_diff ?? 0),
    metadata: asJsonObject(row.metadata),
    createdAt: toIsoString(row.created_at),
  };
}

export function mapMemoryFeedbackEventRow(row: QueryResultRow): MemoryFeedbackEventRow {
  return {
    id: String(row.id),
    memoryId: String(row.memory_id),
    actorId: String(row.actor_id),
    feedbackType: String(row.feedback_type),
    relatedMemoryId: nullableString(row.related_memory_id),
    reason: nullableString(row.reason),
    metadata: asJsonObject(row.metadata),
    governanceTriggered: readPgBoolean(row.governance_triggered, "memory_feedback_events.governance_triggered"),
    governanceActionId: nullableString(row.governance_action_id),
    createdAt: toIsoString(row.created_at),
  };
}

export function mapRecallTraceRow(row: QueryResultRow): RecallTraceRow {
  return {
    id: String(row.id),
    queryHash: String(row.query_hash),
    queryExcerpt: String(row.query_excerpt ?? ""),
    actorId: nullableString(row.actor_id),
    scopeContext: asJsonObject(row.scope_context),
    queryType: String(row.query_type),
    strategy: String(row.strategy),
    degradeLevel: Number(row.degrade_level ?? 0),
    results: asJsonObject(row.results),
    audit: asJsonObject(row.audit),
    createdAt: toIsoString(row.created_at),
  };
}

export function mapRecallFeedbackEventRow(row: QueryResultRow): RecallFeedbackEventRow {
  return {
    id: String(row.id),
    recallTraceId: String(row.recall_trace_id),
    memoryId: nullableString(row.memory_id),
    actorId: String(row.actor_id),
    feedbackType: String(row.feedback_type),
    suspicious: readPgBoolean(row.suspicious, "recall_feedback_events.suspicious"),
    reason: nullableString(row.reason),
    metadata: asJsonObject(row.metadata),
    createdAt: toIsoString(row.created_at),
  };
}

export function mapRecallRepairQueueRow(row: QueryResultRow): RecallRepairQueueRow {
  return {
    id: String(row.id),
    queryHash: String(row.query_hash),
    recallTraceId: nullableString(row.recall_trace_id),
    issueType: String(row.issue_type),
    count: Number(row.count ?? 0),
    status: String(row.status),
    details: asJsonObject(row.details),
    urgency: String(row.urgency ?? "P2"),
    rootCauseType: normalizeRecallRepairRootCauseType(row.root_cause_type ?? row.root_cause),
    rootCause: nullableString(row.root_cause),
    suggestedAction: nullableString(row.suggested_action),
    governanceActionId: nullableString(row.governance_action_id),
    appliedAt: toOptionalIsoString(row.applied_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export function mapMemoryGovernanceRunRow(row: QueryResultRow): MemoryGovernanceRunRow {
  return {
    id: String(row.id),
    jobType: String(row.job_type),
    mode: String(row.mode),
    policy: nullableString(row.policy),
    status: String(row.status) as MemoryGovernanceRunRow["status"],
    lockKey: String(row.lock_key),
    leaseExpiresAt: toOptionalIsoString(row.lease_expires_at),
    heartbeatAt: toOptionalIsoString(row.heartbeat_at),
    leaseAcquiredBy: nullableString(row.lease_acquired_by),
    startedAt: toIsoString(row.started_at),
    finishedAt: toOptionalIsoString(row.finished_at),
    metrics: asJsonObject(row.metrics),
    error: nullableString(row.error),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export function mapMemoryGovernanceActionRow(row: QueryResultRow): MemoryGovernanceActionRow {
  return {
    id: String(row.id),
    runId: nullableString(row.run_id),
    actionType: String(row.action_type),
    scopeType: nullableString(row.scope_type) as MemoryGovernanceActionRow["scopeType"],
    scopeId: nullableString(row.scope_id),
    memoryId: nullableString(row.memory_id),
    relatedMemoryId: nullableString(row.related_memory_id),
    selector: asJsonObject(row.selector),
    evidence: asJsonObject(row.evidence),
    beforeState: asJsonObject(row.before_state),
    afterState: asJsonObject(row.after_state),
    outboxEventIds: readStringArray(row.outbox_event_ids),
    revertTokenHash: nullableString(row.revert_token_hash),
    revertExpiresAt: toOptionalIsoString(row.revert_expires_at),
    revertedAt: toOptionalIsoString(row.reverted_at),
    status: String(row.status) as MemoryGovernanceActionRow["status"],
    createdBy: String(row.created_by),
    createdAt: toIsoString(row.created_at),
  };
}

export function mapMemoryGovernanceFreezeRow(row: QueryResultRow): MemoryGovernanceFreezeRow {
  return {
    id: String(row.id),
    scopeType: String(row.scope_type) as MemoryGovernanceFreezeRow["scopeType"],
    scopeId: String(row.scope_id),
    actions: readStringArray(row.actions),
    reason: String(row.reason),
    actorId: String(row.actor_id),
    expiresAt: toIsoString(row.expires_at),
    createdAt: toIsoString(row.created_at),
    liftedAt: toOptionalIsoString(row.lifted_at),
  };
}

export function mapGovernancePolicyOverrideRow(row: QueryResultRow): GovernancePolicyOverrideRow {
  return {
    id: String(row.id),
    selectorHash: String(row.selector_hash),
    selector: asJsonObject(row.selector),
    policyType: String(row.policy_type),
    threshold: nullableNumber(row.threshold),
    defaultThreshold: nullableNumber(row.default_threshold),
    autoApproveEnabled: readNullablePgBoolean(row.auto_approve_enabled, "governance_policy_overrides.auto_approve_enabled"),
    cleanRunCount: Number(row.clean_run_count ?? 0),
    lastCohortAt: toOptionalIsoString(row.last_cohort_at),
    expiresAt: toIsoString(row.expires_at),
    reviewedAt: toOptionalIsoString(row.reviewed_at),
    metadata: asJsonObject(row.metadata),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [];
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new TypeError("Expected timestamp row value.");
}

function toOptionalIsoString(value: unknown): string | null {
  return value === null || value === undefined ? null : toIsoString(value);
}
