#!/usr/bin/env tsx
import "./test-harness/config.js";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config.js";
import { requireCliPermission } from "../app/server/permissions.js";

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function wrapperUrl(): string {
  return (process.env.MEMORY_XX_WRAPPER_URL?.replace(/\/+$/, "")) ||
    `http://127.0.0.1:${process.env.MEMORY_XX_WRAPPER_PORT || "5100"}`;
}

function authToken(): string {
  return process.env.MEMORY_XX_ADMIN_TOKEN?.trim() || process.env.MEMORY_XX_CLI_TOKEN?.trim() || "";
}

async function rejectMemory(memoryId: string): Promise<unknown> {
  const response = await fetch(`${wrapperUrl()}/api/memory/xx/review/memories/${encodeURIComponent(memoryId)}/reject`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authToken()}`,
    },
    body: JSON.stringify({
      requestId: randomUUID(),
      actorId: "memory:sweep-test-pollution",
      reason: "local productization sweep rejected pending test pollution",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${memoryId}:${response.status}:${text.slice(0, 500)}`);
  return parsed;
}

async function main(): Promise<void> {
  await requireCliPermission("memory:governance_apply");
  const apply = hasFlag("--apply");
  const limit = Math.max(1, Math.min(200, Number.parseInt(argValue("--limit") ?? "100", 10) || 100));
  const config = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(config.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(config));
  try {
    const rows = await pool.query(
      `
        SELECT id, scope_type, scope_id, title, left(content, 160) AS content_preview,
               COALESCE(metadata->>'source', source_ref, source_kind, 'unknown') AS source,
               COALESCE(created_by, metadata->>'agent_id', 'unknown') AS agent_id,
               created_at
        FROM ${schema}.memory_records
        WHERE is_current IS TRUE
          AND lifecycle_status = 'candidate'
          AND review_state = 'pending'
          AND (
            scope_id ~* '(^|[-_:/])(test|func_test|recall_test|functional-report-check|dedup|orch_user|err_user|e2e_user|user_A|team_workspace)([-_:/]|$)'
            OR COALESCE(metadata->>'source', source_ref, source_kind, '') ~* '(test|benchmark|smoke|load)'
            OR COALESCE(title, '') || ' ' || content ~* '(测试|test|dedupe|idempotent|concurrent-\\$i|功能报告)'
            OR (scope_type = 'global' AND scope_id = 'global' AND COALESCE(created_by, '') = 'klee' AND COALESCE(title, '') = 'global-mem')
          )
        ORDER BY created_at ASC
        LIMIT $1
      `,
      [limit]
    );
    const rejected = [];
    const failures = [];
    if (apply) {
      for (const row of rows.rows) {
        try {
          rejected.push({ id: row.id, result: await rejectMemory(row.id) });
        } catch (error) {
          failures.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    process.stdout.write(JSON.stringify({
      ok: failures.length === 0,
      mode: apply ? "apply" : "dry_run",
      matched: rows.rows.length,
      rejected_count: rejected.length,
      failures,
      candidates: rows.rows,
      policy: "candidate test pollution is rejected through the review API; no physical delete is performed",
    }, null, 2) + "\n");
    process.exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
