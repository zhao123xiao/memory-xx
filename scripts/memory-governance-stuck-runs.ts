import { Pool } from "pg";
import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { requireCliPermission } from "../app/server/permissions";
import { argValue, hasArg, loadDotenvIfPresent, printJson, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

type StuckRun = {
  id: string;
  job_type: string;
  mode: string;
  status: string;
  started_at: string;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  lease_acquired_by: string | null;
};

async function main(): Promise<void> {
  const apply = hasArg("--apply");
  await requireCliPermission(apply ? "memory:governance_apply" : "memory:governance_read");
  const timeoutMinutes = Number.parseInt(argValue("--timeout-minutes") ?? process.env.MEMORY_XX_GOVERNANCE_STUCK_TIMEOUT_MINUTES ?? "30", 10);
  const config = loadMemoryXXPostgresConfig();
  const schema = quoteIdent(config.schema);
  const pool = new Pool(createPostgresPoolConfig(config));
  const client = await pool.connect();
  try {
    const { rows } = await client.query<StuckRun>(
      `
        SELECT id, job_type, mode, status, started_at::text, heartbeat_at::text, lease_expires_at::text, lease_acquired_by
        FROM ${schema}.memory_governance_runs
        WHERE status = 'running'
          AND (
            (lease_expires_at IS NOT NULL AND lease_expires_at < now())
            OR (heartbeat_at IS NOT NULL AND heartbeat_at < now() - ($1::int * interval '1 minute'))
            OR (heartbeat_at IS NULL AND started_at < now() - ($1::int * interval '1 minute'))
          )
        ORDER BY started_at ASC
      `,
      [timeoutMinutes]
    );
    const summary: Record<string, unknown> = {
      ok: true,
      apply,
      timeout_minutes: timeoutMinutes,
      stuck_count: rows.length,
      stuck_runs: rows
    };
    if (!apply) {
      printJson(summary);
      return;
    }
    await client.query("BEGIN");
    const updated = await client.query(
      `
        UPDATE ${schema}.memory_governance_runs
        SET status = 'failed',
            error = 'failed_timeout',
            metrics = COALESCE(metrics, '{}'::jsonb) || jsonb_build_object(
              'terminal_reason', 'failed_timeout',
              'stuck_detector_timeout_minutes', $1::int,
              'stuck_detector_applied_at', now()::text
            ),
            finished_at = now(),
            lease_acquired_by = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ANY($2::text[])
      `,
      [timeoutMinutes, rows.map((row) => row.id)]
    );
    await client.query("COMMIT");
    summary.updated = updated.rowCount ?? 0;
    printJson(summary);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
