import "./test-harness/config.js";
import { config } from "./test-harness/config.js";
import { closePool, createPool, query } from "./test-harness/lib/db-helpers.js";
import { GovernanceRepository, PostgresWriteDatabase, loadMemoryXXPostgresConfig, withWriteTransaction, type JsonObject } from "../app";
import { requireCliPermission } from "../app/server/permissions.js";

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

async function main(): Promise<void> {
  await requireCliPermission("memory:governance_read");
  const schema = quoteIdent(config.dbSchema);
  const pool = createPool();
  const database = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(process.env) });
  const governance = new GovernanceRepository();
  try {
    const run = await withWriteTransaction(database, (tx) => governance.tryBeginRun(tx, {
      jobType: "governance_consistency_audit",
      mode: "report-only",
      policy: "audit",
    }));
    if (run.status === "skipped_lock_held") {
      process.stdout.write(JSON.stringify({ ok: false, governance_run: run, error: "governance lock already held" }, null, 2) + "\n");
      return;
    }

    const approvedCurrent = await query(pool, `
      SELECT count(*)::int AS total
      FROM ${schema}.memory_records
      WHERE lifecycle_status = 'approved'
        AND is_current IS TRUE
        AND review_state IN ('approved', 'silent_approved', 'not_required')
    `);

    const orphanTickets = await query(pool, `
      SELECT wt.id, wt.created_memory_id, wt.candidate_memory_id, wt.duplicate_of_memory_id, wt.terminal_at
      FROM ${schema}.write_tickets wt
      LEFT JOIN ${schema}.memory_records mr
        ON mr.id = COALESCE(wt.created_memory_id, wt.candidate_memory_id, wt.duplicate_of_memory_id)
      WHERE wt.status IN ('completed', 'needs_review', 'skipped_duplicate')
        AND COALESCE(wt.created_memory_id, wt.candidate_memory_id, wt.duplicate_of_memory_id) IS NOT NULL
        AND mr.id IS NULL
      ORDER BY wt.terminal_at DESC NULLS LAST
      LIMIT 50
    `);

    const urgentFalseNull = await query(pool, `
      SELECT id, query_hash, recall_trace_id, count, urgency, root_cause_type, root_cause, suggested_action
      FROM ${schema}.recall_repair_queue
      WHERE issue_type = 'false_null'
        AND status IN ('open', 'suggested')
        AND (count >= 5 OR urgency IN ('P0', 'P1'))
      ORDER BY count DESC, updated_at DESC
      LIMIT 50
    `);

    const silentCohorts = await query(pool, `
      WITH silent AS (
        SELECT
          COALESCE(agent_id, metadata->>'agent_id', created_by, 'unknown') AS agent_id,
          scope_type,
          COALESCE(memory_type, metadata->>'memory_type', 'unknown') AS memory_type,
          COALESCE(metadata->>'source', 'unknown') AS source,
          id
        FROM ${schema}.memory_records
        WHERE review_state = 'silent_approved'
          AND created_at <= now() - interval '24 hours'
      ),
      feedback AS (
        SELECT memory_id,
          count(*) FILTER (WHERE feedback_type IN ('wrong', 'deleted', 'not_relevant'))::int AS fp,
          count(*) FILTER (WHERE feedback_type IN ('confirmed', 'used'))::int AS adopted
        FROM ${schema}.memory_feedback_events
        GROUP BY memory_id
      )
      SELECT
        s.agent_id,
        s.scope_type,
        s.memory_type,
        s.source,
        count(*)::int AS sample_size,
        COALESCE(sum(f.fp), 0)::int AS false_positive_count,
        COALESCE(sum(f.adopted), 0)::int AS adoption_count,
        CASE WHEN count(*) = 0 THEN 0 ELSE COALESCE(sum(f.fp), 0)::float / count(*) END AS false_positive_rate,
        CASE WHEN count(*) = 0 THEN 0 ELSE COALESCE(sum(f.adopted), 0)::float / count(*) END AS adoption_rate
      FROM silent s
      LEFT JOIN feedback f ON f.memory_id = s.id
      GROUP BY 1,2,3,4
      HAVING count(*) >= 20
      ORDER BY false_positive_rate DESC, sample_size DESC
      LIMIT 50
    `);

    const expiringOverrides = await query(pool, `
      SELECT id, selector_hash, selector, policy_type, threshold, default_threshold, expires_at
      FROM ${schema}.governance_policy_overrides
      WHERE expires_at <= now()
        AND reviewed_at IS NULL
      ORDER BY expires_at ASC
      LIMIT 50
    `);

    await withWriteTransaction(database, async (tx) => {
      for (const row of orphanTickets.rows) {
        await governance.recordAction(tx, {
          runId: run.id,
          actionType: "orphan_write_ticket_detected",
          selector: { ticket_id: row.id } as JsonObject,
          evidence: row as JsonObject,
          status: "reported",
        });
      }
      for (const row of urgentFalseNull.rows) {
        await governance.recordAction(tx, {
          runId: run.id,
          actionType: "recall_false_null_urgent",
          selector: { query_hash: row.query_hash } as JsonObject,
          evidence: row as JsonObject,
          status: "reported",
        });
      }
      for (const row of expiringOverrides.rows) {
        await governance.recordAction(tx, {
          runId: run.id,
          actionType: "policy_override_expiring_review_required",
          selector: row.selector as JsonObject,
          evidence: {
            selector_hash: row.selector_hash,
            policy_type: row.policy_type,
            threshold: row.threshold,
            default_threshold: row.default_threshold,
            expires_at: row.expires_at,
            latest_stats: silentCohorts.rows.find((cohort) => JSON.stringify(row.selector ?? {}).includes(cohort.scope_type)) ?? null,
          } as JsonObject,
          status: "reported",
        });
      }
      await governance.finishRun(tx, run.id, "success", {
        approved_current: approvedCurrent.rows[0]?.total ?? 0,
        orphan_tickets: orphanTickets.rows.length,
        urgent_false_nulls: urgentFalseNull.rows.length,
        silent_cohorts: silentCohorts.rows.length,
        expiring_overrides: expiringOverrides.rows.length,
      });
    });

    process.stdout.write(JSON.stringify({
      ok: true,
      governance_run_id: run.id,
      checked_at: new Date().toISOString(),
      approved_current: approvedCurrent.rows[0],
      orphan_tickets: orphanTickets.rows,
      urgent_false_null: urgentFalseNull.rows,
      silent_approved_cohorts: silentCohorts.rows,
      expiring_overrides_requiring_review: expiringOverrides.rows,
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await closePool(pool);
    await database.close();
  }
}

void main();
