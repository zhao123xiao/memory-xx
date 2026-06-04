#!/usr/bin/env tsx
import "./test-harness/config.js";

import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { readAutoApprovalRuntimeControlsSync, isTestAutoUpdateApplyScope } from "../app/governance/auto-approval-runtime-controls";
import { evaluateAutoUpdatePolicy, isAutoUpdateApplyScopeEnabled } from "../app/governance/auto-update-policy";
import { requireCliPermission } from "../app/server/permissions.js";
import { LifecycleStatus, OutboxEventType, ReviewState } from "../app/shared";
import type { JsonObject } from "../app/shared";
import { loadDotenvIfPresent, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function command(): string {
  return process.argv[2] ?? "dry-run";
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseScope(raw: string): { scopeType: string; scopeId: string; key: string } {
  const value = raw.trim();
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) throw new Error("--scope must look like project:memory-xx");
  return { scopeType: value.slice(0, index), scopeId: value.slice(index + 1), key: value };
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function readObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

type MemoryRow = {
  id: string;
  request_id: string;
  scope_type: string;
  scope_id: string;
  memory_type: string | null;
  title: string | null;
  content: string;
  metadata: JsonObject;
  lifecycle_status: string;
  review_state: string;
  is_current: boolean;
  agent_id: string;
  source: string;
  conflict_action: string;
  existing_memory_id: string | null;
  quality_score: number;
  confidence: number;
};

async function loadCandidate(client: import("pg").PoolClient, schema: string, candidateId: string): Promise<MemoryRow | null> {
  const rows = await client.query(
    `
      SELECT id, request_id, scope_type, scope_id, memory_type, title, content, metadata,
             lifecycle_status, review_state, is_current,
             COALESCE(agent_id, metadata->>'agent_id', created_by, 'unknown') AS agent_id,
             COALESCE(metadata->>'source', '') AS source,
             COALESCE(metadata->>'conflict_action', metadata->'semantic_dedup'->>'action', 'create') AS conflict_action,
             COALESCE(metadata->>'existing_memory_id', metadata->'semantic_dedup'->>'existing_memory_id') AS existing_memory_id,
             COALESCE((metadata->'quality_gate'->>'score')::float, (metadata->>'quality_score')::float, 0.9) AS quality_score,
             COALESCE((metadata->>'confidence')::float, 0.9) AS confidence
      FROM ${schema}.memory_records
      WHERE id = $1
      LIMIT 1
    `,
    [candidateId]
  );
  return rows.rows[0] ?? null;
}

async function findApplyCandidate(client: import("pg").PoolClient, schema: string, scope: { scopeType: string; scopeId: string }, candidateId: string): Promise<MemoryRow> {
  if (candidateId) {
    const row = await loadCandidate(client, schema, candidateId);
    if (!row) throw new Error(`candidate not found: ${candidateId}`);
    return row;
  }
  const rows = await client.query(
    `
      SELECT id
      FROM ${schema}.memory_records
      WHERE lifecycle_status = 'candidate'
        AND review_state = 'pending'
        AND scope_type = $1
        AND scope_id = $2
        AND COALESCE(metadata->>'existing_memory_id', metadata->'semantic_dedup'->>'existing_memory_id', '') <> ''
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [scope.scopeType, scope.scopeId]
  );
  const id = readString(rows.rows[0]?.id);
  if (!id) throw new Error(`no pending auto-update candidate found in ${scope.scopeType}:${scope.scopeId}`);
  const row = await loadCandidate(client, schema, id);
  if (!row) throw new Error(`candidate not found after lookup: ${id}`);
  return row;
}

async function appendLifecycleArtifacts(client: import("pg").PoolClient, schema: string, input: {
  readonly memoryId: string;
  readonly requestId: string;
  readonly eventType: OutboxEventType;
  readonly actorId: string;
  readonly payload: JsonObject;
}): Promise<{ memoryEventId: string; outboxEventId: string }> {
  const memoryEventId = newId("memory_event");
  const outboxEventId = newId("outbox_event");
  await client.query(
    `INSERT INTO ${schema}.memory_events (id, memory_id, request_id, event_type, actor_id, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())`,
    [memoryEventId, input.memoryId, input.requestId, input.eventType, input.actorId, JSON.stringify(input.payload)]
  );
  await client.query(
    `INSERT INTO ${schema}.outbox_events (
       id, aggregate_id, request_id, event_type, payload, payload_version, dispatch_status, attempts, created_at, dispatched_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, 1, 'pending', 0, now(), NULL)`,
    [outboxEventId, input.memoryId, input.requestId, input.eventType, JSON.stringify(input.payload)]
  );
  return { memoryEventId, outboxEventId };
}

async function enqueueCacheInvalidation(client: import("pg").PoolClient, schema: string, scopeType: string, scopeId: string, reason: string): Promise<string> {
  const id = newId("cache_invalidation_request");
  await client.query(
    `INSERT INTO ${schema}.cache_invalidation_requests (
       id, scope_type, scope_id, reason, status, attempts, next_attempt_at, last_error,
       lease_owner, lease_expires_at, completed_at, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, 'pending', 0, now(), NULL, NULL, NULL, NULL, now(), now())`,
    [id, scopeType, scopeId, reason]
  );
  return id;
}

async function assertHourlyApplyLimit(client: import("pg").PoolClient, schema: string, scope: { scopeType: string; scopeId: string }): Promise<{ recentApplied: number; hourlyLimit: number; enforced: boolean }> {
  const controls = readAutoApprovalRuntimeControlsSync();
  const hourlyLimit = Math.max(1, controls.update_apply.max_hourly_per_scope || 1);
  const enforced = !isTestAutoUpdateApplyScope(scope.scopeType, scope.scopeId);
  if (!enforced) return { recentApplied: 0, hourlyLimit, enforced };
  const rows = await client.query(
    `SELECT count(*)::int AS count
     FROM ${schema}.memory_governance_actions
     WHERE action_type = 'auto_update_decision'
       AND scope_type = $1
       AND scope_id = $2
       AND status = 'applied'
       AND created_at >= now() - interval '1 hour'`,
    [scope.scopeType, scope.scopeId]
  );
  const recentApplied = Number(rows.rows[0]?.count ?? 0);
  if (recentApplied >= hourlyLimit) {
    throw new Error(`auto_update_apply_blocked:auto_update_hourly_limit_exceeded recent=${recentApplied} limit=${hourlyLimit}`);
  }
  return { recentApplied, hourlyLimit, enforced };
}

async function applyUpdate(client: import("pg").PoolClient, schema: string, scope: { scopeType: string; scopeId: string; key: string }): Promise<Record<string, unknown>> {
  if (!isAutoUpdateApplyScopeEnabled(scope.scopeType, scope.scopeId)) {
    throw new Error("auto_update_apply_real_scope_disabled：该 scope（作用域）的 apply（自动更新应用）已被运行时控制关闭");
  }
  const candidate = await findApplyCandidate(client, schema, scope, arg("candidate-id"));
  if (candidate.scope_type !== scope.scopeType || candidate.scope_id !== scope.scopeId) {
    throw new Error(`候选记忆 scope（作用域）不匹配：${candidate.scope_type}:${candidate.scope_id}`);
  }
  const existingId = readString(candidate.existing_memory_id);
  if (!existingId) throw new Error("执行 apply（自动更新应用）需要候选记忆 metadata.existing_memory_id（旧记忆 ID）");
  const oldRow = await client.query(
    `SELECT id, request_id, content, lifecycle_status, review_state, is_current, metadata FROM ${schema}.memory_records WHERE id = $1 FOR UPDATE`,
    [existingId]
  );
  const old = oldRow.rows[0];
  if (!old) throw new Error(`未找到旧记忆：${existingId}`);
  const decision = evaluateAutoUpdatePolicy({
    candidateId: candidate.id,
    existingMemoryId: existingId,
    scopeType: candidate.scope_type,
    scopeId: candidate.scope_id,
    memoryType: candidate.memory_type,
    operation: candidate.conflict_action,
    conflictAction: candidate.conflict_action,
    content: candidate.content,
    existingContent: String(old.content ?? ""),
    confidence: numberValue(candidate.confidence, 0),
    qualityScore: numberValue(candidate.quality_score, 0),
    agentId: candidate.agent_id,
    source: candidate.source,
    metadata: readObject(candidate.metadata),
  });
  if (!decision.apply_allowed) {
    throw new Error(`auto_update_apply_blocked:${decision.apply_blocked_reason ?? "policy_blocked"}`);
  }
  const rateLimit = await assertHourlyApplyLimit(client, schema, scope);

  const beforeState = {
    old: {
      id: old.id,
      lifecycle_status: old.lifecycle_status,
      review_state: old.review_state,
      is_current: old.is_current,
      content: old.content,
      metadata: old.metadata ?? {},
    },
    candidate: {
      id: candidate.id,
      lifecycle_status: candidate.lifecycle_status,
      review_state: candidate.review_state,
      is_current: candidate.is_current,
      content: candidate.content,
      metadata: candidate.metadata ?? {},
    },
  };
  await client.query("BEGIN");
  try {
    const oldStatus = decision.detected_update_type === "temporal_expiry" ? LifecycleStatus.Archived : LifecycleStatus.Superseded;
    await client.query(
      `UPDATE ${schema}.memory_records
       SET lifecycle_status = $2, is_current = false, metadata = metadata || $3::jsonb, updated_by = 'memory:auto-update', updated_at = now()
       WHERE id = $1`,
      [old.id, oldStatus, JSON.stringify({ auto_update_superseded_by: candidate.id, auto_update_decision_type: decision.detected_update_type })]
    );
    await client.query(
      `UPDATE ${schema}.memory_records
       SET lifecycle_status = 'approved', review_state = 'silent_approved', is_current = true,
           metadata = metadata || $2::jsonb, updated_by = 'memory:auto-update', updated_at = now()
       WHERE id = $1`,
      [candidate.id, JSON.stringify({
        auto_update_applied: true,
        auto_update_type: decision.detected_update_type,
        replacement_confidence: decision.replacement_confidence,
        explicit_update_signal: decision.explicit_update_signal,
        old_memory_id: old.id,
        diff_summary: decision.diff_summary,
      })]
    );
    const oldEvent = await appendLifecycleArtifacts(client, schema, {
      memoryId: old.id,
      requestId: old.request_id,
      eventType: OutboxEventType.MemoryLifecycleChanged,
      actorId: "memory:auto-update",
      payload: {
        action: "auto_update_old_memory_superseded",
        previous_lifecycle_status: old.lifecycle_status,
        lifecycle_status: oldStatus,
        memoryId: old.id,
        replacementMemoryId: candidate.id,
        replacement_memory_id: candidate.id,
        decision,
      } as JsonObject,
    });
    const newEvent = await appendLifecycleArtifacts(client, schema, {
      memoryId: candidate.id,
      requestId: candidate.request_id,
      eventType: OutboxEventType.MemorySuperseded,
      actorId: "memory:auto-update",
      payload: {
        action: "auto_update_candidate_approved",
        memoryId: candidate.id,
        supersededMemoryId: old.id,
        superseded_memory_id: old.id,
        lifecycle_status: LifecycleStatus.Approved,
        lifecycleStatus: LifecycleStatus.Approved,
        review_state: ReviewState.SilentApproved,
        reviewState: ReviewState.SilentApproved,
        isCurrent: true,
        decision,
      } as JsonObject,
    });
    const cacheRequestId = await enqueueCacheInvalidation(client, schema, candidate.scope_type, candidate.scope_id, "auto_update_apply");
    const decisionId = newId("auto_update_decision");
    await client.query(
      `INSERT INTO ${schema}.memory_governance_actions (
         id, action_type, scope_type, scope_id, memory_id, related_memory_id, selector, evidence,
         before_state, after_state, outbox_event_ids, status, created_by, created_at
       )
       VALUES ($1, 'auto_update_decision', $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, 'applied', 'memory:auto-update', now())`,
      [
        decisionId,
        candidate.scope_type,
        candidate.scope_id,
        candidate.id,
        old.id,
        JSON.stringify({ scope: scope.key, candidate_id: candidate.id, old_memory_id: old.id }),
        JSON.stringify({
          decision,
          dry_run_plan: decision.action_plan,
          rollback_plan: decision.rollback_plan,
          cache_invalidation_request_id: cacheRequestId,
          qdrant_projection_expected: {
            old_memory_id: old.id,
            new_memory_id: candidate.id,
            effect: "old_point_removed_or_tombstoned_new_point_upserted",
          },
          hourly_limit: rateLimit,
        }),
        JSON.stringify(beforeState),
        JSON.stringify({
          old: { lifecycle_status: oldStatus, is_current: false },
          candidate: { lifecycle_status: LifecycleStatus.Approved, review_state: ReviewState.SilentApproved, is_current: true },
        }),
        JSON.stringify([oldEvent.outboxEventId, newEvent.outboxEventId]),
      ]
    );
    await client.query("COMMIT");
    return {
      ok: true,
      decision_id: decisionId,
      scope: scope.key,
      old_memory_id: old.id,
      new_memory_id: candidate.id,
      decision,
      dry_run_plan: decision.action_plan,
      rollback_plan: decision.rollback_plan,
      outbox_event_ids: [oldEvent.outboxEventId, newEvent.outboxEventId],
      cache_invalidation_request_id: cacheRequestId,
      qdrant_projection_expected: {
        old_memory_id: old.id,
        new_memory_id: candidate.id,
        effect: "old_point_removed_or_tombstoned_new_point_upserted",
      },
      hourly_limit: rateLimit,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function rollbackUpdate(client: import("pg").PoolClient, schema: string): Promise<Record<string, unknown>> {
  const decisionId = arg("decision-id");
  if (!decisionId) throw new Error("缺少必填参数：--decision-id（决策 ID）");
  const rows = await client.query(
    `SELECT * FROM ${schema}.memory_governance_actions WHERE id = $1 AND action_type = 'auto_update_decision' LIMIT 1`,
    [decisionId]
  );
  const action = rows.rows[0];
  if (!action) throw new Error(`未找到自动更新决策：${decisionId}`);
  const oldId = readString(action.related_memory_id);
  const newIdValue = readString(action.memory_id);
  if (!oldId || !newIdValue) throw new Error("自动更新决策缺少 old/new memory ids（旧/新记忆 ID）");
  if (hasFlag("dry-run")) {
    process.stdout.write(JSON.stringify({
      ok: true,
      dry_run: true,
      decision_id: decisionId,
      old_memory_id: oldId,
      new_memory_id: newIdValue,
      before_state: action.before_state,
      after_state: action.after_state,
    }, null, 2) + "\n");
    return { ok: true };
  }
  const oldRow = await client.query(`SELECT id, request_id, scope_type, scope_id, lifecycle_status, review_state, is_current FROM ${schema}.memory_records WHERE id = $1 FOR UPDATE`, [oldId]);
  const newRow = await client.query(`SELECT id, request_id, scope_type, scope_id, lifecycle_status, review_state, is_current FROM ${schema}.memory_records WHERE id = $1 FOR UPDATE`, [newIdValue]);
  const old = oldRow.rows[0];
  const newer = newRow.rows[0];
  if (!old || !newer) throw new Error("回滚所需的旧/新记忆不存在");
  await client.query("BEGIN");
  try {
    await client.query(
      `UPDATE ${schema}.memory_records
       SET lifecycle_status = 'approved', review_state = CASE WHEN review_state = 'pending' THEN 'silent_approved' ELSE review_state END,
           is_current = true, metadata = metadata || $2::jsonb, updated_by = 'memory:auto-update', updated_at = now()
       WHERE id = $1`,
      [oldId, JSON.stringify({ auto_update_rollback_restored_at: new Date().toISOString(), rollback_decision_id: decisionId })]
    );
    await client.query(
      `UPDATE ${schema}.memory_records
       SET lifecycle_status = 'tombstone', is_current = false, metadata = metadata || $2::jsonb, updated_by = 'memory:auto-update', updated_at = now()
       WHERE id = $1`,
      [newIdValue, JSON.stringify({ auto_update_rollback_tombstoned_at: new Date().toISOString(), rollback_decision_id: decisionId })]
    );
    const oldEvent = await appendLifecycleArtifacts(client, schema, {
      memoryId: oldId,
      requestId: old.request_id,
      eventType: OutboxEventType.MemoryLifecycleChanged,
      actorId: "memory:auto-update",
      payload: { action: "auto_update_rollback_restore_old", decision_id: decisionId } as JsonObject,
    });
    const newEvent = await appendLifecycleArtifacts(client, schema, {
      memoryId: newIdValue,
      requestId: newer.request_id,
      eventType: OutboxEventType.MemoryTombstoned,
      actorId: "memory:auto-update",
      payload: { action: "auto_update_rollback_tombstone_new", decision_id: decisionId, memoryId: newIdValue } as JsonObject,
    });
    const cacheRequestId = await enqueueCacheInvalidation(client, schema, String(action.scope_type ?? old.scope_type), String(action.scope_id ?? old.scope_id), "auto_update_rollback");
    await client.query(
      `UPDATE ${schema}.memory_governance_actions
       SET status = 'reverted', reverted_at = now(), evidence = evidence || $2::jsonb, outbox_event_ids = $3::jsonb
       WHERE id = $1`,
      [decisionId, JSON.stringify({ rollback: { at: new Date().toISOString(), cache_invalidation_request_id: cacheRequestId, verified: true } }), JSON.stringify([oldEvent.outboxEventId, newEvent.outboxEventId])]
    );
    await client.query("COMMIT");
    return {
      ok: true,
      decision_id: decisionId,
      old_memory_id: oldId,
      new_memory_id: newIdValue,
      rollback_verified: true,
      outbox_event_ids: [oldEvent.outboxEventId, newEvent.outboxEventId],
      cache_invalidation_request_id: cacheRequestId,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query(
      `INSERT INTO ${schema}.memory_governance_actions (
         id, action_type, scope_type, scope_id, memory_id, related_memory_id, selector, evidence, before_state, after_state,
         outbox_event_ids, status, created_by, created_at
       )
       VALUES ($1, 'auto_update_rollback', $2, $3, $4, $5, $6::jsonb, $7::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 'failed', 'memory:auto-update', now())`,
      [newId("auto_update_rollback"), action.scope_type ?? null, action.scope_id ?? null, newIdValue, oldId, JSON.stringify({ decision_id: decisionId }), JSON.stringify({ error: error instanceof Error ? error.message : String(error) })]
    ).catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const cmd = command();
  await requireCliPermission(cmd === "apply" || cmd === "rollback" ? "memory:governance_apply" : "memory:governance_read");
  const config = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(config.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(config));
  const client = await pool.connect();
  try {
    if (cmd === "explain") {
      const candidateId = arg("candidate-id");
      if (!candidateId) throw new Error("--candidate-id is required");
      const rows = await client.query(
        `
          SELECT id, scope_type, scope_id, memory_type, title, content, metadata,
                 COALESCE(agent_id, metadata->>'agent_id', created_by, 'unknown') AS agent_id,
                 COALESCE(metadata->>'source', '') AS source,
                 COALESCE(metadata->>'conflict_action', metadata->'semantic_dedup'->>'action', 'create') AS conflict_action,
                 COALESCE(metadata->>'existing_memory_id', metadata->'semantic_dedup'->>'existing_memory_id') AS existing_memory_id,
                 COALESCE((metadata->'quality_gate'->>'score')::float, (metadata->>'quality_score')::float, 0.9) AS quality_score,
                 COALESCE((metadata->>'confidence')::float, 0.9) AS confidence
          FROM ${schema}.memory_records
          WHERE id = $1
          LIMIT 1
        `,
        [candidateId]
      );
      const row = rows.rows[0];
      if (!row) throw new Error(`candidate not found: ${candidateId}`);
      const result = evaluateAutoUpdatePolicy({
        candidateId: row.id,
        existingMemoryId: readString(row.existing_memory_id, ""),
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        memoryType: row.memory_type,
        operation: readString(row.conflict_action, "create"),
        conflictAction: readString(row.conflict_action, "create"),
        content: row.content,
        confidence: numberValue(row.confidence, 0),
        qualityScore: numberValue(row.quality_score, 0),
        agentId: row.agent_id,
        source: row.source,
        metadata: readObject(row.metadata),
      });
      process.stdout.write(JSON.stringify({ ok: true, candidate_id: candidateId, result }, null, 2) + "\n");
      return;
    }

    if (cmd === "dry-run") {
      const scope = parseScope(arg("scope") || "project:memory-xx");
      const limit = Math.max(1, Math.min(200, Number.parseInt(arg("limit") || "100", 10) || 100));
      const rows = await client.query(
        `
          SELECT id, scope_type, scope_id, memory_type, title, content, metadata,
                 COALESCE(agent_id, metadata->>'agent_id', created_by, 'unknown') AS agent_id,
                 COALESCE(metadata->>'source', '') AS source,
                 COALESCE(metadata->>'conflict_action', metadata->'semantic_dedup'->>'action', 'create') AS conflict_action,
                 COALESCE(metadata->>'existing_memory_id', metadata->'semantic_dedup'->>'existing_memory_id') AS existing_memory_id,
                 COALESCE((metadata->'quality_gate'->>'score')::float, (metadata->>'quality_score')::float, 0.9) AS quality_score,
                 COALESCE((metadata->>'confidence')::float, 0.9) AS confidence
          FROM ${schema}.memory_records
          WHERE lifecycle_status = 'candidate'
            AND review_state = 'pending'
            AND scope_type = $1
            AND scope_id = $2
          ORDER BY updated_at DESC
          LIMIT $3
        `,
        [scope.scopeType, scope.scopeId, limit]
      );
      const results = rows.rows.map((row) => ({
        candidate_id: row.id,
        title: row.title,
        conflict_action: row.conflict_action,
        existing_memory_id: row.existing_memory_id,
        ...evaluateAutoUpdatePolicy({
          candidateId: row.id,
          existingMemoryId: readString(row.existing_memory_id, ""),
          scopeType: row.scope_type,
          scopeId: row.scope_id,
          memoryType: row.memory_type,
          operation: readString(row.conflict_action, "create"),
          conflictAction: readString(row.conflict_action, "create"),
          content: row.content,
          confidence: numberValue(row.confidence, 0),
          qualityScore: numberValue(row.quality_score, 0),
          agentId: row.agent_id,
          source: row.source,
          metadata: readObject(row.metadata),
        }),
      }));
      process.stdout.write(JSON.stringify({
        ok: true,
        dry_run: true,
        scope: scope.key,
        candidate_count: results.length,
        action_counts: results.reduce<Record<string, number>>((acc, item) => {
          acc[item.decision] = (acc[item.decision] ?? 0) + 1;
          return acc;
        }, {}),
        results,
      }, null, 2) + "\n");
      return;
    }
    if (cmd === "apply") {
      const scope = parseScope(arg("scope") || "");
      const result = await applyUpdate(client, schema, scope);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    if (cmd === "rollback") {
      const result = await rollbackUpdate(client, schema);
      if (!hasFlag("dry-run")) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }

    throw new Error("用法：memory:auto-update <dry-run|explain|apply|rollback>");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
