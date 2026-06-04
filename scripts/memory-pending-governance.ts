#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import {
  createPostgresPoolConfig,
  loadMemoryXXPostgresConfig,
  PostgresWriteDatabase,
} from "../app/db";
import { ReviewDecisionService } from "../app/review";

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(prefix));
  if (index < 0) return undefined;
  const found = process.argv[index]!;
  if (found === name) {
    const next = process.argv[index + 1];
    return next && !next.startsWith("--") ? next : "true";
  }
  return found.slice(prefix.length);
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe_identifier:${value}`);
  return `"${value}"`;
}

function testScopePredicate(scopeId: string): boolean {
  return /^(real-user-|conversation-worker-|memory-xx-audit-)/.test(scopeId);
}

async function main(): Promise<void> {
  const apply = hasArg("--apply");
  const source = argValue("--source") || "conversation_ingest";
  const testScopesOnly = hasArg("--test-scopes-only") || !apply;
  const limit = Math.max(1, Number.parseInt(argValue("--limit") || "100", 10) || 100);
  const config = loadMemoryXXPostgresConfig(process.env);
  const pool = new Pool(createPostgresPoolConfig(config));
  const rows = await pool.query<{
    id: string;
    scope_type: string;
    scope_id: string;
    source: string | null;
    title: string | null;
    created_at: string;
  }>(`
    SELECT id, scope_type, scope_id, metadata ->> 'source' AS source, title, created_at
    FROM ${quoteIdent(config.schema)}.memory_records
    WHERE lifecycle_status = 'candidate'
      AND review_state = 'pending'
      AND is_current IS TRUE
      AND ($1::text = '' OR metadata ->> 'source' = $1)
    ORDER BY created_at ASC
    LIMIT $2
  `, [source, limit]);
  await pool.end();

  const candidates = rows.rows.filter((row) => !testScopesOnly || testScopePredicate(row.scope_id));
  const skipped = rows.rows.filter((row) => testScopesOnly && !testScopePredicate(row.scope_id));
  const rejected: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  if (apply) {
    const db = new PostgresWriteDatabase({ config });
    const service = new ReviewDecisionService({ database: db });
    for (const row of candidates) {
      try {
        const result = await service.reject({
          requestId: `pending-governance-reject-${randomUUID()}`,
          actorId: "memory-xx-pending-governance",
          memoryId: row.id,
        });
        rejected.push(result.memoryId);
      } catch (error) {
        failed.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await db.close();
  }

  const output = {
    ok: failed.length === 0,
    mode: apply ? "apply" : "dry_run",
    source,
    test_scopes_only: testScopesOnly,
    matched: rows.rows.length,
    eligible: candidates.length,
    skipped_non_test_scope: skipped.length,
    rejected,
    failed,
    candidates: candidates.map((row) => ({
      id: row.id,
      scope: `${row.scope_type}:${row.scope_id}`,
      source: row.source,
      title: row.title,
      created_at: row.created_at,
      action: apply ? "rejected" : "would_reject",
    })),
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  if (!output.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
