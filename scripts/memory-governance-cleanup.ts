import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { requireCliPermission } from "../app/server/permissions";
import { OutboxEventType } from "../app/shared";
import { argValue, hasArg, loadDotenvIfPresent, printJson, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

type TargetRow = {
  id: string;
  request_id: string;
  review_state: string;
  lifecycle_status: string;
  scope_type: string;
  scope_id: string;
};

async function main(): Promise<void> {
  const command = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "tombstone-pending";
  if (command !== "tombstone-pending") {
    throw new Error("usage: npm run memory:governance-cleanup -- tombstone-pending --dry-run|--apply");
  }
  const apply = hasArg("--apply");
  await requireCliPermission(apply ? "memory:governance_apply" : "memory:governance_read");
  const sampleLimit = Number.parseInt(argValue("--sample-limit") ?? "20", 10);
  const config = loadMemoryXXPostgresConfig();
  const schema = quoteIdent(config.schema);
  const pool = new Pool(createPostgresPoolConfig(config));
  const client = await pool.connect();
  const runId = randomUUID();
  try {
    const { rows } = await client.query<TargetRow>(
      `
        SELECT id, request_id, review_state, lifecycle_status, scope_type, scope_id
        FROM ${schema}.memory_records
        WHERE lifecycle_status = 'tombstone'
          AND review_state = 'pending'
        ORDER BY updated_at ASC
      `
    );
    const summary: Record<string, unknown> = {
      ok: true,
      command,
      apply,
      run_id: runId,
      target_count: rows.length,
      sample: rows.slice(0, Math.max(1, sampleLimit))
    };
    if (!apply) {
      printJson(summary);
      return;
    }

    await client.query("BEGIN");
    const now = new Date();
    for (const row of rows) {
      await client.query(
        `
          INSERT INTO ${schema}.memory_events (id, memory_id, request_id, event_type, actor_id, payload, created_at)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        `,
        [
          randomUUID(),
          row.id,
          `governance-cleanup:${runId}`,
          OutboxEventType.MemoryReviewChanged,
          "memory:governance-cleanup",
          JSON.stringify({
            reason: "tombstone_pending_review_state_normalization",
            previous_review_state: row.review_state,
            next_review_state: "rejected",
            lifecycle_status: row.lifecycle_status,
            scope_type: row.scope_type,
            scope_id: row.scope_id
          }),
          now
        ]
      );
    }
    const updated = await client.query(
      `
        UPDATE ${schema}.memory_records
        SET review_state = 'rejected',
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'review_state_normalized_from', 'pending',
              'review_state_normalized_by', 'memory:governance-cleanup',
              'review_state_normalized_at', $1::timestamptz::text
            ),
            updated_by = 'memory:governance-cleanup',
            updated_at = $1::timestamptz
        WHERE lifecycle_status = 'tombstone'
          AND review_state = 'pending'
      `,
      [now]
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
