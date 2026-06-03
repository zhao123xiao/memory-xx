import type { QueryResultRow } from "pg";
import { readNullablePgBoolean, readPgBoolean } from "../row-value-readers";

import type {
  ExporterStateRow,
  IngestRequestRow,
  MemoryEventRow,
  MemoryRecordRow,
  MemoryRelationRow,
  MemorySourceRow,
  MigrationAuditRow,
  OutboxEventRow
} from "../schema/tables";
import {
  mapLowConfidenceBufferRow as _mapLowConfidenceBufferRow,
  mapMemoryFeedbackEventRow as _mapMemoryFeedbackEventRow,
  mapRecallFeedbackEventRow as _mapRecallFeedbackEventRow,
  mapRecallRepairQueueRow as _mapRecallRepairQueueRow,
  mapRecallTraceRow as _mapRecallTraceRow,
  mapCacheInvalidationRequestRow as _mapCacheInvalidationRequestRow,
  mapIntelligenceCompareObservationRow as _mapIntelligenceCompareObservationRow,
  mapKnowledgeScopeGrantRow as _mapKnowledgeScopeGrantRow,
  mapWriteTicketRow as _mapWriteTicketRow
} from "../repositories/support-row-mappers";

// Re-export support table mappers from support-row-mappers (source of truth)
export const mapLowConfidenceBufferRow = _mapLowConfidenceBufferRow;
export const mapWriteTicketRow = _mapWriteTicketRow;
export const mapMemoryFeedbackEventRow = _mapMemoryFeedbackEventRow;
export const mapRecallTraceRow = _mapRecallTraceRow;
export const mapRecallFeedbackEventRow = _mapRecallFeedbackEventRow;
export const mapRecallRepairQueueRow = _mapRecallRepairQueueRow;
export const mapCacheInvalidationRequestRow = _mapCacheInvalidationRequestRow;
export const mapKnowledgeScopeGrantRow = _mapKnowledgeScopeGrantRow;
export const mapIntelligenceCompareObservationRow = _mapIntelligenceCompareObservationRow;

// TrustedAgent and ScopeGeneration mappers are defined here since support-row-mappers does not export them
export function mapTrustedAgentRow(row: QueryResultRow): import("../schema/tables").TrustedAgentRow {
  const v = row as Record<string, unknown>;
  return {
    id: String(v.id ?? ""),
    tokenHash: String(v.token_hash ?? ""),
    agentId: String(v.agent_id ?? ""),
    permissions: Array.isArray(v.permissions) ? v.permissions.map(String) : [],
    scopes: (v.scopes && typeof v.scopes === "object" && !Array.isArray(v.scopes) ? v.scopes : {}) as import("../../shared/types").JsonObject,
    expiresAt: v.expires_at ? new Date(String(v.expires_at)).toISOString() : null,
    revokedAt: v.revoked_at ? new Date(String(v.revoked_at)).toISOString() : null,
    createdAt: new Date(String(v.created_at ?? new Date().toISOString())).toISOString(),
    updatedAt: new Date(String(v.updated_at ?? new Date().toISOString())).toISOString(),
  };
}

export function mapScopeGenerationStateRow(row: QueryResultRow): import("../schema/tables").ScopeGenerationStateRow {
  const v = row as Record<string, unknown>;
  return {
    scopeType: String(v.scope_type ?? ""),
    scopeId: String(v.scope_id ?? ""),
    generation: Number(v.generation ?? 0),
    bumpedAt: new Date(String(v.bumped_at ?? new Date().toISOString())).toISOString(),
  };
}
import type { StoredIngestResult } from "../../shared/contracts/write";
import type { JsonObject } from "../../shared/types";

interface PostgresTimestampedRow extends QueryResultRow {
  readonly created_at?: Date | string | null;
  readonly updated_at?: Date | string | null;
  readonly captured_at?: Date | string | null;
  readonly first_seen_at?: Date | string | null;
  readonly last_seen_at?: Date | string | null;
  readonly completed_at?: Date | string | null;
  readonly lease_expires_at?: Date | string | null;
  readonly last_heartbeat_at?: Date | string | null;
  readonly recoverable_after?: Date | string | null;
  readonly dispatched_at?: Date | string | null;
  readonly dispatch_started_at?: Date | string | null;
  readonly last_success_at?: Date | string | null;
  readonly valid_at?: Date | string | null;
  readonly invalid_at?: Date | string | null;
  readonly observed_at?: Date | string | null;
  readonly expires_at?: Date | string | null;
}

