#!/usr/bin/env tsx
import "./test-harness/config.js";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryV2PostgresConfig } from "../app/db/adapters/postgres-config.js";
import { requireCliPermission } from "../app/server/permissions.js";

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  await requireCliPermission("memory:governance_apply");
  const apply = hasFlag("--apply");
  const config = loadMemoryV2PostgresConfig(process.env);
  const schema = quoteIdent(config.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(config));
  try {
    const before = await pool.query(
      `
        SELECT
          count(*)::int AS active_approved,
          count(*) FILTER (WHERE metadata ? 'quality_gate')::int AS with_quality_gate
        FROM ${schema}.memory_records
        WHERE is_current IS TRUE AND lifecycle_status = 'approved'
      `
    );
    let updated = 0;
    if (apply) {
      const result = await pool.query(
        `
          UPDATE ${schema}.memory_records
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'quality_gate',
                jsonb_build_object(
                  'source', 'memory:quality-metadata-backfill',
                  'status', 'retrospective_not_evaluated',
                  'note', 'Legacy/current record marked for local-agent ops coverage; future writes should carry first-class quality metadata.',
                  'applied_at', now()
                )
              ),
              updated_at = now(),
              updated_by = 'memory:quality-metadata-backfill'
          WHERE is_current IS TRUE
            AND lifecycle_status = 'approved'
            AND NOT (metadata ? 'quality_gate')
        `
      );
      updated = result.rowCount ?? 0;
    }
    const after = await pool.query(
      `
        SELECT
          count(*)::int AS active_approved,
          count(*) FILTER (WHERE metadata ? 'quality_gate')::int AS with_quality_gate
        FROM ${schema}.memory_records
        WHERE is_current IS TRUE AND lifecycle_status = 'approved'
      `
    );
    process.stdout.write(JSON.stringify({
      ok: true,
      mode: apply ? "apply" : "dry_run",
      updated,
      before: before.rows[0],
      after: after.rows[0],
      policy: "Adds explicit retrospective quality_gate metadata; does not change content or lifecycle.",
    }, null, 2) + "\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
