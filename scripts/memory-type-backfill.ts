import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { inferLegacyMemoryType } from "../app/governance/maintenance-classifiers";
import { requireCliPermission } from "../app/server/permissions";
import { OutboxEventType, type JsonObject } from "../app/shared";
import { argValue, hasArg, loadDotenvIfPresent, printJson, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

type TargetRow = {
  id: string;
  title: string | null;
  content: string;
  metadata: JsonObject | null;
  scope_type: string;
  scope_id: string;
  created_at: string | Date;
  updated_at: string | Date;
};

async function main(): Promise<void> {
  const effectiveApprovedOnly = hasArg("--effective-approved") || !hasArg("--all");
  const apply = hasArg("--apply");
  await requireCliPermission(apply ? "memory:governance_apply" : "memory:governance_read");
  const sampleLimit = Number.parseInt(argValue("--sample-limit") ?? "20", 10);
  const config = loadMemoryXXPostgresConfig();
  const schema = quoteIdent(config.schema);
  const pool = new Pool(createPostgresPoolConfig(config));
  const client = await pool.connect();
  const runId = randomUUID();
  try {
    const where = effectiveApprovedOnly
      ? `lifecycle_status = 'approved' AND is_current IS TRUE AND review_state IN ('approved', 'silent_approved', 'not_required')`
      : `TRUE`;
    const { rows } = await client.query<TargetRow>(
      `
        SELECT id, title, content, metadata, scope_type, scope_id, created_at, updated_at
        FROM ${schema}.memory_records
        WHERE (${where})
          AND (memory_type IS NULL OR btrim(memory_type) = '')
        ORDER BY updated_at DESC
      `
    );
    const inferred = rows.map((row) => ({
      row,
      inference: inferLegacyMemoryType({ title: row.title, content: row.content, metadata: row.metadata ?? {} })
    }));
    const counts = inferred.reduce<Record<string, number>>((acc, item) => {
      acc[item.inference.memory_type] = (acc[item.inference.memory_type] ?? 0) + 1;
      return acc;
    }, {});
    const summary: Record<string, unknown> = {
      ok: true,
      apply,
      run_id: runId,
      effective_approved_only: effectiveApprovedOnly,
      target_count: inferred.length,
      inferred_counts: counts,
      sample: inferred.slice(0, Math.max(1, sampleLimit)).map((item) => ({
        id: item.row.id,
        title: item.row.title,
        scope_type: item.row.scope_type,
        scope_id: item.row.scope_id,
        inference: item.inference
      }))
    };
    if (!apply) {
      printJson(summary);
      return;
    }

    await client.query("BEGIN");
    const now = new Date();
    for (const item of inferred) {
      await client.query(
        `
          UPDATE ${schema}.memory_records
          SET memory_type = $2::text,
              metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'memory_type', $2::text,
                'identity_source', 'governance_backfill',
                'memory_type_backfilled_at', $3::timestamptz::text,
                'memory_type_backfill_confidence', $4::float,
                'memory_type_backfill_reason', $5::text
              ),
              updated_by = 'memory:memory-type-backfill',
              updated_at = $3::timestamptz
          WHERE id = $1
        `,
        [
          item.row.id,
          item.inference.memory_type,
          now,
          item.inference.confidence,
          item.inference.reason
        ]
      );
      await client.query(
        `
          INSERT INTO ${schema}.memory_events (id, memory_id, request_id, event_type, actor_id, payload, created_at)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        `,
        [
          randomUUID(),
          item.row.id,
          `memory-type-backfill:${runId}`,
          OutboxEventType.MemoryUpdated,
          "memory:memory-type-backfill",
          JSON.stringify({
            reason: "legacy_memory_type_backfill",
            memory_type: item.inference.memory_type,
            confidence: item.inference.confidence,
            inference_reason: item.inference.reason
          }),
          now
        ]
      );
    }
    await client.query("COMMIT");
    summary.updated = inferred.length;
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
