#!/usr/bin/env tsx
import { config } from "./test-harness/config.js";
import { closePool, createPool, query } from "./test-harness/lib/db-helpers.js";
import { buildMemoryPolicyReport, type MemoryPolicyDecisionFact } from "../app/governance/memory-policy-report";

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const compareWindowHours = 24;
  const pool = createPool();
  try {
    const decisionsResult = await query(pool,
      `SELECT *
         FROM (
           SELECT created_at AS decided_at,
                  COALESCE(metadata->>'memory_class', metadata->'memory_policy'->>'memory_class') AS memory_class,
                  COALESCE(metadata->>'policy_action', metadata->'memory_policy'->>'policy_action') AS policy_action,
                  COALESCE(metadata->>'recall_policy', metadata->'memory_policy'->>'recall_policy') AS recall_policy,
                  COALESCE(metadata->>'autonomous_action', metadata->'memory_policy'->>'autonomous_action') AS autonomous_action,
                  (COALESCE(metadata->>'memory_class', metadata->'memory_policy'->>'memory_class') IS NOT NULL
                    OR COALESCE(metadata->>'policy_action', metadata->'memory_policy'->>'policy_action') IS NOT NULL
                    OR COALESCE(metadata->>'recall_policy', metadata->'memory_policy'->>'recall_policy') IS NOT NULL) AS has_policy_fields,
                  (COALESCE(metadata->>'memory_class', metadata->'memory_policy'->>'memory_class') IS NULL
                    AND COALESCE(metadata->>'policy_action', metadata->'memory_policy'->>'policy_action') IS NULL
                    AND COALESCE(metadata->>'recall_policy', metadata->'memory_policy'->>'recall_policy') IS NULL) AS legacy,
                  metadata->>'source' AS source
             FROM ${config.dbSchema}.auto_approval_decisions
            WHERE created_at >= now() - interval '7 days'
           UNION ALL
           SELECT created_at AS decided_at,
                  evidence->>'memory_class' AS memory_class,
                  evidence->>'policy_action' AS policy_action,
                  evidence->>'recall_policy' AS recall_policy,
                  evidence->>'autonomous_action' AS autonomous_action,
                  true AS has_policy_fields,
                  false AS legacy,
                  selector->>'source' AS source
             FROM ${config.dbSchema}.memory_governance_actions
            WHERE created_at >= now() - interval '7 days'
              AND action_type IN ('memory_policy_backfill', 'memory_auto_approval_sweep')
           UNION ALL
           SELECT created_at AS decided_at,
                  COALESCE(
                    metadata->>'memory_class',
                    metadata->'memory_policy_backfill'->>'memory_class',
                    metadata->'memory_auto_approval_sweep'->>'memory_class',
                    metadata->'auto_approval_policy'->'memory_policy'->>'memory_class'
                  ) AS memory_class,
                  COALESCE(
                    metadata->>'policy_action',
                    metadata->'memory_policy_backfill'->>'policy_action',
                    metadata->'memory_policy'->>'policy_action',
                    metadata->'auto_approval_policy'->'memory_policy'->>'policy_action'
                  ) AS policy_action,
                  COALESCE(
                    metadata->>'recall_policy',
                    metadata->'memory_policy_backfill'->>'recall_policy',
                    metadata->'memory_auto_approval_sweep'->>'recall_policy',
                    metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy'
                  ) AS recall_policy,
                  COALESCE(
                    metadata->>'autonomous_action',
                    metadata->'memory_auto_approval_sweep'->>'autonomous_action',
                    metadata->'memory_policy'->>'autonomous_action'
                  ) AS autonomous_action,
                  true AS has_policy_fields,
                  false AS legacy,
                  metadata->>'source' AS source
             FROM ${config.dbSchema}.memory_records
            WHERE created_at >= now() - interval '7 days'
              AND metadata->'memory_policy_backfill' IS NULL
              AND metadata->'memory_auto_approval_sweep' IS NULL
              AND COALESCE(
                metadata->>'memory_class',
                metadata->'memory_policy_backfill'->>'memory_class',
                metadata->'memory_auto_approval_sweep'->>'memory_class',
                metadata->'auto_approval_policy'->'memory_policy'->>'memory_class'
              ) IS NOT NULL
         ) policy_facts
        ORDER BY decided_at DESC
        LIMIT 10000`,
    );
    const compareResult = await query(pool,
      `SELECT count(*)::int AS count,
              max(observed_at) AS latest_observed_at
         FROM ${config.dbSchema}.intelligence_compare_observations
        WHERE observed_at >= now() - ($1::int * interval '1 hour')`,
      [compareWindowHours],
    ).catch(() => ({ rows: [{ count: 0, latest_observed_at: null }] }));

    const report = buildMemoryPolicyReport({
      decisions: decisionsResult.rows.map((row) => ({
        decided_at: new Date(row.decided_at).toISOString(),
        memory_class: row.memory_class ?? null,
        policy_action: row.policy_action ?? null,
        recall_policy: row.recall_policy ?? null,
        autonomous_action: row.autonomous_action ?? null,
        has_policy_fields: row.has_policy_fields === true,
        legacy: row.legacy === true,
        source: row.source ?? null,
      } satisfies MemoryPolicyDecisionFact)),
      compareObservationCount: Number(compareResult.rows[0]?.count ?? 0),
      latestCompareObservationAt: compareResult.rows[0]?.latest_observed_at
        ? new Date(compareResult.rows[0].latest_observed_at).toISOString()
        : null,
      compareWindowHours,
    });

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, schema: config.dbSchema, ...report }, null, 2)}\n`);
    } else {
      process.stdout.write(`memory policy report: ${JSON.stringify(report.windows)}\n`);
      if (report.compare_observations.status !== "ok") {
        process.stdout.write(`compare observations below minimum; run: ${report.compare_observations.recommended_command}\n`);
      }
    }
  } finally {
    await closePool(pool);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