export function mapMemoryRecordRow(row: QueryResultRow): MemoryRecordRow {
  return {
    id: asString(row.id),
    requestId: asString(row.request_id),
    scopeType: asString(row.scope_type) as MemoryRecordRow["scopeType"],
    scopeId: asString(row.scope_id),
    content: asString(row.content),
    title: asNullableString(row.title),
    summary: asNullableString(row.summary),
    metadata: asJsonObject(row.metadata),
    contentEmbedding: asOptionalVector(row.content_embedding),
    dedupeKey: asNullableString(row.dedupe_key),
    lifecycleStatus: asString(row.lifecycle_status) as MemoryRecordRow["lifecycleStatus"],
    reviewState: asString(row.review_state) as MemoryRecordRow["reviewState"],
    isCurrent: readPgBoolean(row.is_current, "memory_records.is_current"),
    version: asNumber(row.version),
    createdBy: asString(row.created_by),
    updatedBy: asString(row.updated_by),
    createdAt: toIsoString((row as PostgresTimestampedRow).created_at),
    updatedAt: toIsoString((row as PostgresTimestampedRow).updated_at),
    tenantId: asString(row.tenant_id ?? "default"),
    agentId: asString(row.agent_id ?? "unknown"),
    governanceStatus: asString(row.governance_status ?? "normal"),
    visibility: asString(row.visibility ?? "scope_only"),
    memoryType: asNullableString(row.memory_type),
    embeddingGeneration: asNullableString(row.embedding_generation),
    memoryLayer: asString(row.memory_layer ?? "recall"),
    factStatus: asString(row.fact_status ?? "current"),
    validAt: toOptionalIsoString((row as PostgresTimestampedRow).valid_at),
    invalidAt: toOptionalIsoString((row as PostgresTimestampedRow).invalid_at),
    observedAt: toOptionalIsoString((row as PostgresTimestampedRow).observed_at),
    expiresAt: toOptionalIsoString((row as PostgresTimestampedRow).expires_at),
    episodeId: asNullableString(row.episode_id as string | null),
    importance: row.importance != null ? asNumber(row.importance) : 0.5,
    memoryStrength: row.memory_strength != null ? asNumber(row.memory_strength) : 1.0,
    decayPolicy: asString(row.decay_policy ?? "importance_weighted")
  };
}

export function mapMemorySourceRow(row: QueryResultRow): MemorySourceRow {
  return {
    id: asString(row.id),
    memoryId: asString(row.memory_id),
    sourceType: asString(row.source_type),
    uri: asNullableString(row.uri),
    excerpt: asNullableString(row.excerpt),
    confidence: asNullableNumber(row.confidence),
    capturedAt: toOptionalIsoString((row as PostgresTimestampedRow).captured_at),
    metadata: asJsonObject(row.metadata),
    createdAt: toIsoString((row as PostgresTimestampedRow).created_at),
    updatedAt: toIsoString((row as PostgresTimestampedRow).updated_at)
  };
}

export function mapMemoryRelationRow(row: QueryResultRow): MemoryRelationRow {
  return {
    id: asString(row.id),
    memoryId: asString(row.memory_id),
    relatedMemoryId: asString(row.related_memory_id),
    relationType: asString(row.relation_type),
    direction: asString(row.direction) as MemoryRelationRow["direction"],
    weight: asNullableNumber(row.weight),
    metadata: asJsonObject(row.metadata),
    createdAt: toIsoString((row as PostgresTimestampedRow).created_at),
    updatedAt: toIsoString((row as PostgresTimestampedRow).updated_at)
  };
}

export function mapMemoryEventRow(row: QueryResultRow): MemoryEventRow {
  return {
    id: asString(row.id),
    memoryId: asString(row.memory_id),
    requestId: asString(row.request_id),
    eventType: asString(row.event_type) as MemoryEventRow["eventType"],
    actorId: asString(row.actor_id),
    payload: asJsonObject(row.payload),
    createdAt: toIsoString((row as PostgresTimestampedRow).created_at)
  };
}

