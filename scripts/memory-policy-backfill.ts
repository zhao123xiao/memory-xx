#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { config } from "./test-harness/config.js";
import { closePool, createPool, query } from "./test-harness/lib/db-helpers.js";
import {
  buildBackfillGovernanceAction,
  buildBackfillMetadata,
  isBackfillAlreadyApplied,
  planPendingPolicyBackfill,
  type PendingPolicyBackfillItem,
  type PendingPolicyBackfillRow,
} from "../app/governance/memory-policy-backfill";
import type { JsonObject } from "../app/shared";

function parseArgs(argv: readonly string[]): { apply: boolean; json: boolean; limit: number } {
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number.parseInt(limitArg.split("=")[1] ?? "", 10) : 200;
  return {
    apply: argv.includes("--apply"),
    json: argv.includes("--json"),
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200,
  };
}

function byId(planItems: readonly PendingPolicyBackfillItem[]): Map<string, PendingPolicyBackfillItem> {
  return new Map(planItems.map((item) => [item.id, item]));
}

async function countPendingCandidates(pool: ReturnType<typeof createPool>): Promise<number> {
  const result = await query(pool,
    `SELECT count(*)::int AS count
       FROM ${config.dbSchema}.memory_records
      WHERE is_current = true
        AND lifecycle_status = 'candidate'
        AND review_state = 'pending'`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function recordGovernanceBackfillAction(
  pool: ReturnType<typeof createPool>,
  action: ReturnType<typeof buildBackfillGovernanceAction>,
): Promise<void> {
  await query(pool,
    `INSERT INTO ${config.dbSchema}.memory_governance_actions (
       id, action_type, scope_type, scope_id, memory_id, selector, evidence,
       before_state, after_state, outbox_event_ids, status, created_by, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, '[]'::jsonb, $10, $11, now())`,
    [
      randomUUID(),
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = createPool();
  try {
    const beforePendingCandidateCount = await countPendingCandidates(pool);
    const rowsResult = await query(pool,
      `SELECT id, scope_type, scope_id, title, content, memory_type, metadata, created_by
         FROM ${config.dbSchema}.memory_records
        WHERE is_current = true
          AND lifecycle_status = 'candidate'
          AND review_state = 'pending'
        ORDER BY created_at ASC
        LIMIT $1`,
      [args.limit],
    );
    const rows = rowsResult.rows.map((row) => ({
      id: String(row.id),
      scope_type: String(row.scope_type),
      scope_id: String(row.scope_id),
      title: row.title === null || row.title === undefined ? null : String(row.title),
      content: String(row.content ?? ""),
      memory_type: row.memory_type === null || row.memory_type === undefined ? null : String(row.memory_type),
      metadata: (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as JsonObject,
      created_by: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
    } satisfies PendingPolicyBackfillRow));
    const plan = planPendingPolicyBackfill(rows);
    const applied: Record<string, string[]> = {
      rejected: [],
      quarantined: [],
      marked_test_only: [],
      marked_audit_only: [],
      skipped_already_applied: [],
    };
    const backfillRunId = `policy-backfill-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
    const appliedAt = new Date().toISOString();

    if (args.apply) {
      const rowById = new Map(rows.map((row) => [row.id, row]));
      const rejectItems = byId(plan.groups.would_reject_by_policy);
      for (const [id, item] of rejectItems) {
        const row = rowById.get(id);
        if (!row) continue;
        if (isBackfillAlreadyApplied(row.metadata, item)) {
          applied.skipped_already_applied.push(id);
          continue;
        }
        const metadata = buildBackfillMetadata(row.metadata, item, { runId: backfillRunId, appliedAt });
        const beforeState: JsonObject = {
          lifecycle_status: "candidate",
          review_state: "pending",
          is_current: true,
          metadata: row.metadata,
        };
        const afterState: JsonObject = {
          lifecycle_status: "rejected",
          review_state: "rejected",
          is_current: false,
          recall_policy: item.recall_policy,
          memory_class: item.memory_class,
          policy_action: item.policy_action,
          metadata,
        };
        await query(pool,
          `UPDATE ${config.dbSchema}.memory_records
              SET lifecycle_status = 'rejected',
                  review_state = 'rejected',
                  is_current = false,
                  metadata = $2::jsonb,
                  updated_at = now(),
                  invalid_at = COALESCE(invalid_at, now())
            WHERE id = $1`,
          [id, JSON.stringify(metadata)],
        );
        await recordGovernanceBackfillAction(pool, buildBackfillGovernanceAction({
          runId: backfillRunId,
          row,
          item,
          beforeState,
          afterState,
        }));
        applied.rejected.push(id);
      }

      const metadataOnlyGroups: Array<[keyof typeof applied, readonly PendingPolicyBackfillItem[]]> = [
        ["quarantined", plan.groups.would_quarantine],
        ["marked_test_only", plan.groups.would_mark_test_only],
        ["marked_audit_only", plan.groups.would_mark_audit_only],
      ];
      for (const [bucket, items] of metadataOnlyGroups) {
        for (const item of items) {
          const row = rowById.get(item.id);
          if (!row) continue;
          if (isBackfillAlreadyApplied(row.metadata, item)) {
            applied.skipped_already_applied.push(item.id);
            continue;
          }
          const metadata = buildBackfillMetadata(row.metadata, item, { runId: backfillRunId, appliedAt });
          const beforeState: JsonObject = {
            lifecycle_status: "candidate",
            review_state: "pending",
            is_current: true,
            metadata: row.metadata,
          };
          const afterState: JsonObject = {
            lifecycle_status: "candidate",
            review_state: "pending",
            is_current: true,
            recall_policy: item.recall_policy,
            memory_class: item.memory_class,
            policy_action: item.policy_action,
            metadata,
          };
          await query(pool,
            `UPDATE ${config.dbSchema}.memory_records
                SET metadata = $2::jsonb,
                    updated_at = now()
              WHERE id = $1`,
            [item.id, JSON.stringify(metadata)],
          );
          await recordGovernanceBackfillAction(pool, buildBackfillGovernanceAction({
            runId: backfillRunId,
            row,
            item,
            beforeState,
            afterState,
          }));
          applied[bucket].push(item.id);
        }
      }
    }
    const afterPendingCandidateCount = await countPendingCandidates(pool);

    const result = {
      ok: true,
      mode: args.apply ? "apply" : "dry_run",
      schema: config.dbSchema,
      backfill_run_id: args.apply ? backfillRunId : null,
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
      process.stdout.write(`memory policy backfill ${result.mode}: ${JSON.stringify(plan.summary)}\n`);
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
