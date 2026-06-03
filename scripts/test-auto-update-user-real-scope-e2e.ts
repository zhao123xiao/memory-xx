#!/usr/bin/env tsx
import "./test-harness/config.js";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryV2PostgresConfig } from "../app/db/adapters/postgres-config";
import {
  autoApprovalRuntimeControlsPath,
  readAutoApprovalRuntimeControlsSync,
  writeAutoApprovalRuntimeControlsSync,
} from "../app/governance/auto-approval-runtime-controls";
import { mapMemoryIdToQdrantPointId } from "../app/qdrant-sync/projector";
import { OutboxEventType } from "../app/shared";
import { quoteIdent } from "./lib/runtime-env";
import { config } from "./test-harness/config.js";

const execFileAsync = promisify(execFile);

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

async function runCli(args: readonly string[]): Promise<{ ok: boolean; stdout: string; stderr: string; json?: Record<string, unknown> }> {
  const result = await execFileAsync("npm", ["run", "--silent", ...args], {
    cwd: process.cwd(),
    timeout: 120_000,
    env: process.env,
  });
  return { ok: true, stdout: result.stdout, stderr: result.stderr, json: JSON.parse(result.stdout) as Record<string, unknown> };
}

async function deleteQdrantMemoryIds(memoryIds: readonly string[]): Promise<void> {
  const pointIds = [...new Set(memoryIds.map(mapMemoryIdToQdrantPointId))];
  if (pointIds.length === 0) return;
  const response = await fetch(`${config.qdrantUrl}/collections/${config.qdrantCollection}/points/delete?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points: pointIds }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`qdrant cleanup failed status=${response.status} body=${await response.text()}`);
}

function enableGuardedUserApply(): { restore: () => void } {
  const file = autoApprovalRuntimeControlsPath();
  const existed = existsSync(file);
  const previous = existed ? readFileSync(file, "utf8") : null;
  const current = readAutoApprovalRuntimeControlsSync();
  writeAutoApprovalRuntimeControlsSync({
    ...current,
    update_apply: {
      ...current.update_apply,
      enabled: true,
      user_apply: true,
      explicit_replacement: true,
      same_fact_refresh: true,
      temporal_expiry: true,
      preference_change_apply: true,
      merge_apply: false,
      max_hourly_per_scope: Math.max(10, current.update_apply.max_hourly_per_scope),
    },
  });
  return {
    restore: () => {
      if (previous !== null) writeFileSync(file, previous, "utf8");
      else rmSync(file, { force: true });
    },
  };
}

async function seedUserPair(client: import("pg").PoolClient, schema: string, runId: string): Promise<{ oldId: string; candidateId: string }> {
  const oldId = id("memory");
  const candidateId = id("memory");
  const oldRequest = id("request");
  const candidateRequest = id("request");
  const oldContent = `用户偏好 ${runId}: 之前默认使用 compact 输出。`;
  const newContent = `用户偏好 ${runId}: 我之前偏好 compact 输出，现在改成详细但不啰嗦的输出。`;
  await client.query(
    `INSERT INTO ${schema}.ingest_requests (request_id, command_type, payload_hash, payload_json, actor_id, status, completed_at, result_json)
     VALUES ($1, 'memory.create', $2, '{}'::jsonb, 'test:auto-update-user-real-scope-e2e', 'completed', now(), '{}'::jsonb),
            ($3, 'memory.create', $4, '{}'::jsonb, 'test:auto-update-user-real-scope-e2e', 'completed', now(), '{}'::jsonb)`,
    [oldRequest, `hash-${oldRequest}`, candidateRequest, `hash-${candidateRequest}`]
  );
  await client.query(
    `INSERT INTO ${schema}.memory_records (
       id, request_id, scope_type, scope_id, content, title, summary, metadata, dedupe_key,
       lifecycle_status, review_state, is_current, version, created_by, updated_by, agent_id, memory_type, created_at, updated_at
     )
     VALUES
       ($1, $2, 'user', 'current-user', $3, $4, NULL, $5::jsonb, NULL, 'approved', 'silent_approved', true, 1, 'codex', 'codex', 'codex', 'preference', now(), now()),
       ($6, $7, 'user', 'current-user', $8, $9, NULL, $10::jsonb, NULL, 'candidate', 'pending', true, 1, 'codex', 'codex', 'codex', 'preference', now(), now())`,
    [
      oldId,
      oldRequest,
      oldContent,
      `old user preference ${runId}`,
      JSON.stringify({ source: "conversation_ingest", auto_update_user_real_scope_run_id: runId, confidence: 0.99, quality_score: 0.99 }),
      candidateId,
      candidateRequest,
      newContent,
      `new user preference ${runId}`,
      JSON.stringify({
        source: "conversation_ingest",
        conflict_action: "update",
        existing_memory_id: oldId,
        auto_update_user_real_scope_run_id: runId,
        confidence: 0.99,
        quality_score: 0.99,
      }),
    ]
  );
  await client.query(
    `INSERT INTO ${schema}.memory_events (id, memory_id, request_id, event_type, actor_id, payload, created_at)
     VALUES ($1, $2, $3, $4, 'test:auto-update-user-real-scope-e2e', $5::jsonb, now()),
            ($6, $7, $8, $4, 'test:auto-update-user-real-scope-e2e', $9::jsonb, now())`,
    [
      id("memory_event"),
      oldId,
      oldRequest,
      OutboxEventType.MemoryCreated,
      JSON.stringify({ memoryId: oldId, requestId: oldRequest, lifecycleStatus: "approved", reviewState: "silent_approved", isCurrent: true }),
      id("memory_event"),
      candidateId,
      candidateRequest,
      JSON.stringify({ memoryId: candidateId, requestId: candidateRequest, lifecycleStatus: "candidate", reviewState: "pending", isCurrent: true }),
    ]
  );
  await client.query(
    `INSERT INTO ${schema}.outbox_events (
       id, aggregate_id, request_id, event_type, payload, payload_version, dispatch_status, attempts, created_at, dispatched_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, 1, 'pending', 0, now(), NULL),
            ($6, $7, $8, $4, $9::jsonb, 1, 'pending', 0, now(), NULL)`,
    [
      id("outbox_event"),
      oldId,
      oldRequest,
      OutboxEventType.MemoryCreated,
      JSON.stringify({ memoryId: oldId, requestId: oldRequest, lifecycleStatus: "approved", reviewState: "silent_approved", isCurrent: true }),
      id("outbox_event"),
      candidateId,
      candidateRequest,
      JSON.stringify({ memoryId: candidateId, requestId: candidateRequest, lifecycleStatus: "candidate", reviewState: "pending", isCurrent: true }),
    ]
  );
  return { oldId, candidateId };
}

async function main(): Promise<void> {
  const runId = `user-update-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const pgConfig = loadMemoryV2PostgresConfig(process.env);
  const schema = quoteIdent(pgConfig.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  const client = await pool.connect();
  const runtime = enableGuardedUserApply();
  let seeded: { oldId: string; candidateId: string } | null = null;
  try {
    seeded = await seedUserPair(client, schema, runId);
    const apply = await runCli(["memory:auto-update", "--", "apply", "--scope=user:current-user", `--candidate-id=${seeded.candidateId}`]);
    const decisionId = String(apply.json?.decision_id ?? "");
    const rollback = await runCli(["memory:auto-update", "--", "rollback", `--decision-id=${decisionId}`, "--apply"]);
    const rows = await client.query(
      `SELECT id, lifecycle_status, review_state, is_current, metadata FROM ${schema}.memory_records WHERE id = ANY($1::text[]) ORDER BY id`,
      [[seeded.oldId, seeded.candidateId]]
    );
    const old = rows.rows.find((row) => row.id === seeded?.oldId);
    const newer = rows.rows.find((row) => row.id === seeded?.candidateId);
    const ok = apply.json?.ok === true &&
      rollback.json?.ok === true &&
      old?.lifecycle_status === "approved" &&
      old?.is_current === true &&
      newer?.lifecycle_status === "tombstone" &&
      newer?.is_current === false;
    const report = {
      ok,
      run_id: runId,
      scope: "user:current-user",
      old_memory_id: seeded.oldId,
      new_memory_id: seeded.candidateId,
      apply: apply.json,
      rollback: rollback.json,
      rows: rows.rows,
    };
    const reportDir = join(process.cwd(), "reports", "auto-update-user-real-scope-e2e");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `auto-update-user-real-scope-e2e-${runId}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...report, report_path: reportPath }, null, 2)}\n`);
    if (!ok) process.exitCode = 1;
  } finally {
    runtime.restore();
    if (seeded) {
      await client.query(
        `UPDATE ${schema}.memory_records
         SET lifecycle_status = 'tombstone', is_current = false, updated_at = now()
         WHERE metadata->>'auto_update_user_real_scope_run_id' = $1`,
        [runId]
      ).catch(() => undefined);
      await deleteQdrantMemoryIds([seeded.oldId, seeded.candidateId]).catch(() => undefined);
    }
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
