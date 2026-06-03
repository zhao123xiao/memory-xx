#!/usr/bin/env tsx
import "./test-harness/config.js";

import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryV2PostgresConfig } from "../app/db/adapters/postgres-config";
import { requireCliPermission } from "../app/server/permissions.js";
import { loadDotenvIfPresent, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

function command(): string {
  return process.argv[2] ?? "dry-run";
}

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

async function main(): Promise<void> {
  if (command() !== "dry-run") throw new Error("usage: memory:temporal-policy -- dry-run");
  await requireCliPermission("memory:governance_read");
  const config = loadMemoryV2PostgresConfig(process.env);
  const schema = quoteIdent(config.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(config));
  const client = await pool.connect();
  try {
    const limit = Math.max(1, Math.min(200, Number.parseInt(arg("limit") || "100", 10) || 100));
    const rows = await client.query(
      `
        SELECT id, scope_type, scope_id, memory_type, title, lifecycle_status, review_state,
               valid_at, invalid_at, expires_at, metadata,
               metadata->>'review_at' AS review_at,
               metadata->>'temporal_validity' AS temporal_validity
        FROM ${schema}.memory_records
        WHERE is_current IS TRUE
          AND lifecycle_status IN ('candidate', 'approved')
          AND (
            expires_at <= now()
            OR metadata->>'temporal_validity' = 'temporary'
            OR (scope_type = 'workspace' AND metadata->>'review_at' IS NULL)
          )
        ORDER BY updated_at DESC
        LIMIT $1
      `,
      [limit]
    );
    const results = rows.rows.map((row) => {
      const reasons: string[] = [];
      if (row.expires_at && Date.parse(String(row.expires_at)) <= Date.now()) reasons.push("expired");
      if (row.temporal_validity === "temporary") reasons.push("temporary_temporal_validity");
      if (row.scope_type === "workspace" && !row.review_at) reasons.push("workspace_review_at_missing");
      return {
        memory_id: row.id,
        scope_type: row.scope_type,
        scope_id: row.scope_id,
        memory_type: row.memory_type,
        title: row.title,
        lifecycle_status: row.lifecycle_status,
        review_state: row.review_state,
        reasons,
        dry_run_action: reasons.includes("expired") ? "archive_or_tombstone_expired" : "human_review_required",
      };
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      dry_run: true,
      candidate_count: results.length,
      results,
    }, null, 2) + "\n");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
