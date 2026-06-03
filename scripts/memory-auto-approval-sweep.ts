#!/usr/bin/env tsx
import { createHash, randomUUID } from "node:crypto";
import { config } from "./test-harness/config.js";
import { closePool, createPool, query } from "./test-harness/lib/db-helpers.js";
import {
  buildAutonomousClosureGovernanceAction,
  buildAutonomousClosureMetadata,
  isAutonomousClosureAlreadyApplied,
  planAutonomousPendingClosure,
  type PendingAutonomousClosureItem,
  type PendingAutonomousClosureRow,
} from "../app/governance/memory-auto-approval-sweep";
import { mapMemoryIdToQdrantPointId } from "../app/qdrant-sync/projector";
import { OutboxEventType, type JsonObject } from "../app/shared";
import { quoteIdent } from "./lib/runtime-env";

interface SweepRow extends PendingAutonomousClosureRow {
  readonly request_id: string;
  readonly lifecycle_status: string;
  readonly review_state: string;
  readonly is_current: boolean;
}

interface Args {
  readonly apply: boolean;
  readonly json: boolean;
  readonly limit: number;
}

function parseArgs(argv: readonly string[]): Args {
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number.parseInt(limitArg.split("=")[1] ?? "", 10) : 200;
  return {
    apply: argv.includes("--apply"),
    json: argv.includes("--json"),
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200,
  };
}

function byId(items: readonly PendingAutonomousClosureItem[]): Map<string, PendingAutonomousClosureItem> {
  return new Map(items.map((item) => [item.id, item]));
}

function allActionItems(plan: ReturnType<typeof planAutonomousPendingClosure>): readonly PendingAutonomousClosureItem[] {
  return [
    ...plan.groups.would_approve_default,
    ...plan.groups.would_approve_explicit_issue,
    ...plan.groups.would_reject_closed,
    ...plan.groups.would_reject_sensitive,
    ...plan.groups.would_reject_test_noise,
    ...plan.groups.would_reject_unknown_source,
    ...plan.groups.would_event_log_only,
  ];
}

