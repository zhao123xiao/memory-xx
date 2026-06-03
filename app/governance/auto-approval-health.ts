import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  isInMemoryTransactionContext,
  isPostgresTransactionContext,
  withWriteTransaction,
  type WriteTransactionRunner,
} from "../db/tx/write-transaction";
import { loadMemoryV2QdrantConfig } from "../recall/qdrant-config";
import { readRuntimeControlNumberSync } from "../runtime-control-settings";
import type { JsonObject, JsonValue } from "../shared/types";

export interface AutoApprovalHealthSnapshot {
  readonly id: string;
  readonly checked_at: string;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly metrics: JsonObject;
}

function readIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readRuntimeInt(runtimeKey: string, envName: string, fallback: number): number {
  const envValue = readIntEnv(envName, fallback);
  const runtimeValue = readRuntimeControlNumberSync(runtimeKey, envValue);
  return Number.isFinite(runtimeValue) && runtimeValue >= 0 ? runtimeValue : envValue;
}

function forcedBlockers(): string[] {
  return (process.env.MEMORY_V2_AUTO_APPROVAL_FORCE_OPERATIONAL_BLOCKER ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function fetchQdrantPointCount(timeoutMs: number): Promise<number | null> {
  const config = loadMemoryV2QdrantConfig();
  if (!config.enabled || !config.base_url || !config.collection_name) return null;
  const response = await fetch(
    `${config.base_url.replace(/\/$/, "")}/collections/${encodeURIComponent(config.collection_name)}/points/count`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.api_key ? { "api-key": config.api_key } : {}),
      },
      body: JSON.stringify({ exact: true }),
      signal: AbortSignal.timeout(timeoutMs),
    }
  );
  if (!response.ok) throw new Error(`qdrant_count_http_${response.status}`);
  const body = await response.json() as { result?: { count?: number } };
  return typeof body.result?.count === "number" ? body.result.count : null;
}

