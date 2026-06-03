#!/usr/bin/env tsx
import "./test-harness/config.js";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryV2PostgresConfig } from "../app/db/adapters/postgres-config";
import { loadDotenvIfPresent, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

const execFileAsync = promisify(execFile);

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

async function runCli(args: readonly string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync("npm", ["run", "--silent", ...args], {
    cwd: process.cwd(),
    timeout: 90_000,
    env: process.env,
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function seedPair(client: import("pg").PoolClient, schema: string, runId: string): Promise<{ scopeId: string; oldId: string; candidateId: string }> {
  const scopeId = `auto-update-test-${runId}`;
  const oldId = id("memory");
  const candidateId = id("memory");
  const oldRequest = id("request");
  const candidateRequest = id("request");
  await client.query(
    `INSERT INTO ${schema}.ingest_requests (request_id, command_type, payload_hash, payload_json, actor_id, status, completed_at, result_json)
     VALUES ($1, 'memory.create', $2, '{}'::jsonb, 'test:auto-update-apply-e2e', 'completed', now(), '{}'::jsonb),
            ($3, 'memory.create', $4, '{}'::jsonb, 'test:auto-update-apply-e2e', 'completed', now(), '{}'::jsonb)`,
    [oldRequest, `hash-${oldRequest}`, candidateRequest, `hash-${candidateRequest}`]
  );
  await client.query(
    `INSERT INTO ${schema}.memory_records (
       id, request_id, scope_type, scope_id, content, title, summary, metadata, dedupe_key,
       lifecycle_status, review_state, is_current, version, created_by, updated_by, agent_id, memory_type, created_at, updated_at
     )
     VALUES
       ($1, $2, 'project', $3, $4, $5, NULL, $6::jsonb, NULL, 'approved', 'silent_approved', true, 1, 'codex', 'codex', 'codex', 'fact', now(), now()),
       ($7, $8, 'project', $3, $9, $10, NULL, $11::jsonb, NULL, 'candidate', 'pending', true, 1, 'codex', 'codex', 'codex', 'fact', now(), now())`,
    [
      oldId,
      oldRequest,
      scopeId,
      `Old auto-update apply setting A for ${runId}.`,
      `old ${runId}`,
      JSON.stringify({ source: "conversation_ingest", auto_update_random_run_id: runId, confidence: 0.99, quality_score: 0.99 }),
      candidateId,
      candidateRequest,
      `之前用 A-${runId}，现在改成 B-${runId}。`,
      `new ${runId}`,
      JSON.stringify({
        source: "conversation_ingest",
        conflict_action: "update",
        existing_memory_id: oldId,
        auto_update_random_run_id: runId,
        confidence: 0.99,
        quality_score: 0.99,
      }),
    ]
  );
  return { scopeId, oldId, candidateId };
}

async function main(): Promise<void> {
  const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const pgConfig = loadMemoryV2PostgresConfig(process.env);
  const schema = quoteIdent(pgConfig.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  const client = await pool.connect();
  let seeded: { scopeId: string; oldId: string; candidateId: string } | null = null;
  try {
    seeded = await seedPair(client, schema, runId);
    const apply = await runCli([
      "memory:auto-update",
      "--",
      "apply",
      `--scope=project:${seeded.scopeId}`,
      `--candidate-id=${seeded.candidateId}`,
    ]);
    const rows = await client.query(
      `SELECT id, lifecycle_status, review_state, is_current, metadata FROM ${schema}.memory_records WHERE id = ANY($1::text[]) ORDER BY id`,
      [[seeded.oldId, seeded.candidateId]]
    );
    const old = rows.rows.find((row) => row.id === seeded?.oldId);
    const newer = rows.rows.find((row) => row.id === seeded?.candidateId);
    const governance = await client.query(`SELECT status, evidence FROM ${schema}.memory_governance_actions WHERE id = $1`, [apply.decision_id]);
    const outbox = await client.query(`SELECT count(*)::int AS count FROM ${schema}.outbox_events WHERE aggregate_id = ANY($1::text[])`, [[seeded.oldId, seeded.candidateId]]);
    const ok = apply.ok === true &&
      old?.lifecycle_status === "superseded" &&
      old?.is_current === false &&
      newer?.lifecycle_status === "approved" &&
      newer?.review_state === "silent_approved" &&
      governance.rows[0]?.status === "applied" &&
      Number(outbox.rows[0]?.count ?? 0) >= 2;
    const report = { ok, run_id: runId, scope: `project:${seeded.scopeId}`, old_memory_id: seeded.oldId, new_memory_id: seeded.candidateId, apply, rows: rows.rows, governance: governance.rows[0] ?? null, outbox_count: Number(outbox.rows[0]?.count ?? 0) };
    const reportDir = join(process.cwd(), "reports", "auto-update-apply-e2e");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `auto-update-apply-e2e-${runId}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(JSON.stringify({ ...report, report_path: reportPath }, null, 2) + "\n");
    if (!ok) process.exitCode = 1;
  } finally {
    if (seeded) {
      await client.query(`UPDATE ${schema}.memory_records SET lifecycle_status = 'tombstone', is_current = false, updated_at = now() WHERE scope_type = 'project' AND scope_id = $1`, [seeded.scopeId]).catch(() => undefined);
    }
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