async function countPendingCandidates(pool: ReturnType<typeof createPool>, schema: string): Promise<number> {
  const result = await query(pool,
    `SELECT count(*)::int AS count
       FROM ${schema}.memory_records
      WHERE is_current = true
        AND lifecycle_status = 'candidate'
        AND review_state = 'pending'`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function recordGovernanceAction(
  client: import("pg").PoolClient,
  schema: string,
  action: ReturnType<typeof buildAutonomousClosureGovernanceAction>,
): Promise<void> {
  await client.query(
    `INSERT INTO ${schema}.memory_governance_actions (
       id, action_type, scope_type, scope_id, memory_id, selector, evidence,
       before_state, after_state, outbox_event_ids, status, created_by, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, '[]'::jsonb, $10, $11, now())`,
    [
      `governance_action_${randomUUID()}`,
      action.actionType,
      action.scopeType,
      action.scopeId,
      action.memoryId,
      JSON.stringify(action.selector),
      JSON.stringify(action.evidence),
      JSON.stringify(action.beforeState),
      JSON.stringify(action.afterState),
      action.status,
      action.createdBy,
    ],
  );
}

function projectionPayload(row: SweepRow, item: PendingAutonomousClosureItem): JsonObject {
  const contentSignature = createHash("sha256").update(row.content).digest("hex");
  return {
    memoryId: row.id,
    requestId: row.request_id,
    write_idempotency_key: row.request_id,
    content_signature: contentSignature,
    projection_hash: null,
    target_point_id: mapMemoryIdToQdrantPointId(row.id),
    previousLifecycleStatus: row.lifecycle_status,
    lifecycleStatus: "approved",
    previousReviewState: row.review_state,
    reviewState: "silent_approved",
    previousIsCurrent: row.is_current,
    isCurrent: true,
    sourceCount: 0,
    relationCount: 0,
    autonomous_action: item.autonomous_action,
    recall_policy: item.recall_policy,
    memory_class: item.memory_class,
  };
}

async function appendApprovalProjectionEvent(
  client: import("pg").PoolClient,
  schema: string,
  row: SweepRow,
  item: PendingAutonomousClosureItem,
): Promise<{ memoryEventId: string; outboxEventId: string }> {
  const memoryEventId = `memory_event_${randomUUID()}`;
  const outboxEventId = `outbox_event_${randomUUID()}`;
  const payload = projectionPayload(row, item);
  await client.query(
    `INSERT INTO ${schema}.memory_events (id, memory_id, request_id, event_type, actor_id, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())`,
    [memoryEventId, row.id, row.request_id, OutboxEventType.MemoryLifecycleChanged, "memory-xx-auto-approval-sweep", JSON.stringify(payload)],
  );
  await client.query(
    `INSERT INTO ${schema}.outbox_events (
       id, aggregate_id, request_id, event_type, payload, payload_version, dispatch_status, attempts, created_at, dispatched_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, 1, 'pending', 0, now(), NULL)`,
    [outboxEventId, row.id, row.request_id, OutboxEventType.MemoryLifecycleChanged, JSON.stringify(payload)],
  );
  return { memoryEventId, outboxEventId };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = createPool();
  const schema = quoteIdent(config.dbSchema);
  try {
    const beforePendingCandidateCount = await countPendingCandidates(pool, schema);
    const rowsResult = await query(pool,
      `SELECT id, request_id, scope_type, scope_id, title, content, memory_type, metadata,
              created_by, lifecycle_status, review_state, is_current
         FROM ${schema}.memory_records
        WHERE is_current = true
          AND lifecycle_status = 'candidate'
          AND review_state = 'pending'
        ORDER BY created_at ASC
        LIMIT $1`,
      [args.limit],
    );
    const rows = rowsResult.rows.map((record) => ({
      id: String(record.id),
      request_id: String(record.request_id),
      scope_type: String(record.scope_type),
      scope_id: String(record.scope_id),
      title: record.title === null || record.title === undefined ? null : String(record.title),
      content: String(record.content ?? ""),
      memory_type: record.memory_type === null || record.memory_type === undefined ? null : String(record.memory_type),
      metadata: (record.metadata && typeof record.metadata === "object" ? record.metadata : {}) as JsonObject,
      created_by: record.created_by === null || record.created_by === undefined ? null : String(record.created_by),
      lifecycle_status: String(record.lifecycle_status),
      review_state: String(record.review_state),
      is_current: Boolean(record.is_current),
    } satisfies SweepRow));
    const plan = planAutonomousPendingClosure(rows);
    const applied = {
      approved_default: [] as string[],
      approved_explicit_issue: [] as string[],
      rejected_closed: [] as string[],
      rejected_sensitive: [] as string[],
      rejected_test_noise: [] as string[],
      rejected_unknown_source: [] as string[],
      event_log_only: [] as string[],
      skipped_already_closed: [] as string[],
      kept_pending: plan.groups.would_keep_pending.map((item) => item.id),
    };
    const sweepRunId = `auto-approval-sweep-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
    const appliedAt = new Date().toISOString();

    if (args.apply && rows.length === 0) {
      const skippedResult = await query(pool,
        `SELECT id
           FROM ${schema}.memory_records
          WHERE metadata->'memory_auto_approval_sweep' IS NOT NULL
            AND lifecycle_status IN ('approved', 'rejected')
          ORDER BY updated_at DESC
          LIMIT $1`,
        [args.limit],
      );
      applied.skipped_already_closed.push(...skippedResult.rows.map((row) => String(row.id)));
    }

    if (args.apply) {
      const rowById = new Map(rows.map((row) => [row.id, row]));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const item of allActionItems(plan)) {
          const row = rowById.get(item.id);
          if (!row) continue;
          if (isAutonomousClosureAlreadyApplied(row.metadata, item)) {
            applied.skipped_already_closed.push(item.id);
            continue;
          }
          const metadata = buildAutonomousClosureMetadata(row.metadata, item, { runId: sweepRunId, appliedAt });
          const beforeState: JsonObject = {
            lifecycle_status: row.lifecycle_status,
            review_state: row.review_state,
            is_current: row.is_current,
            metadata: row.metadata,
          };

          if (item.autonomous_action === "approve_default" || item.autonomous_action === "approve_explicit_issue") {
            const afterState: JsonObject = {
              lifecycle_status: "approved",
              review_state: "silent_approved",
              is_current: true,
              recall_policy: item.recall_policy,
              memory_class: item.memory_class,
              autonomous_action: item.autonomous_action,
              metadata,
            };
            await client.query(
              `UPDATE ${schema}.memory_records
                  SET lifecycle_status = 'approved',
                      review_state = 'silent_approved',
                      is_current = true,
                      metadata = $2::jsonb,
                      updated_by = 'memory-xx-auto-approval-sweep',
                      updated_at = now()
                WHERE id = $1
                  AND lifecycle_status = 'candidate'
                  AND review_state = 'pending'
                  AND is_current = true`,
              [item.id, JSON.stringify(metadata)],
            );
            const eventIds = await appendApprovalProjectionEvent(client, schema, row, item);
            await recordGovernanceAction(client, schema, buildAutonomousClosureGovernanceAction({
              runId: sweepRunId,
              row,
              item,
              beforeState,
              afterState: { ...afterState, ...eventIds },
            }));
            if (item.autonomous_action === "approve_default") applied.approved_default.push(item.id);
            else applied.approved_explicit_issue.push(item.id);
          } else {
            const afterState: JsonObject = {
              lifecycle_status: "rejected",
              review_state: "rejected",
              is_current: false,
              recall_policy: item.recall_policy,
              memory_class: item.memory_class,
              autonomous_action: item.autonomous_action,
              metadata,
            };
            await client.query(
              `UPDATE ${schema}.memory_records
                  SET lifecycle_status = 'rejected',
                      review_state = 'rejected',
                      is_current = false,
                      metadata = $2::jsonb,
                      updated_by = 'memory-xx-auto-approval-sweep',
                      updated_at = now(),
                      invalid_at = COALESCE(invalid_at, now())
                WHERE id = $1
                  AND lifecycle_status = 'candidate'
                  AND review_state = 'pending'
                  AND is_current = true`,
              [item.id, JSON.stringify(metadata)],
            );
            await recordGovernanceAction(client, schema, buildAutonomousClosureGovernanceAction({
              runId: sweepRunId,
              row,
              item,
              beforeState,
              afterState,
            }));
            if (item.autonomous_action === "reject_closed") applied.rejected_closed.push(item.id);
            else if (item.autonomous_action === "reject_sensitive") applied.rejected_sensitive.push(item.id);
            else if (item.autonomous_action === "reject_test_noise") applied.rejected_test_noise.push(item.id);
            else if (item.autonomous_action === "reject_unknown_source") applied.rejected_unknown_source.push(item.id);
            else applied.event_log_only.push(item.id);
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    const afterPendingCandidateCount = await countPendingCandidates(pool, schema);
    const result = {
      ok: true,
      mode: args.apply ? "apply" : "dry_run",
      schema: config.dbSchema,
      sweep_run_id: args.apply ? sweepRunId : null,
      counts: {
        pending_candidates_before: beforePendingCandidateCount,
        pending_candidates_after: afterPendingCandidateCount,
      },
      ...plan,
      applied,
    };
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`memory auto-approval sweep ${result.mode}: ${JSON.stringify(plan.summary)}\n`);
      if (args.apply) process.stdout.write(`applied: ${JSON.stringify(applied)}\n`);
    }
  } finally {
    await closePool(pool);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
