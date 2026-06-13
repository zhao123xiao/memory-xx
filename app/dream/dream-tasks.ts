// Dream tasks — concrete maintenance tasks for the dream worker.

import type { DreamTask, DreamTaskResult } from "./dream-worker";
import { createLogger } from "../shared/logger";
import { selectDecayArchiveCandidates } from "../decay";
import { runConsolidation, type ConflictPair, type DuplicateGroup } from "../consolidation";
import { resolveConflict as resolveMemoryConflict } from "../consolidation/conflict-resolver";
import { mergeContents } from "../consolidation/merge-engine";
import { evaluateAutoApprovalPolicy } from "../governance/auto-approval-policy";
import { LifecycleStatus, ReviewState, ScopeType, type JsonObject } from "../shared";
import type { WriteTransactionRunner } from "../db";
import { isInMemoryTransactionContext, isPostgresTransactionContext, type WriteTransactionContext } from "../db";

const log = createLogger("dream-tasks");

function dreamFetch(url: string, init: RequestInit = {}, timeoutMs = Number.parseInt(process.env.MEMORY_XX_DREAM_TASK_TIMEOUT_MS ?? "5000", 10)): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

// ─── Consistency Audit Task ────────────────────────────────────────────────────

export function createConsistencyAuditTask(deps: {
  readonly baseUrl: string;
  readonly apiToken?: string;
}): DreamTask {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.apiToken) headers["Authorization"] = `Bearer ${deps.apiToken}`;

  return {
    id: "consistency_audit",
    name: "Consistency Audit",
    description: "Audit memory database for consistency issues (orphaned records, missing events)",
    async execute(): Promise<DreamTaskResult> {
      const start = Date.now();
      const res = await dreamFetch(`${base}/api/memory/xx/orchestrator/audit-memory-consistency`, {
        method: "POST",
        headers,
        body: JSON.stringify({ include_records: false }),
      });
      if (!res.ok) {
        return {
          task_id: this.id,
          task_name: this.name,
          status: "failed",
          duration_ms: Date.now() - start,
          summary: `Audit request failed: HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as {
        ok: boolean;
        findings: { code: string; severity: string }[];
        counts: Record<string, number>;
      };
      return {
        task_id: this.id,
        task_name: this.name,
        status: "completed",
        duration_ms: Date.now() - start,
        summary: data.ok
          ? `Consistency OK (${JSON.stringify(data.counts)} records checked)`
          : `Found ${data.findings.length} issues: ${data.findings.map((f) => f.code).join(", ")}`,
        details: data,
      };
    },
  };
}

// ─── Auto Repair Task ──────────────────────────────────────────────────────────

export function createAutoRepairTask(deps: {
  readonly baseUrl: string;
  readonly apiToken?: string;
  readonly dryRun?: boolean;
}): DreamTask {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.apiToken) headers["Authorization"] = `Bearer ${deps.apiToken}`;

  return {
    id: "auto_repair",
    name: "Auto Repair",
    description: "Automatically repair consistency issues found during audit",
    async execute(): Promise<DreamTaskResult> {
      const start = Date.now();
      const res = await dreamFetch(`${base}/api/memory/xx/orchestrator/repair-memory-consistency`, {
        method: "POST",
        headers,
        body: JSON.stringify({ dry_run: deps.dryRun ?? true }),
      });
      if (!res.ok) {
        return {
          task_id: this.id,
          task_name: this.name,
          status: "failed",
          duration_ms: Date.now() - start,
          summary: `Repair request failed: HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as {
        repairs: { code: string; action: string }[];
        dry_run: boolean;
      };
      return {
        task_id: this.id,
        task_name: this.name,
        status: "completed",
        duration_ms: Date.now() - start,
        summary: data.repairs.length > 0
          ? `${data.dry_run ? "Would repair" : "Repaired"} ${data.repairs.length} issues: ${data.repairs.map((r) => r.code).join(", ")}`
          : "No repairs needed",
        details: data,
      };
    },
  };
}

// ─── Memory Statistics Task ────────────────────────────────────────────────────

export function createMemoryStatsTask(deps: {
  readonly baseUrl: string;
  readonly apiToken?: string;
}): DreamTask {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (deps.apiToken) headers["Authorization"] = `Bearer ${deps.apiToken}`;

  return {
    id: "memory_stats",
    name: "Memory Statistics",
    description: "Collect memory service statistics and health snapshot",
    async execute(): Promise<DreamTaskResult> {
      const start = Date.now();
      const [healthResp, metricsResp] = await Promise.all([
        dreamFetch(`${base}/health`, { headers }).catch(() => null),
        dreamFetch(`${base}/metrics`, { headers }).catch(() => null),
      ]);

      const health = healthResp?.ok ? await healthResp.json() : { error: "unavailable" };
      const metrics = metricsResp?.ok ? await metricsResp.json() : { error: "unavailable" };

      return {
        task_id: this.id,
        task_name: this.name,
        status: "completed",
        duration_ms: Date.now() - start,
        summary: `Service status: ${(health as { status?: string }).status ?? "unknown"}`,
        details: { health, metrics },
      };
    },
  };
}

// ─── Embedding Retry Task ──────────────────────────────────────────────────────

export function createEmbeddingRetryTask(deps: {
  readonly baseUrl: string;
  readonly apiToken?: string;
}): DreamTask {
  const base = deps.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.apiToken) headers["Authorization"] = `Bearer ${deps.apiToken}`;

  return {
    id: "embedding_retry",
    name: "Embedding Retry",
    description: "Retry failed embedding generations from the dead letter queue",
    async execute(): Promise<DreamTaskResult> {
      const start = Date.now();
      return {
        task_id: this.id,
        task_name: this.name,
        status: "skipped",
        duration_ms: Date.now() - start,
        summary: "Embedding retry endpoint is not exposed; use qdrant replay/repair workers for projection recovery.",
        details: { endpoint_removed: true },
      };
    },
  };
}