async function readProjectorStatus(maxAgeMs: number): Promise<{ age_seconds: number | null; stale: boolean; error?: string }> {
  const statusPath = process.env.MEMORY_V2_QDRANT_PROJECTOR_STATUS_FILE?.trim() ||
    path.join(process.cwd(), "qdrant-projector-worker.status.json");
  try {
    const raw = await readFile(statusPath, "utf8");
    const parsed = JSON.parse(raw) as { ts?: string; snapshot?: { lastTickAt?: string | null; running?: boolean; lastError?: string | null } };
    const observedAt = parsed.snapshot?.lastTickAt ?? parsed.ts;
    const timestamp = observedAt ? Date.parse(observedAt) : NaN;
    const ageSeconds = Number.isFinite(timestamp) ? Math.max(0, Math.round((Date.now() - timestamp) / 1000)) : null;
    return {
      age_seconds: ageSeconds,
      stale: ageSeconds !== null && ageSeconds * 1000 > maxAgeMs,
      ...(parsed.snapshot?.lastError ? { error: parsed.snapshot.lastError } : {}),
    };
  } catch (error) {
    return { age_seconds: null, stale: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function collectAutoApprovalOperationalHealth(input: {
  readonly database?: WriteTransactionRunner | null;
} = {}): Promise<AutoApprovalHealthSnapshot> {
  const checkedAt = new Date().toISOString();
  const blockers = [...forcedBlockers()];
  const warnings: string[] = [];
  const metrics: Record<string, JsonValue> = {};

  const database = input.database;
  if (!database) {
    return {
      id: randomUUID(),
      checked_at: checkedAt,
      blockers,
      warnings: [...warnings, "database_unavailable_for_health_snapshot"],
      metrics,
    };
  }

  try {
    await withWriteTransaction(database, async (tx) => {
      if (isPostgresTransactionContext(tx)) {
        const [row] = await tx.query<{
          outbox_backlog: string | number;
          outbox_failed: string | number;
          cache_invalidation_backlog: string | number;
          cache_invalidation_failed: string | number;
          mem0_official_fallback_recent: string | number;
          approved_without_projection_recent: string | number;
          postgres_effective_recallable_count: string | number;
          active_manifest_count: string | number;
          active_manifest_generation_id: string | null;
          active_manifest_record_count: string | number | null;
          active_manifest_point_count: string | number | null;
          active_manifest_dims: string | number | null;
          active_manifest_payload_sample_verified: boolean | string | null;
          policy_reject_by_policy_recent: string | number;
          policy_quarantine_current: string | number;
          policy_test_only_current: string | number;
          policy_audit_only_current: string | number;
          policy_operational_issue_current: string | number;
        }>(
          `
            SELECT
              (SELECT count(*) FROM outbox_events WHERE dispatch_status <> 'dispatched') AS outbox_backlog,
              (SELECT count(*) FROM outbox_events WHERE dispatch_status = 'failed') AS outbox_failed,
              (SELECT count(*) FROM cache_invalidation_requests WHERE status IN ('pending', 'processing')) AS cache_invalidation_backlog,
              (SELECT count(*) FROM cache_invalidation_requests WHERE status = 'failed') AS cache_invalidation_failed,
              (
                SELECT count(*) FROM memory_records
                WHERE created_at >= now() - interval '15 minutes'
                  AND metadata->>'mem0_official_attempted' = 'true'
                  AND metadata->>'mem0_official_success' <> 'true'
              ) AS mem0_official_fallback_recent,
              (
                SELECT count(*) FROM memory_records
                WHERE lifecycle_status = 'approved'
                  AND is_current IS TRUE
                  AND created_at <= now() - interval '2 minutes'
                  AND created_at >= now() - interval '1 hour'
                  AND NOT EXISTS (
                    SELECT 1 FROM outbox_events o
                    WHERE o.aggregate_id = memory_records.id
                      AND o.event_type IN ('memory.created', 'memory.updated', 'memory.superseded')
                      AND o.dispatch_status = 'dispatched'
                  )
              ) AS approved_without_projection_recent,
              (
                SELECT count(*) FROM memory_records
                WHERE lifecycle_status = 'approved'
                  AND is_current IS TRUE
              ) AS postgres_effective_recallable_count,
              (SELECT count(*) FROM memory_embedding_generations WHERE status = 'active') AS active_manifest_count,
              (SELECT generation_id FROM memory_embedding_generations WHERE status = 'active' ORDER BY activated_at DESC NULLS LAST, updated_at DESC LIMIT 1) AS active_manifest_generation_id,
              (SELECT record_count FROM memory_embedding_generations WHERE status = 'active' ORDER BY activated_at DESC NULLS LAST, updated_at DESC LIMIT 1) AS active_manifest_record_count,
              (SELECT point_count FROM memory_embedding_generations WHERE status = 'active' ORDER BY activated_at DESC NULLS LAST, updated_at DESC LIMIT 1) AS active_manifest_point_count,
              (SELECT dims FROM memory_embedding_generations WHERE status = 'active' ORDER BY activated_at DESC NULLS LAST, updated_at DESC LIMIT 1) AS active_manifest_dims,
              (SELECT payload_sample_verified FROM memory_embedding_generations WHERE status = 'active' ORDER BY activated_at DESC NULLS LAST, updated_at DESC LIMIT 1) AS active_manifest_payload_sample_verified,
              (
                SELECT count(*) FROM auto_approval_decisions
                WHERE created_at >= now() - interval '24 hours'
                  AND metadata->>'policy_action' = 'reject_by_policy'
              ) AS policy_reject_by_policy_recent,
              (
                SELECT count(*) FROM memory_records
                WHERE is_current IS TRUE
                  AND metadata->>'policy_action' = 'quarantine_candidate'
              ) AS policy_quarantine_current,
              (
                SELECT count(*) FROM memory_records
                WHERE is_current IS TRUE
                  AND metadata->>'recall_policy' = 'test_only'
              ) AS policy_test_only_current,
              (
                SELECT count(*) FROM memory_records
                WHERE is_current IS TRUE
                  AND metadata->>'recall_policy' = 'audit_only'
              ) AS policy_audit_only_current,
              (
                SELECT count(*) FROM memory_records
                WHERE is_current IS TRUE
                  AND metadata->>'memory_class' = 'operational_issue'
              ) AS policy_operational_issue_current
          `
        );
        metrics.outbox_backlog = Number(row?.outbox_backlog ?? 0);
        metrics.outbox_failed = Number(row?.outbox_failed ?? 0);
        metrics.cache_invalidation_backlog = Number(row?.cache_invalidation_backlog ?? 0);
        metrics.cache_invalidation_failed = Number(row?.cache_invalidation_failed ?? 0);
        metrics.mem0_official_fallback_recent = Number(row?.mem0_official_fallback_recent ?? 0);
        metrics.approved_without_projection_recent = Number(row?.approved_without_projection_recent ?? 0);
        metrics.postgres_effective_recallable_count = Number(row?.postgres_effective_recallable_count ?? 0);
        metrics.active_manifest_count = Number(row?.active_manifest_count ?? 0);
        metrics.active_manifest_generation_id = row?.active_manifest_generation_id ?? null;
        metrics.active_manifest_record_count = row?.active_manifest_record_count == null ? null : Number(row.active_manifest_record_count);
        metrics.active_manifest_point_count = row?.active_manifest_point_count == null ? null : Number(row.active_manifest_point_count);
        metrics.active_manifest_dims = row?.active_manifest_dims == null ? null : Number(row.active_manifest_dims);
        metrics.active_manifest_payload_sample_verified = row?.active_manifest_payload_sample_verified === true || row?.active_manifest_payload_sample_verified === "true";
        metrics.policy_reject_by_policy_recent = Number(row?.policy_reject_by_policy_recent ?? 0);
        metrics.policy_quarantine_current = Number(row?.policy_quarantine_current ?? 0);
        metrics.policy_test_only_current = Number(row?.policy_test_only_current ?? 0);
        metrics.policy_audit_only_current = Number(row?.policy_audit_only_current ?? 0);
        metrics.policy_operational_issue_current = Number(row?.policy_operational_issue_current ?? 0);
      } else if (isInMemoryTransactionContext(tx)) {
        metrics.outbox_backlog = tx.state.outboxEvents.filter((row) => row.dispatchStatus !== "dispatched").length;
        metrics.outbox_failed = tx.state.outboxEvents.filter((row) => row.dispatchStatus === "failed").length;
        metrics.cache_invalidation_backlog = 0;
        metrics.cache_invalidation_failed = 0;
        metrics.mem0_official_fallback_recent = 0;
        metrics.approved_without_projection_recent = 0;
        metrics.postgres_effective_recallable_count = tx.state.memoryRecords.filter((row) => row.lifecycleStatus === "approved" && row.isCurrent).length;
        metrics.active_manifest_count = 1;
        metrics.active_manifest_payload_sample_verified = true;
        metrics.policy_reject_by_policy_recent = 0;
        metrics.policy_quarantine_current = tx.state.memoryRecords.filter((row) => row.isCurrent && row.metadata.policy_action === "quarantine_candidate").length;
        metrics.policy_test_only_current = tx.state.memoryRecords.filter((row) => row.isCurrent && row.metadata.recall_policy === "test_only").length;
        metrics.policy_audit_only_current = tx.state.memoryRecords.filter((row) => row.isCurrent && row.metadata.recall_policy === "audit_only").length;
        metrics.policy_operational_issue_current = tx.state.memoryRecords.filter((row) => row.isCurrent && row.metadata.memory_class === "operational_issue").length;
      }
    });
  } catch (error) {
    warnings.push(`health_snapshot_error:${error instanceof Error ? error.message : String(error)}`);
  }

  const qdrantTimeoutMs = readIntEnv("MEMORY_V2_AUTO_APPROVAL_QDRANT_COUNT_TIMEOUT_MS", 300);
  const qdrantPointCount = await fetchQdrantPointCount(qdrantTimeoutMs).catch((error) => {
    warnings.push(`qdrant_count_unavailable:${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (qdrantPointCount !== null) metrics.qdrant_point_count = qdrantPointCount;

  const projectorStaleAfterMs = readRuntimeInt("health.projector_stale_after_ms", "MEMORY_V2_AUTO_APPROVAL_PROJECTOR_STALE_AFTER_MS", 3 * 60 * 1000);
  const projectorStatus = await readProjectorStatus(projectorStaleAfterMs);
  metrics.projector_heartbeat_age_seconds = projectorStatus.age_seconds;
  if (projectorStatus.error) warnings.push(`projector_heartbeat_unavailable:${projectorStatus.error}`);
  if (projectorStatus.stale) blockers.push("projector_heartbeat_stale");

  const outboxFailed = Number(metrics.outbox_failed ?? 0);
  const outboxBacklog = Number(metrics.outbox_backlog ?? 0);
  const cacheFailed = Number(metrics.cache_invalidation_failed ?? 0);
  const cacheBacklog = Number(metrics.cache_invalidation_backlog ?? 0);
  const mem0FallbackRecent = Number(metrics.mem0_official_fallback_recent ?? 0);
  const approvedWithoutProjection = Number(metrics.approved_without_projection_recent ?? 0);
  const postgresEffectiveRecallableCount = Number(metrics.postgres_effective_recallable_count ?? 0);
  const activeManifestCount = Number(metrics.active_manifest_count ?? 0);
  const activeManifestRecordCount = typeof metrics.active_manifest_record_count === "number" ? metrics.active_manifest_record_count : null;
  const activeManifestPointCount = typeof metrics.active_manifest_point_count === "number" ? metrics.active_manifest_point_count : null;
  const activeManifestPayloadVerified = metrics.active_manifest_payload_sample_verified === true;
  const qdrantPgProjectionDiff = qdrantPointCount === null ? null : Math.abs(qdrantPointCount - postgresEffectiveRecallableCount);
  if (qdrantPgProjectionDiff !== null) metrics.qdrant_pg_projection_count_diff = qdrantPgProjectionDiff;
  if (
    qdrantPointCount !== null &&
    activeManifestRecordCount !== null &&
    activeManifestPointCount !== null &&
    qdrantPointCount === postgresEffectiveRecallableCount &&
    (activeManifestRecordCount !== postgresEffectiveRecallableCount || activeManifestPointCount !== qdrantPointCount)
  ) {
    metrics.embedding_manifest_count_stale = true;
    warnings.push("embedding_manifest_count_stale");
  }
  const outboxBlockerThreshold = readRuntimeInt("health.outbox_blocker_threshold", "MEMORY_V2_AUTO_APPROVAL_OUTBOX_BLOCKER_THRESHOLD", 100);
  const cacheBlockerThreshold = readRuntimeInt("health.cache_invalidation_blocker_threshold", "MEMORY_V2_AUTO_APPROVAL_CACHE_INVALIDATION_BLOCKER_THRESHOLD", 100);
  const mem0FallbackBlockerThreshold = readIntEnv("MEMORY_V2_AUTO_APPROVAL_MEM0_FALLBACK_BLOCKER_THRESHOLD", 5);
  const projectionBlockerThreshold = readIntEnv("MEMORY_V2_AUTO_APPROVAL_PROJECTION_BLOCKER_THRESHOLD", 10);
  const projectionDiffBlockerThreshold = readRuntimeInt("health.qdrant_pg_diff_blocker_threshold", "MEMORY_V2_AUTO_APPROVAL_QDRANT_PG_DIFF_BLOCKER_THRESHOLD", 0);

  if (outboxFailed > 0) blockers.push("outbox_failed_events");
  if (cacheFailed > 0) blockers.push("cache_invalidation_failed_requests");
  if (outboxBacklog > outboxBlockerThreshold) blockers.push("outbox_backlog_high");
  else if (outboxBacklog > 0) warnings.push("outbox_backlog_present");
  if (cacheBacklog > cacheBlockerThreshold) blockers.push("cache_invalidation_backlog_high");
  else if (cacheBacklog > 0) warnings.push("cache_invalidation_backlog_present");
  if (mem0FallbackRecent > mem0FallbackBlockerThreshold) blockers.push("mem0_official_fallback_high");
  else if (mem0FallbackRecent > 0) warnings.push("mem0_official_fallback_present");
  if (approvedWithoutProjection > projectionBlockerThreshold) blockers.push("projector_projection_backlog_high");
  else if (approvedWithoutProjection > 0) warnings.push("projector_projection_backlog_present");
  if (activeManifestCount === 0) blockers.push("embedding_manifest_missing");
  if (activeManifestCount > 1) blockers.push("embedding_manifest_multiple_active");
  if (activeManifestCount === 1 && !activeManifestPayloadVerified) blockers.push("embedding_manifest_payload_unverified");
  if (qdrantPgProjectionDiff !== null && qdrantPgProjectionDiff > projectionDiffBlockerThreshold) {
    blockers.push("qdrant_pg_projection_count_mismatch");
  }

  return {
    id: randomUUID(),
    checked_at: checkedAt,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    metrics,
  };
}
