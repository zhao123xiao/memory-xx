import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { requireCliPermission } from "../app/server/permissions";
import { argValue, hasArg, loadDotenvIfPresent, printJson, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

async function main(): Promise<void> {
  const apply = hasArg("--apply");
  await requireCliPermission(apply ? "memory:governance_apply" : "memory:governance_read");
  const successDays = Number.parseInt(argValue("--success-days") ?? process.env.MEMORY_XX_TRACE_RETENTION_SUCCESS_DAYS ?? "14", 10);
  const protectedDays = Number.parseInt(argValue("--protected-days") ?? process.env.MEMORY_XX_TRACE_RETENTION_PROTECTED_DAYS ?? "90", 10);
  const limit = Number.parseInt(argValue("--limit") ?? process.env.MEMORY_XX_TRACE_RETENTION_LIMIT ?? "1000", 10);
  const config = loadMemoryXXPostgresConfig();
  const schema = quoteIdent(config.schema);
  const pool = new Pool(createPostgresPoolConfig(config));
  const client = await pool.connect();
  try {
    const summary = await client.query(
      `
        WITH trace_flags AS (
          SELECT t.id, t.created_at, t.degrade_level,
            EXISTS (SELECT 1 FROM ${schema}.recall_feedback_events f WHERE f.recall_trace_id = t.id) AS has_feedback
          FROM ${schema}.recall_traces t
        )
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE degrade_level = 0 AND NOT has_feedback AND created_at < now() - ($1::int * interval '1 day'))::int AS ordinary_delete_eligible,
          count(*) FILTER (WHERE (degrade_level > 0 OR has_feedback) AND created_at < now() - ($2::int * interval '1 day'))::int AS protected_old,
          min(created_at)::text AS oldest_created_at
        FROM trace_flags
      `,
      [successDays, protectedDays]
    );
    const candidates = await client.query<{ id: string; created_at: string; query_excerpt: string }>(
      `
        SELECT t.id, t.created_at::text, t.query_excerpt
        FROM ${schema}.recall_traces t
        WHERE t.degrade_level = 0
          AND NOT EXISTS (SELECT 1 FROM ${schema}.recall_feedback_events f WHERE f.recall_trace_id = t.id)
          AND t.created_at < now() - ($1::int * interval '1 day')
        ORDER BY t.created_at ASC
        LIMIT $2
      `,
      [successDays, limit]
    );
    const payload: Record<string, unknown> = {
      ok: true,
      apply,
      success_retention_days: successDays,
      protected_retention_days: protectedDays,
      limit,
      summary: summary.rows[0],
      candidate_count: candidates.rows.length,
      sample: candidates.rows.slice(0, 20)
    };
    const reportDir = join(process.cwd(), "reports", "trace-retention");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    await writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    payload.report_path = reportPath;
    if (!apply) {
      printJson(payload);
      return;
    }
    await client.query("BEGIN");
    const deleted = await client.query(
      `
        DELETE FROM ${schema}.recall_traces
        WHERE id = ANY($1::text[])
      `,
      [candidates.rows.map((row) => row.id)]
    );
    await client.query("COMMIT");
    payload.deleted = deleted.rowCount ?? 0;
    printJson(payload);
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