// ─── Project Maintenance Tasks ────────────────────────────────────────────────

export interface ProjectDreamTaskDeps {
  readonly database: WriteTransactionRunner;
  readonly actorId?: string;
  readonly limit?: number;
}

interface CandidateRow {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly content: string;
  readonly title: string | null;
  readonly metadata: JsonObject;
  readonly memory_type: string | null;
  readonly importance: number | string | null;
  readonly usage_count: number | string | null;
  readonly support_count: number | string | null;
  readonly source_authority: number | string | null;
  readonly conflict_count: number | string | null;
  readonly days_since_access: number | string | null;
  readonly days_since_created: number | string | null;
  readonly confidence: number | string | null;
  readonly quality_score: number | string | null;
  readonly agent_id: string | null;
}

function numeric(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function daysBetween(earlier: string | null | undefined, later: string): number {
  if (!earlier) return 0;
  const diff = new Date(later).getTime() - new Date(earlier).getTime();
  if (!Number.isFinite(diff) || diff <= 0) return 0;
  return Math.floor(diff / 86_400_000);
}

function dreamTaskResult(
  task: Pick<DreamTask, "id" | "name">,
  status: DreamTaskResult["status"],
  start: number,
  summary: string,
  details?: unknown,
): DreamTaskResult {
  return {
    task_id: task.id,
    task_name: task.name,
    status,
    duration_ms: Date.now() - start,
    summary,
    ...(details === undefined ? {} : { details }),
  };
}

async function findDuplicateGroups(tx: WriteTransactionContext, limit: number): Promise<DuplicateGroup[]> {
  if (isInMemoryTransactionContext(tx)) {
    const groups = new Map<string, DuplicateGroup>();
    for (const record of tx.state.memoryRecords) {
      if (
        record.lifecycleStatus !== LifecycleStatus.Approved ||
        !record.isCurrent ||
        !record.dedupeKey
      ) continue;
      const key = `${record.scopeType}:${record.scopeId}:${record.dedupeKey}`;
      const existing = groups.get(key);
      groups.set(key, {
        dedupe_key: record.dedupeKey,
        memory_ids: [...(existing?.memory_ids ?? []), record.id],
        scope_type: record.scopeType,
        scope_id: record.scopeId,
      });
    }
    return [...groups.values()]
      .filter((group) => group.memory_ids.length > 1)
      .slice(0, limit);
  }
  if (!isPostgresTransactionContext(tx)) return [];
  const rows = await tx.query<{
    dedupe_key: string;
    memory_ids: string[];
    scope_type: string;
    scope_id: string;
  }>(
    `
      SELECT dedupe_key, array_agg(id ORDER BY created_at ASC) AS memory_ids, scope_type, scope_id
      FROM memory_records
      WHERE lifecycle_status = 'approved'
        AND is_current = TRUE
        AND dedupe_key IS NOT NULL
      GROUP BY dedupe_key, scope_type, scope_id
      HAVING COUNT(*) > 1
      ORDER BY max(updated_at) DESC
      LIMIT $1
    `,
    [limit]
  );
  return rows.map((row) => ({
    dedupe_key: row.dedupe_key,
    memory_ids: row.memory_ids,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
  }));
}

async function findConflictPairs(tx: WriteTransactionContext, limit: number): Promise<ConflictPair[]> {
  if (isInMemoryTransactionContext(tx)) {
    return tx.state.memoryRelations
      .filter((relation) => relation.relationType === "contradicts" || relation.relationType === "conflicts_with")
      .slice(0, limit)
      .map((relation) => ({
        memory_id_a: relation.memoryId,
        memory_id_b: relation.relatedMemoryId,
        relation_type: relation.relationType,
      }));
  }
  if (!isPostgresTransactionContext(tx)) return [];
  return [...await tx.query<ConflictPair>(
    `
      SELECT memory_id AS memory_id_a, related_memory_id AS memory_id_b, relation_type
      FROM memory_relations
      WHERE relation_type IN ('contradicts', 'conflicts_with')
      ORDER BY updated_at DESC
      LIMIT $1
    `,
    [limit]
  )];
}

async function mergeDuplicateGroup(
  tx: WriteTransactionContext,
  group: DuplicateGroup,
  actorId: string
): Promise<string | null> {
  const now = tx.now();
  if (isInMemoryTransactionContext(tx)) {
    const sourceRecords = group.memory_ids
      .map((id) => tx.state.memoryRecords.find((record) => record.id === id))
      .filter((record): record is NonNullable<typeof record> => Boolean(record));
    if (sourceRecords.length <= 1) return null;
    const merged = mergeContents({
      memory_ids: sourceRecords.map((record) => record.id),
      contents: sourceRecords.map((record) => record.content),
      scope_type: group.scope_type,
      scope_id: group.scope_id,
    });
    const id = tx.nextId("memory_record");
    tx.state.memoryRecords.push({
      ...sourceRecords[0],
      id,
      requestId: `dream-consolidation-${id}`,
      content: merged.merged_content,
      title: `Consolidated ${sourceRecords[0].title ?? group.dedupe_key}`,
      summary: null,
      metadata: {
        ...sourceRecords[0].metadata,
        consolidation_task: "consolidation_run",
        source_memory_ids: [...merged.source_ids],
      },
      dedupeKey: group.dedupe_key,
      lifecycleStatus: LifecycleStatus.Approved,
      reviewState: ReviewState.NotRequired,
      isCurrent: true,
      version: 1,
      createdBy: actorId,
      updatedBy: actorId,
      createdAt: now,
      updatedAt: now,
    });
    for (const record of sourceRecords) {
      const index = tx.state.memoryRecords.findIndex((item) => item.id === record.id);
      if (index === -1) continue;
      tx.state.memoryRecords[index] = {
        ...record,
        lifecycleStatus: LifecycleStatus.Archived,
        reviewState: ReviewState.NotRequired,
        isCurrent: false,
        invalidAt: record.invalidAt ?? now,
        updatedBy: actorId,
        updatedAt: now,
      };
    }
    return id;
  }
  if (!isPostgresTransactionContext(tx)) return null;
  const rows = await tx.query<{
    id: string;
    content: string;
    title: string | null;
    metadata: JsonObject;
    memory_type: string | null;
    tenant_id: string | null;
    governance_status: string | null;
    visibility: string | null;
  }>(
    `
      SELECT id, content, title, metadata, memory_type, tenant_id, governance_status, visibility
      FROM memory_records
      WHERE id = ANY($1::text[])
        AND lifecycle_status = 'approved'
        AND is_current = TRUE
      ORDER BY created_at ASC
      FOR UPDATE
    `,
    [group.memory_ids]
  );
  if (rows.length <= 1) return null;
  const merged = mergeContents({
    memory_ids: rows.map((row) => row.id),
    contents: rows.map((row) => row.content),
    scope_type: group.scope_type,
    scope_id: group.scope_id,
  });
  const [created] = await tx.query<{ id: string }>(
    `
      INSERT INTO memory_records (
        id, request_id, scope_type, scope_id, content, title, summary, metadata, dedupe_key,
        lifecycle_status, review_state, is_current, version, created_by, updated_by, created_at, updated_at,
        tenant_id, agent_id, governance_status, visibility, memory_type
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, NULL, $7::jsonb, $8,
        $9, $10, TRUE, 1, $11, $11, $12::timestamptz, $12::timestamptz,
        $13, $11, $14, $15, $16
      )
      RETURNING id
    `,
    [
      tx.nextId("memory_record"),
      `dream-consolidation-${group.dedupe_key}-${Date.now()}`,
      group.scope_type,
      group.scope_id,
      merged.merged_content,
      `Consolidated ${rows[0].title ?? group.dedupe_key}`,
      JSON.stringify({
        ...(rows[0].metadata ?? {}),
        consolidation_task: "consolidation_run",
        source_memory_ids: merged.source_ids,
      }),
      group.dedupe_key,
      LifecycleStatus.Approved,
      ReviewState.NotRequired,
      actorId,
      now,
      rows[0].tenant_id ?? "default",
      rows[0].governance_status ?? "normal",
      rows[0].visibility ?? "scope_only",
      rows[0].memory_type,
    ]
  );
  await tx.query(
    `
      UPDATE memory_records
      SET lifecycle_status = $2,
          review_state = $3,
          is_current = FALSE,
          updated_by = $4,
          updated_at = $5::timestamptz,
          invalid_at = COALESCE(invalid_at, $5::timestamptz)
      WHERE id = ANY($1::text[])
    `,
    [rows.map((row) => row.id), LifecycleStatus.Archived, ReviewState.NotRequired, actorId, now]
  );
  return created?.id ?? null;
}

async function resolveConflictPair(
  tx: WriteTransactionContext,
  conflict: ConflictPair,
  actorId: string
): Promise<string | null> {
  const now = tx.now();
  if (isInMemoryTransactionContext(tx)) {
    const left = tx.state.memoryRecords.find((record) => record.id === conflict.memory_id_a);
    const right = tx.state.memoryRecords.find((record) => record.id === conflict.memory_id_b);
    if (!left || !right) return null;
    const resolved = resolveMemoryConflict({
      id_a: left.id,
      content_a: left.content,
      importance_a: left.importance,
      created_at_a: left.createdAt,
      relation_type_a_to_b: conflict.relation_type,
      fact_status_a: left.factStatus,
      valid_at_a: left.validAt,
      invalid_at_a: left.invalidAt,
      id_b: right.id,
      content_b: right.content,
      importance_b: right.importance,
      created_at_b: right.createdAt,
      fact_status_b: right.factStatus,
      valid_at_b: right.validAt,
      invalid_at_b: right.invalidAt,
    });
    const loserIndex = tx.state.memoryRecords.findIndex((record) => record.id === resolved.loser_id);
    if (loserIndex === -1) return null;
    const loser = tx.state.memoryRecords[loserIndex];
    tx.state.memoryRecords[loserIndex] = {
      ...loser,
      lifecycleStatus: LifecycleStatus.Archived,
      reviewState: ReviewState.NotRequired,
      isCurrent: false,
      invalidAt: loser.invalidAt ?? now,
      updatedBy: actorId,
      updatedAt: now,
      metadata: {
        ...loser.metadata,
        conflict_resolution: {
          task: "consolidation_run",
          winner_id: resolved.winner_id,
          reason: resolved.reason,
          resolved_at: now,
        },
      },
    };
    return resolved.winner_id;
  }
  if (!isPostgresTransactionContext(tx)) return null;
  const rows = await tx.query<{
    id: string;
    content: string;
    importance: number | string | null;
    created_at: Date | string;
    fact_status: string | null;
    valid_at: Date | string | null;
    invalid_at: Date | string | null;
  }>(
    `
      SELECT id, content, importance, created_at, fact_status, valid_at, invalid_at
      FROM memory_records
      WHERE id = ANY($1::text[])
      FOR UPDATE
    `,
    [[conflict.memory_id_a, conflict.memory_id_b]]
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const left = byId.get(conflict.memory_id_a);
  const right = byId.get(conflict.memory_id_b);
  if (!left || !right) return null;
  const resolved = resolveMemoryConflict({
    id_a: left.id,
    content_a: left.content,
    importance_a: numeric(left.importance, 0.5),
    created_at_a: new Date(left.created_at).toISOString(),
    relation_type_a_to_b: conflict.relation_type,
    fact_status_a: left.fact_status ?? "current",
    valid_at_a: left.valid_at ? new Date(left.valid_at).toISOString() : null,
    invalid_at_a: left.invalid_at ? new Date(left.invalid_at).toISOString() : null,
    id_b: right.id,
    content_b: right.content,
    importance_b: numeric(right.importance, 0.5),
    created_at_b: new Date(right.created_at).toISOString(),
    fact_status_b: right.fact_status ?? "current",
    valid_at_b: right.valid_at ? new Date(right.valid_at).toISOString() : null,
    invalid_at_b: right.invalid_at ? new Date(right.invalid_at).toISOString() : null,
  });
  await tx.query(
    `
      UPDATE memory_records
      SET lifecycle_status = $2,
          review_state = $3,
          is_current = FALSE,
          updated_by = $4,
          updated_at = $5::timestamptz,
          invalid_at = COALESCE(invalid_at, $5::timestamptz),
          metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{conflict_resolution}',
            $6::jsonb,
            true
          )
      WHERE id = $1
    `,
    [
      resolved.loser_id,
      LifecycleStatus.Archived,
      ReviewState.NotRequired,
      actorId,
      now,
      JSON.stringify({
        task: "consolidation_run",
        winner_id: resolved.winner_id,
        reason: resolved.reason,
        resolved_at: now,
      }),
    ]
  );
  return resolved.winner_id;
}

export function createDecayArchiveTask(deps: ProjectDreamTaskDeps): DreamTask {
  const limit = deps.limit ?? 50;
  return {
    id: "decay_archive",
    name: "Decay Archive",
    description: "Select weak approved memories and archive up to 50 candidates per dream cycle",
    async execute(): Promise<DreamTaskResult> {
      const start = Date.now();
      const actorId = deps.actorId ?? "dream-worker";
      const report = await deps.database.withTransaction(async (tx) => {
        if (isInMemoryTransactionContext(tx)) {
          const now = tx.now();
          const rows = tx.state.memoryRecords
            .filter((record) =>
              record.lifecycleStatus === LifecycleStatus.Approved &&
              record.isCurrent &&
              record.decayPolicy !== "none"
            )
            .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
            .slice(0, limit);
          const selected = selectDecayArchiveCandidates(rows.map((record) => ({
            id: record.id,
            importance: numeric(record.importance, 0.5),
            usageCount: 0,
            supportCount: 0,
            sourceAuthority: 0.5,
            daysSinceAccess: daysBetween(record.updatedAt ?? record.createdAt, now),
            conflictCount: 0,
            daysSinceCreated: daysBetween(record.createdAt, now),
          })));
          let archived = 0;
          for (const memoryId of selected.archive_candidate_ids) {
            const index = tx.state.memoryRecords.findIndex((record) => record.id === memoryId);
            if (index === -1) continue;
            const record = tx.state.memoryRecords[index];
            tx.state.memoryRecords[index] = {
              ...record,
              lifecycleStatus: LifecycleStatus.Archived,
              reviewState: ReviewState.NotRequired,
              isCurrent: false,
              invalidAt: record.invalidAt ?? now,
              updatedBy: actorId,
              updatedAt: now,
            };
            archived++;
          }
          return { ...selected, archived };
        }
        if (!isPostgresTransactionContext(tx)) return { checked: 0, archive_candidate_ids: [] as string[], archived: 0 };
        const rows = await tx.query<CandidateRow>(
          `
            SELECT
              id,
              scope_type,
              scope_id,
              importance,
              0 AS usage_count,
              0 AS support_count,
              0.5 AS source_authority,
              0 AS conflict_count,
              EXTRACT(DAY FROM (now() - COALESCE(updated_at, created_at))) AS days_since_access,
              EXTRACT(DAY FROM (now() - created_at)) AS days_since_created,
              content,
              title,
              metadata,
              memory_type,
              0.9 AS confidence,
              0.9 AS quality_score,
              agent_id
            FROM memory_records
            WHERE lifecycle_status = 'approved'
              AND is_current = TRUE
              AND decay_policy <> 'none'
            ORDER BY updated_at ASC
            LIMIT $1
          `,
          [limit]
        );
        const candidates = rows.map((row) => ({
          id: row.id,
          importance: numeric(row.importance, 0.5),
          usageCount: numeric(row.usage_count, 0),
          supportCount: numeric(row.support_count, 0),
          sourceAuthority: numeric(row.source_authority, 0.5),
          daysSinceAccess: numeric(row.days_since_access, 0),
          conflictCount: numeric(row.conflict_count, 0),
          daysSinceCreated: numeric(row.days_since_created, 0),
        }));
        const selected = selectDecayArchiveCandidates(candidates);
        if (selected.archive_candidate_ids.length === 0) {
          return { ...selected, archived: 0 };
        }
        const archived = await tx.query<{ id: string }>(
          `
            UPDATE memory_records
            SET lifecycle_status = $2,
                review_state = $3,
                is_current = FALSE,
                updated_by = $4,
                updated_at = $5::timestamptz,
                invalid_at = COALESCE(invalid_at, $5::timestamptz)
            WHERE id = ANY($1::text[])
            RETURNING id
          `,
          [selected.archive_candidate_ids, LifecycleStatus.Archived, ReviewState.NotRequired, actorId, tx.now()]
        );
        return { ...selected, archived: archived.length };
      });
      return dreamTaskResult(this, "completed", start, `Archived ${report.archived}/${report.archive_candidate_ids.length} decay candidates`, report);
    },
  };
}

export function createConsolidationRunTask(deps: ProjectDreamTaskDeps): DreamTask {
  const limit = deps.limit ?? 50;
  return {
    id: "consolidation_run",
    name: "Consolidation Run",
    description: "Discover duplicate and conflicting project memories for consolidation",
    async execute(): Promise<DreamTaskResult> {
      const start = Date.now();
      const actorId = deps.actorId ?? "dream-worker";
      const duplicates: DuplicateGroup[] = [];
      const conflicts: ConflictPair[] = [];
      let activeTx: WriteTransactionContext | null = null;
      const withConsolidationTx = async <TResult>(work: (tx: WriteTransactionContext) => Promise<TResult>): Promise<TResult> => {
        if (activeTx) return work(activeTx);
        return deps.database.withTransaction(work);
      };
      const result = await runConsolidation({
        runInJobTransaction: async (work) => deps.database.withTransaction(async (tx) => {
          activeTx = tx;
          try {
            return await work();
          } finally {
            activeTx = null;
          }
        }),
        findDuplicates: async () => withConsolidationTx(async (tx) => {
          const found = await findDuplicateGroups(tx, limit);
          duplicates.splice(0, duplicates.length, ...found);
          return duplicates;
        }),
        findConflicts: async () => withConsolidationTx(async (tx) => {
          const found = await findConflictPairs(tx, limit);
          conflicts.splice(0, conflicts.length, ...found);
          return conflicts;
        }),
        mergeDuplicates: async (group) => withConsolidationTx((tx) => mergeDuplicateGroup(tx, group, actorId)),
        resolveConflict: async (conflict) => withConsolidationTx((tx) => resolveConflictPair(tx, conflict, actorId)),
        buildEpisodes: async () => 0,
      });
      const status: DreamTaskResult["status"] = result.errors.length > 0 ? "failed" : "completed";
      return dreamTaskResult(
        this,
        status,
        start,
        `Consolidation scanned ${duplicates.length} duplicate groups and ${conflicts.length} conflict pairs`,
        { ...result, duplicate_groups: duplicates.length, conflict_pairs: conflicts.length }
      );
    },
  };
}

export function createCandidateAutoApproveTask(deps: ProjectDreamTaskDeps): DreamTask {
  const limit = deps.limit ?? 50;
  return {
    id: "candidate_auto_approve",
    name: "Candidate Auto Approve",
    description: "Evaluate pending project candidates and silently approve policy-safe memories",
    async execute(): Promise<DreamTaskResult> {
      const start = Date.now();
      const actorId = deps.actorId ?? "dream-worker";
      const report = await deps.database.withTransaction(async (tx) => {
        if (isInMemoryTransactionContext(tx)) {
          const rows = tx.state.memoryRecords
            .filter((record) =>
              record.lifecycleStatus === LifecycleStatus.Candidate &&
              record.reviewState === ReviewState.Pending &&
              record.isCurrent
            )
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
            .slice(0, limit);
          let approved = 0;
          for (const record of rows) {
            const decision = evaluateAutoApprovalPolicy({
              mode: "auto_approve",
              agentId: record.agentId ?? actorId,
              source: typeof record.metadata?.source === "string" ? record.metadata.source : "conversation_ingest",
              sourceText: record.content,
              candidate: {
                scopeType: record.scopeType,
                scopeId: record.scopeId,
                memoryType: record.memoryType ?? "fact",
                operation: "add",
                confidence: numeric(record.metadata?.confidence, 0.9),
                qualityScore: numeric(record.metadata?.quality_score ?? record.metadata?.qualityScore, 0.9),
                title: record.title,
                content: record.content,
                metadata: record.metadata,
              },
              trustedAgent: true,
              hasScopeGrant: true,
              candidateOnly: false,
              candidateOnlyReasons: [],
              semanticConflict: false,
              semanticDuplicate: false,
              autoApproveEnabled: true,
              enabledProjectIds: record.scopeType === ScopeType.Project ? [record.scopeId] : [],
            });
            if (decision.decision !== "approve") continue;
            const index = tx.state.memoryRecords.findIndex((item) => item.id === record.id);
            if (index === -1) continue;
            tx.state.memoryRecords[index] = {
              ...record,
              lifecycleStatus: LifecycleStatus.Approved,
              reviewState: ReviewState.SilentApproved,
              isCurrent: true,
              updatedBy: actorId,
              updatedAt: tx.now(),
              metadata: {
                ...record.metadata,
                dream_auto_approval: {
                  policy_version: decision.policy_version,
                  score: decision.score,
                  reasons: [...decision.reasons],
                  approved_at: tx.now(),
                },
              },
            };
            approved++;
          }
          return { evaluated: rows.length, approved, kept_pending: rows.length - approved };
        }
        if (!isPostgresTransactionContext(tx)) return { evaluated: 0, approved: 0, kept_pending: 0 };
        const rows = await tx.query<CandidateRow>(
          `
            SELECT
              id,
              scope_type,
              scope_id,
              content,
              title,
              metadata,
              memory_type,
              importance,
              0 AS usage_count,
              0 AS support_count,
              0.5 AS source_authority,
              0 AS conflict_count,
              0 AS days_since_access,
              EXTRACT(DAY FROM (now() - created_at)) AS days_since_created,
              COALESCE((metadata->>'confidence')::float, 0.9) AS confidence,
              COALESCE((metadata->>'quality_score')::float, (metadata->>'qualityScore')::float, 0.9) AS quality_score,
              agent_id
            FROM memory_records
            WHERE lifecycle_status = 'candidate'
              AND review_state = 'pending'
              AND is_current = TRUE
            ORDER BY created_at ASC
            LIMIT $1
          `,
          [limit]
        );
        let approved = 0;
        for (const row of rows) {
          const decision = evaluateAutoApprovalPolicy({
            mode: "auto_approve",
            agentId: row.agent_id ?? actorId,
            source: typeof row.metadata?.source === "string" ? row.metadata.source : "conversation_ingest",
            sourceText: row.content,
            candidate: {
              scopeType: row.scope_type,
              scopeId: row.scope_id,
              memoryType: row.memory_type ?? "fact",
              operation: "add",
              confidence: numeric(row.confidence, 0.9),
              qualityScore: numeric(row.quality_score, 0.9),
              title: row.title,
              content: row.content,
              metadata: row.metadata,
            },
            trustedAgent: true,
            hasScopeGrant: true,
            candidateOnly: false,
            candidateOnlyReasons: [],
            semanticConflict: false,
            semanticDuplicate: false,
            autoApproveEnabled: true,
            enabledProjectIds: row.scope_type === ScopeType.Project ? [row.scope_id] : [],
          });
          if (decision.decision !== "approve") continue;
          await tx.query(
            `
              UPDATE memory_records
              SET lifecycle_status = $2,
                  review_state = $3,
                  updated_by = $4,
                  updated_at = $5::timestamptz,
                  metadata = jsonb_set(
                    COALESCE(metadata, '{}'::jsonb),
                    '{dream_auto_approval}',
                    $6::jsonb,
                    true
                  )
              WHERE id = $1
            `,
            [
              row.id,
              LifecycleStatus.Approved,
              ReviewState.SilentApproved,
              actorId,
              tx.now(),
              JSON.stringify({
                policy_version: decision.policy_version,
                score: decision.score,
                reasons: decision.reasons,
                approved_at: tx.now(),
              }),
            ]
          );
          approved++;
        }
        return { evaluated: rows.length, approved, kept_pending: rows.length - approved };
      });
      return dreamTaskResult(this, "completed", start, `Auto-approved ${report.approved}/${report.evaluated} pending candidates`, report);
    },
  };
}
