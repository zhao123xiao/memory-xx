import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { config } from "./test-harness/config.js";
import { createPool, query, closePool } from "./test-harness/lib/db-helpers.js";
import { requireCliPermission } from "../app/server/permissions.js";
import { scoreTestPollution } from "../app/governance/service.js";
import { PostgresWriteDatabase } from "../app/db/adapters/postgres-write-database.js";
import {
  ArchiveMemoryService,
  GovernanceRepository,
  MemoryEventRepository,
  OutboxEventRepository,
  OutboxEventType,
  TombstoneMemoryService,
  loadMemoryV2PostgresConfig,
  withWriteTransaction,
  type JsonObject
} from "../app/index.js";

interface Args {
  readonly limit: number;
  readonly dryRun: boolean;
  readonly apply: boolean;
  readonly json: boolean;
  readonly policy: "report-only" | "high-confidence-only";
}

function parseArgs(): Args {
  const limitArg = process.argv.find((item) => item.startsWith("--limit="));
  const policyArg = process.argv.find((item) => item.startsWith("--policy="));
  const limitValue = limitArg ? Number(limitArg.split("=")[1]) : 50;
  const policy = policyArg?.split("=")[1] === "high-confidence-only"
    ? "high-confidence-only"
    : "report-only";
  const apply = process.argv.includes("--apply");
  const dryRun = process.argv.includes("--dry-run") || !apply;
  return {
    limit: Number.isFinite(limitValue) && limitValue > 0 ? Math.min(Math.floor(limitValue), 500) : 50,
    dryRun,
    apply,
    json: process.argv.includes("--json"),
    policy
  };
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe identifier: ${value}`);
  }
  return `"${value}"`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const GOVERNANCE_LEASE_TTL_SECONDS = 10 * 60;
const GOVERNANCE_HEARTBEAT_INTERVAL_MS = 60 * 1000;

function createGovernanceWorkerId(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}

function governanceLeaseMetrics(workerId: string): JsonObject {
  return {
    lease_acquired_by: workerId,
    lease_ttl_seconds: GOVERNANCE_LEASE_TTL_SECONDS,
    heartbeat_interval_seconds: GOVERNANCE_HEARTBEAT_INTERVAL_MS / 1000,
  };
}

function withGovernanceLeaseMetrics(metrics: JsonObject, workerId: string): JsonObject {
  return {
    ...metrics,
    ...governanceLeaseMetrics(workerId),
  };
}

function startGovernanceLeaseHeartbeat(
  database: PostgresWriteDatabase,
  governanceRepo: GovernanceRepository,
  runId: string,
  workerId: string
): () => Promise<void> {
  let stopped = false;
  let heartbeatInFlight = false;
  let heartbeatPromise: Promise<void> | null = null;
  const heartbeat = async (): Promise<void> => {
    if (stopped || heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      const refreshed = await withWriteTransaction(database, (tx) =>
        governanceRepo.heartbeatRunLease(tx, runId, workerId, GOVERNANCE_LEASE_TTL_SECONDS)
      );
      if (!refreshed) {
        console.error(JSON.stringify({
          level: "warn",
          event: "governance_lease_heartbeat_lost",
          governance_run_id: runId,
          lease_acquired_by: workerId,
          checked_at: new Date().toISOString(),
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: "warn",
        event: "governance_lease_heartbeat_failed",
        governance_run_id: runId,
        lease_acquired_by: workerId,
        error: error instanceof Error ? error.message : String(error),
        checked_at: new Date().toISOString(),
      }));
    } finally {
      heartbeatInFlight = false;
    }
  };
  const timer = setInterval(() => {
    heartbeatPromise = heartbeat();
    void heartbeatPromise;
  }, GOVERNANCE_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await heartbeatPromise?.catch(() => undefined);
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  await requireCliPermission(args.apply ? "memory:governance_apply" : "memory:governance_read");
  const schema = quoteIdent(config.dbSchema);
  const pool = createPool();
  const client = await pool.connect();
  const database = new PostgresWriteDatabase({ config: loadMemoryV2PostgresConfig(process.env) });
  const governanceRepo = new GovernanceRepository();
  const workerId = createGovernanceWorkerId();
  let governanceRunId: string | null = null;
  let stopHeartbeat: (() => Promise<void>) | null = null;

  try {
    const run = await withWriteTransaction(database, (tx) => governanceRepo.tryBeginRun(tx, {
      jobType: "memory_governance",
      mode: args.apply ? "apply" : "report-only",
      policy: args.policy,
      leaseAcquiredBy: workerId,
      leaseTtlSeconds: GOVERNANCE_LEASE_TTL_SECONDS,
      metrics: governanceLeaseMetrics(workerId),
    }));
    if (run.status === "skipped_lock_held") {
      const result = {
        ok: false,
        checked_at: new Date().toISOString(),
        schema: config.dbSchema,
        mode: { dry_run: args.dryRun, apply: args.apply, policy: args.policy },
        governance_run: run,
        error: "governance lock already held",
      };
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    governanceRunId = run.id;
    stopHeartbeat = startGovernanceLeaseHeartbeat(database, governanceRepo, run.id, workerId);

    const lifecycle = await query(pool,
      `SELECT lifecycle_status, review_state, is_current, count(*)::int AS cnt
       FROM ${schema}.memory_records
       GROUP BY 1, 2, 3
       ORDER BY cnt DESC`,
    );

    const pending = await query(pool,
      `SELECT
         id,
         scope_type,
         scope_id,
         title,
         left(content, 160) AS content_preview,
         COALESCE(metadata->>'source', 'unknown') AS source,
         COALESCE(metadata->>'memory_type', memory_type, 'unknown') AS memory_type,
         COALESCE(metadata->>'agent_id', agent_id, created_by, 'unknown') AS agent_id,
         created_at,
         round((EXTRACT(EPOCH FROM (now() - created_at)) / 86400)::numeric, 2) AS age_days
       FROM ${schema}.memory_records
       WHERE is_current IS TRUE AND lifecycle_status = 'candidate'
       ORDER BY created_at ASC
       LIMIT $1`,
      [args.limit],
    );

    const groups = await query(pool,
      `SELECT
         scope_type,
         scope_id,
         COALESCE(metadata->>'source', source_ref, source_kind, 'unknown') AS source,
         COALESCE(metadata->>'agent_id', agent_id, created_by, 'unknown') AS agent_id,
         lifecycle_status,
         review_state,
         CASE
           WHEN created_at >= now() - interval '1 day' THEN 'lt_1d'
           WHEN created_at >= now() - interval '7 days' THEN '1_7d'
           WHEN created_at >= now() - interval '30 days' THEN '7_30d'
           ELSE 'gt_30d'
         END AS age_bucket,
         count(*)::int AS cnt
       FROM ${schema}.memory_records
       GROUP BY 1,2,3,4,5,6,7
       ORDER BY cnt DESC, scope_type ASC, scope_id ASC
       LIMIT $1`,
      [args.limit],
    );

    const dedupeDuplicates = await query(pool,
      `SELECT
         scope_type,
         scope_id,
         COALESCE(memory_type, 'unknown') AS memory_type,
         dedupe_key,
         count(*)::int AS cnt,
         array_agg(id ORDER BY updated_at DESC) AS memory_ids
       FROM ${schema}.memory_records
       WHERE is_current IS TRUE
         AND lifecycle_status = 'approved'
         AND dedupe_key IS NOT NULL
       GROUP BY 1, 2, 3, 4
       HAVING count(*) > 1
       ORDER BY cnt DESC
       LIMIT $1`,
      [args.limit],
    );

    const exactDuplicates = await query(pool,
      `WITH active AS (
         SELECT
           id,
           scope_type,
           scope_id,
           COALESCE(memory_type, 'unknown') AS memory_type,
           regexp_replace(lower(trim(content)), '\\s+', ' ', 'g') AS normalized_content,
           title,
           updated_at,
           source_kind,
           source_ref,
           metadata,
           memory_strength,
           episode_id
         FROM ${schema}.memory_records
         WHERE is_current IS TRUE
           AND lifecycle_status = 'approved'
           AND review_state IN ('approved', 'not_required')
       ),
       clusters AS (
         SELECT scope_type, scope_id, memory_type, normalized_content, count(*)::int AS cnt
         FROM active
         GROUP BY 1,2,3,4
         HAVING count(*) > 1
       )
       SELECT
         c.scope_type,
         c.scope_id,
         c.memory_type,
         left(c.normalized_content, 180) AS content_preview,
         c.cnt,
         array_agg(a.id ORDER BY
           CASE WHEN lower(COALESCE(a.source_kind, '') || ' ' || COALESCE(a.source_ref, '') || ' ' || COALESCE(a.metadata->>'source', '')) ~ '(legacy|local-wsl-legacy)' THEN 1 ELSE 0 END ASC,
           CASE WHEN a.episode_id IS NULL THEN 1 ELSE 0 END ASC,
           a.memory_strength DESC NULLS LAST,
           a.updated_at DESC
         ) AS ranked_memory_ids
       FROM clusters c
       JOIN active a
         ON a.scope_type = c.scope_type
        AND a.scope_id = c.scope_id
        AND a.memory_type = c.memory_type
        AND a.normalized_content = c.normalized_content
       GROUP BY 1,2,3,4,5
       ORDER BY c.cnt DESC, c.scope_type ASC, c.scope_id ASC
       LIMIT $1`,
      [args.limit],
    );

    const nearDuplicates = await query(pool,
      `WITH active AS (
         SELECT
           id,
           scope_type,
           scope_id,
           COALESCE(memory_type, 'unknown') AS memory_type,
           left(regexp_replace(lower(trim(content)), '\\s+', ' ', 'g'), 120) AS normalized_prefix,
           updated_at
         FROM ${schema}.memory_records
         WHERE is_current IS TRUE
           AND lifecycle_status = 'approved'
       )
       SELECT scope_type, scope_id, memory_type, normalized_prefix, count(*)::int AS cnt,
              array_agg(id ORDER BY updated_at DESC) AS memory_ids
       FROM active
       WHERE length(normalized_prefix) >= 40
       GROUP BY 1,2,3,4
       HAVING count(*) > 1
       ORDER BY cnt DESC
       LIMIT $1`,
      [args.limit],
    );

    const testLikeRows = await query(pool,
      `SELECT
         id,
         scope_type,
         scope_id,
         title,
         content,
         left(content, 180) AS content_preview,
         lifecycle_status,
         review_state,
         is_current,
         source_kind,
         source_ref,
         created_by,
         created_at::text,
         COALESCE(metadata, '{}'::jsonb) AS metadata,
         COALESCE(metadata->>'source', source_ref, source_kind, 'unknown') AS source
       FROM ${schema}.memory_records
       WHERE is_current IS TRUE
         AND lifecycle_status IN ('approved', 'candidate')
         AND (COALESCE(title, '') || ' ' || content || ' ' || scope_id || ' ' || COALESCE(metadata->>'source', source_ref, source_kind, '')) ~* '(test|测试|benchmark|smoke|load|mcp-user-flow)'
       ORDER BY updated_at DESC, id ASC
       LIMIT $1`,
      [Math.max(args.limit * 10, args.limit)],
    );
    const testLike = testLikeRows.rows
      .map((row: any) => {
        const pollution = scoreTestPollution({
          scopeId: row.scope_id,
          source: row.source,
          agentId: row.created_by,
          title: row.title,
          content: row.content,
          createdAt: row.created_at,
          metadata: row.metadata,
        });
        const { content, ...safeRow } = row;
        return {
          ...safeRow,
          test_score: pollution.score,
          test_reasons: pollution.reasons,
          auto_tombstone_allowed: pollution.autoTombstoneAllowed,
        };
      })
      .sort((left: any, right: any) => Number(right.test_score) - Number(left.test_score) || String(left.id).localeCompare(String(right.id)))
      .slice(0, args.limit);

    const missingProvenance = await query(pool,
      `SELECT
         count(*)::int AS active_approved_current,
         count(*) FILTER (WHERE source_kind IS NULL OR source_kind = '')::int AS missing_source_kind,
         count(*) FILTER (WHERE source_ref IS NULL OR source_ref = '')::int AS missing_source_ref,
         count(*) FILTER (WHERE metadata->>'source' IS NULL OR metadata->>'source' = '')::int AS missing_metadata_source,
         count(*) FILTER (WHERE dedupe_key IS NULL OR dedupe_key = '')::int AS missing_dedupe_key,
         count(*) FILTER (WHERE signature_hash IS NULL OR signature_hash = '')::int AS missing_signature_hash,
         count(*) FILTER (WHERE valid_at IS NULL)::int AS missing_valid_at,
         count(*) FILTER (WHERE observed_at IS NULL)::int AS missing_observed_at
       FROM ${schema}.memory_records
       WHERE is_current IS TRUE
         AND lifecycle_status = 'approved'
         AND review_state IN ('approved', 'not_required')`,
    );

    const lowStrength = await query(pool,
      `SELECT
         id,
         scope_type,
         scope_id,
         memory_type,
         title,
         round(memory_strength::numeric, 3) AS memory_strength,
         usage_count,
         last_accessed_at,
         updated_at
       FROM ${schema}.memory_records
       WHERE is_current IS TRUE
         AND lifecycle_status = 'approved'
         AND memory_strength < 0.30
       ORDER BY memory_strength ASC, updated_at ASC
       LIMIT $1`,
      [args.limit],
    );

    const graphOrphans = await query(pool,
      `SELECT
         count(*)::int AS active_approved_current,
         count(*) FILTER (WHERE episode_id IS NULL)::int AS missing_episode,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ${schema}.memory_entity_links mel WHERE mel.memory_id = mr.id))::int AS missing_entity_link,
         count(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM ${schema}.memory_relations rel
           WHERE rel.memory_id = mr.id OR rel.related_memory_id = mr.id
         ))::int AS missing_relation
       FROM ${schema}.memory_records mr
       WHERE mr.is_current IS TRUE
         AND mr.lifecycle_status = 'approved'
         AND mr.review_state IN ('approved', 'not_required')`,
    );

    const legacyImport = await query(pool,
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE is_current IS TRUE AND lifecycle_status = 'approved')::int AS active_approved_current,
         count(*) FILTER (WHERE dedupe_key IS NULL OR signature_hash IS NULL OR valid_at IS NULL OR observed_at IS NULL)::int AS missing_normalized_fields
       FROM ${schema}.memory_records
       WHERE legacy_memory_id IS NOT NULL
          OR lower(COALESCE(metadata->>'source', source_ref, source_kind, '')) ~ '(legacy|local-wsl-legacy)'`,
    );

    const temporal = await query(pool,
      `SELECT
         count(*)::int AS records,
         count(*) FILTER (WHERE memory_strength IS DISTINCT FROM 1.0)::int AS non_default_strength,
         count(*) FILTER (WHERE memory_layer <> 'recall')::int AS non_recall_layer,
         count(*) FILTER (WHERE episode_id IS NOT NULL)::int AS records_with_episode,
         count(*) FILTER (WHERE usage_count > 0)::int AS records_with_usage,
         count(*) FILTER (WHERE last_accessed_at IS NOT NULL)::int AS records_with_last_access,
         count(*) FILTER (WHERE expires_at IS NOT NULL)::int AS records_with_expiry,
         (SELECT count(*)::int FROM ${schema}.memory_episodes) AS episodes,
         (SELECT count(*)::int FROM ${schema}.memory_entities) AS entities,
         (SELECT count(*)::int FROM ${schema}.memory_entity_links) AS entity_links,
         (SELECT count(*)::int FROM ${schema}.memory_relations) AS relations
       FROM ${schema}.memory_records`,
    );

    let applyResult: Record<string, unknown> = {
      applied: false,
      dry_run: args.dryRun,
      policy: args.policy,
    };

    if (args.apply) {
      if (args.policy !== "high-confidence-only") {
        throw new Error("--apply requires --policy=high-confidence-only");
      }

      await client.query("BEGIN");
      try {
        const duplicateArchiveTargets = await client.query<{ id: string; scope_type: string; scope_id: string; lifecycle_status: string; review_state: string; is_current: boolean }>(`
          WITH active AS (
            SELECT
              id,
              scope_type,
              scope_id,
              COALESCE(memory_type, 'unknown') AS memory_type,
              regexp_replace(lower(trim(content)), '\\s+', ' ', 'g') AS normalized_content,
              source_kind,
              source_ref,
              metadata,
              memory_strength,
              episode_id,
              updated_at,
              row_number() OVER (
                PARTITION BY scope_type, scope_id, COALESCE(memory_type, 'unknown'), regexp_replace(lower(trim(content)), '\\s+', ' ', 'g')
                ORDER BY
                  CASE WHEN lower(COALESCE(source_kind, '') || ' ' || COALESCE(source_ref, '') || ' ' || COALESCE(metadata->>'source', '')) ~ '(legacy|local-wsl-legacy)' THEN 1 ELSE 0 END ASC,
                  CASE WHEN episode_id IS NULL THEN 1 ELSE 0 END ASC,
                  memory_strength DESC NULLS LAST,
                  updated_at DESC,
                  id ASC
              ) AS rn,
              count(*) OVER (
                PARTITION BY scope_type, scope_id, COALESCE(memory_type, 'unknown'), regexp_replace(lower(trim(content)), '\\s+', ' ', 'g')
              ) AS cluster_size
            FROM ${schema}.memory_records
            WHERE is_current IS TRUE
              AND lifecycle_status = 'approved'
              AND review_state IN ('approved', 'not_required')
          ),
          losers AS (
            SELECT id FROM active WHERE cluster_size > 1 AND rn > 1
          )
          SELECT mr.id, mr.scope_type, mr.scope_id, mr.lifecycle_status, mr.review_state, mr.is_current
          FROM ${schema}.memory_records mr
          JOIN losers ON losers.id = mr.id
          LIMIT $1
        `, [args.limit]);

        const testPollutionRows = await client.query<{
          id: string;
          scope_type: string;
          scope_id: string;
          lifecycle_status: string;
          review_state: string;
          is_current: boolean;
          title: string | null;
          content: string | null;
          source_kind: string | null;
          source_ref: string | null;
          created_by: string | null;
          created_at: string;
          metadata: JsonObject;
        }>(`
          SELECT id, scope_type, scope_id, lifecycle_status, review_state, is_current,
                 title, content, source_kind, source_ref, created_by, created_at::text, metadata
          FROM ${schema}.memory_records
          WHERE is_current IS TRUE
            AND lifecycle_status IN ('approved', 'candidate')
          ORDER BY updated_at DESC, id ASC
          LIMIT $1
        `, [Math.max(args.limit * 20, args.limit)]);
        const testTombstoneTargets = testPollutionRows.rows
          .map((row) => {
            const pollution = scoreTestPollution({
              scopeId: row.scope_id,
              source: row.metadata?.source ? String(row.metadata.source) : row.source_ref ?? row.source_kind,
              agentId: row.created_by,
              title: row.title,
              content: row.content,
              createdAt: row.created_at,
              metadata: row.metadata,
            });
            return { ...row, test_score: pollution.score, test_reasons: pollution.reasons, auto_tombstone_allowed: pollution.autoTombstoneAllowed };
          })
          .filter((row) => row.auto_tombstone_allowed)
          .sort((left, right) => right.test_score - left.test_score || left.id.localeCompare(right.id))
          .slice(0, args.limit);

        await client.query("COMMIT");

        const archiveService = new ArchiveMemoryService({ database });
        const tombstoneService = new TombstoneMemoryService({ database });
        const archivedIds: string[] = [];
        const tombstonedIds: string[] = [];
        const revertTokens: Array<{ action: string; memory_id: string; token: string; expires_at: string }> = [];

        for (const target of duplicateArchiveTargets.rows) {
          const frozen = await withWriteTransaction(database, (tx) =>
            governanceRepo.isScopeFrozen(tx, target.scope_type, target.scope_id, "auto_lifecycle")
          );
          if (frozen) {
            await withWriteTransaction(database, (tx) => governanceRepo.recordAction(tx, {
              runId: run.id,
              actionType: "archive_exact_duplicate",
              scopeType: target.scope_type,
              scopeId: target.scope_id,
              memoryId: target.id,
              evidence: { reason: "exact_duplicate_loser" },
              beforeState: target as unknown as JsonObject,
              status: "skipped",
            }));
            continue;
          }
          const result = await archiveService.execute({
            requestId: `governance:archive:${target.id}:${Date.now()}`,
            actorId: "memory-governance",
            memoryId: target.id,
          });
          archivedIds.push(target.id);
          const revertToken = randomUUID();
          const revertExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          revertTokens.push({ action: "archive_exact_duplicate", memory_id: target.id, token: revertToken, expires_at: revertExpiresAt });
          await withWriteTransaction(database, (tx) => governanceRepo.recordAction(tx, {
            runId: run.id,
            actionType: "archive_exact_duplicate",
            scopeType: target.scope_type,
            scopeId: target.scope_id,
            memoryId: target.id,
            evidence: { reason: "exact_duplicate_loser" },
            beforeState: target as unknown as JsonObject,
            afterState: { lifecycle_status: result.lifecycleStatus, review_state: result.reviewState, is_current: result.isCurrent },
            outboxEventIds: [result.outboxEventId],
            revertTokenHash: sha256(revertToken),
            revertExpiresAt,
            status: "applied",
          }));
        }

        for (const target of testTombstoneTargets) {
          const frozen = await withWriteTransaction(database, (tx) =>
            governanceRepo.isScopeFrozen(tx, target.scope_type, target.scope_id, "auto_lifecycle")
          );
          if (frozen) {
            await withWriteTransaction(database, (tx) => governanceRepo.recordAction(tx, {
              runId: run.id,
              actionType: "tombstone_high_confidence_test_pollution",
              scopeType: target.scope_type,
              scopeId: target.scope_id,
              memoryId: target.id,
              evidence: { test_score: Number(target.test_score), reasons: target.test_reasons, reason: "scoreTestPollution auto tombstone evidence" },
              beforeState: target as unknown as JsonObject,
              status: "skipped",
            }));
            continue;
          }
          const result = await tombstoneService.execute({
            requestId: `governance:tombstone:${target.id}:${Date.now()}`,
            actorId: "memory-governance",
            memoryId: target.id,
          });
          tombstonedIds.push(target.id);
          const revertToken = randomUUID();
          const revertExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          revertTokens.push({ action: "tombstone_high_confidence_test_pollution", memory_id: target.id, token: revertToken, expires_at: revertExpiresAt });
          await withWriteTransaction(database, (tx) => governanceRepo.recordAction(tx, {
            runId: run.id,
            actionType: "tombstone_high_confidence_test_pollution",
            scopeType: target.scope_type,
            scopeId: target.scope_id,
            memoryId: target.id,
            evidence: { test_score: Number(target.test_score), reasons: target.test_reasons, reason: "score >= 2" },
            beforeState: target as unknown as JsonObject,
            afterState: { lifecycle_status: result.lifecycleStatus, review_state: result.reviewState, is_current: result.isCurrent },
            outboxEventIds: [result.outboxEventId],
            revertTokenHash: sha256(revertToken),
            revertExpiresAt,
            status: "applied",
          }));
        }

        const provenanceBackfilled = await withWriteTransaction(database, async (tx) => {
          const rows = await tx.query<{ id: string; request_id: string; scope_type: string; scope_id: string }>(`
          UPDATE ${schema}.memory_records
          SET source_kind = COALESCE(NULLIF(source_kind, ''), CASE
                WHEN legacy_memory_id IS NOT NULL OR lower(COALESCE(metadata->>'source', source_ref, '')) ~ '(legacy|local-wsl-legacy)' THEN 'import'
                WHEN created_by IS NOT NULL AND created_by <> '' THEN 'agent'
                ELSE 'unknown'
              END),
              source_ref = COALESCE(NULLIF(source_ref, ''), NULLIF(metadata->>'source', ''), legacy_memory_id::text, created_by, 'unknown'),
              valid_at = COALESCE(valid_at, created_at),
              observed_at = COALESCE(observed_at, created_at),
              dedupe_key = COALESCE(NULLIF(dedupe_key, ''), md5(scope_type || ':' || scope_id || ':' || COALESCE(memory_type, 'unknown') || ':' || regexp_replace(lower(trim(content)), '\\s+', ' ', 'g'))),
              signature_hash = COALESCE(NULLIF(signature_hash, ''), md5(regexp_replace(lower(trim(content)), '\\s+', ' ', 'g'))),
              metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'governance_backfill', jsonb_build_object(
                  'applied_at', now(),
                  'source', 'memory:governance',
                  'policy', 'high-confidence-only'
                )
              ),
              updated_at = now(),
              updated_by = 'memory-governance'
          WHERE is_current IS TRUE
            AND lifecycle_status = 'approved'
            AND review_state IN ('approved', 'not_required')
            AND (
              source_kind IS NULL OR source_kind = ''
              OR source_ref IS NULL OR source_ref = ''
              OR valid_at IS NULL
              OR observed_at IS NULL
              OR dedupe_key IS NULL OR dedupe_key = ''
              OR signature_hash IS NULL OR signature_hash = ''
            )
          RETURNING
            id,
            COALESCE(NULLIF(request_id, ''), 'governance:provenance-backfill:' || id) AS request_id,
            scope_type,
            scope_id
        `);
          const eventRepo = new MemoryEventRepository();
          const outboxRepo = new OutboxEventRepository();
          for (const row of rows) {
            const payload = {
              memoryId: row.id,
              requestId: row.request_id,
              scopeType: row.scope_type,
              scopeId: row.scope_id,
              governance_action: "provenance_backfill",
            } as const;
            const memoryEvent = await eventRepo.append(tx, {
              memoryId: row.id,
              requestId: row.request_id,
              eventType: OutboxEventType.MemoryUpdated,
              actorId: "memory-governance",
              payload,
            });
            const outboxEvent = await outboxRepo.append(tx, {
              aggregateId: row.id,
              requestId: row.request_id,
              eventType: OutboxEventType.MemoryUpdated,
              payload,
            });
            await governanceRepo.recordAction(tx, {
              runId: run.id,
              actionType: "provenance_backfill",
              scopeType: row.scope_type,
              scopeId: row.scope_id,
              memoryId: row.id,
              evidence: { reason: "missing provenance or normalized field" },
              afterState: { memory_event_id: memoryEvent.id },
              outboxEventIds: [outboxEvent.id],
              status: "applied",
            });
          }
          return rows.length;
        });

        await withWriteTransaction(database, (tx) => governanceRepo.finishRun(tx, run.id, "success", withGovernanceLeaseMetrics({
          archived_exact_duplicates: archivedIds.length,
          tombstoned_test_pollution: tombstonedIds.length,
          provenance_backfilled: provenanceBackfilled,
        }, workerId)));
        applyResult = {
          applied: true,
          dry_run: false,
          policy: args.policy,
          archived_exact_duplicates: archivedIds.length,
          tombstoned_test_pollution: tombstonedIds.length,
          provenance_backfilled: provenanceBackfilled,
          outbox_triggered: true,
          revert_tokens: revertTokens,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        await withWriteTransaction(database, (tx) =>
          governanceRepo.finishRun(
            tx,
            run.id,
            "failed",
            withGovernanceLeaseMetrics({}, workerId),
            error instanceof Error ? error.message : String(error)
          )
        ).catch(() => undefined);
        throw error;
      }
    }

    const result = {
      ok: true,
      checked_at: new Date().toISOString(),
      schema: config.dbSchema,
      env_path: process.env.MEMORY_V2_ENV_PATH ?? "auto",
      policy: "Postgres memory_xx is the source of truth; Qdrant is projection only; governance never physically deletes production memory.",
      mode: {
        dry_run: args.dryRun,
        apply: args.apply,
        policy: args.policy,
      },
      lifecycle_counts: lifecycle.rows,
      grouped_counts: groups.rows,
      pending: pending.rows,
      duplicates: {
        dedupe_key_clusters: dedupeDuplicates.rows,
        exact_content_clusters: exactDuplicates.rows,
        near_duplicate_candidates: nearDuplicates.rows,
      },
      test_like: testLike,
      legacy_import: legacyImport.rows[0],
      missing_provenance: missingProvenance.rows[0],
      low_strength: lowStrength.rows,
      graph_orphans: graphOrphans.rows[0],
      temporal: temporal.rows[0],
      apply_result: applyResult,
    };

    if (!args.apply) {
      await withWriteTransaction(database, (tx) => governanceRepo.finishRun(tx, run.id, "success", withGovernanceLeaseMetrics({
        pending: pending.rows.length,
        exact_duplicate_clusters: exactDuplicates.rows.length,
        test_like: testLike.length,
      }, workerId)));
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await stopHeartbeat?.();
    if (governanceRunId) {
      await withWriteTransaction(database, (tx) =>
        governanceRepo.releaseRunLease(tx, governanceRunId, workerId)
      ).catch(() => undefined);
    }
    client.release();
    await closePool(pool);
    await database.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