export function mapIngestRequestRow(row: QueryResultRow): IngestRequestRow {
  return {
    requestId: asString(row.request_id),
    commandType: asString(row.command_type) as IngestRequestRow["commandType"],
    payloadHash: asString(row.payload_hash),
    payloadJson: JSON.stringify(row.payload_json ?? {}),
    actorId: asString(row.actor_id),
    status: asString(row.status) as IngestRequestRow["status"],
    firstSeenAt: toIsoString((row as PostgresTimestampedRow).first_seen_at),
    lastSeenAt: toIsoString((row as PostgresTimestampedRow).last_seen_at),
    completedAt: toOptionalIsoString((row as PostgresTimestampedRow).completed_at),
    result: (row.result_json ?? null) as StoredIngestResult | null,
    errorCode: asNullableString(row.error_code),
    errorMessage: asNullableString(row.error_message),
    leaseOwner: asNullableString(row.lease_owner),
    leaseExpiresAt: toOptionalIsoString((row as PostgresTimestampedRow).lease_expires_at),
    lastHeartbeatAt: toOptionalIsoString((row as PostgresTimestampedRow).last_heartbeat_at),
    recoverableAfter: toOptionalIsoString((row as PostgresTimestampedRow).recoverable_after),
    recoverable: readPgBoolean(row.recoverable, "ingest_requests.recoverable")
  };
}

export function mapOutboxEventRow(row: QueryResultRow): OutboxEventRow {
  return {
    id: asString(row.id),
    aggregateId: asString(row.aggregate_id),
    requestId: asString(row.request_id),
    eventType: asString(row.event_type) as OutboxEventRow["eventType"],
    payload: asJsonObject(row.payload),
    payloadVersion: asNumber(row.payload_version),
    dispatchStatus: asString(row.dispatch_status) as OutboxEventRow["dispatchStatus"],
    attempts: asNumber(row.attempts),
    createdAt: toIsoString((row as PostgresTimestampedRow).created_at),
    dispatchedAt: toOptionalIsoString((row as PostgresTimestampedRow).dispatched_at),
    dispatchedBy: asNullableString(row.dispatched_by),
    dispatchStartedAt: toOptionalIsoString((row as PostgresTimestampedRow).dispatch_started_at),
    projectionVerified: readNullablePgBoolean(row.projection_verified, "outbox_events.projection_verified"),
    dispatchMetadata: asJsonObject(row.dispatch_metadata)
  };
}

export function mapMigrationAuditRow(row: QueryResultRow): MigrationAuditRow {
  return {
    id: asString(row.id),
    requestId: asNullableString(row.request_id),
    targetTable: asString(row.target_table),
    targetId: asString(row.target_id),
    batchId: asNullableString(row.batch_id),
    action: asString(row.action),
    details: asJsonObject(row.details),
    createdAt: toIsoString((row as PostgresTimestampedRow).created_at)
  };
}

export function mapExporterStateRow(row: QueryResultRow): ExporterStateRow {
  return {
    exporterName: asString(row.exporter_name),
    lastSuccessfulEventId: asNullableString(row.last_successful_event_id),
    cursor: asNullableString(row.cursor),
    lastSuccessAt: toOptionalIsoString((row as PostgresTimestampedRow).last_success_at),
    failureSummary: asNullableString(row.failure_summary),
    isRebuilding: readPgBoolean(row.is_rebuilding, "exporter_state.is_rebuilding"),
    updatedAt: toIsoString((row as PostgresTimestampedRow).updated_at)
  };
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Expected a string row value.");
  }

  return value;
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }

  throw new TypeError("Expected a numeric row value.");
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as JsonObject;
}

function asOptionalVector(value: unknown): readonly number[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    const numbers = value.filter((item): item is number => typeof item === "number");
    return numbers.length === value.length ? numbers : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }

    const normalized = trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
    if (normalized.trim() === "") {
      return [];
    }

    const numbers = normalized
      .split(",")
      .map((item) => Number(item.trim()));
    return numbers.every((item) => Number.isFinite(item)) ? numbers : null;
  }

  return null;
}

function toIsoString(value: Date | string | null | undefined): string {
  if (!value) {
    throw new TypeError("Expected a timestamp row value.");
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function toOptionalIsoString(value: Date | string | null | undefined): string | null {
  return value ? toIsoString(value) : null;
}
