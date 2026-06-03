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
import { apiUrl, httpPost } from "./test-harness/lib/http-client.js";
import { scrollByMemoryId } from "./test-harness/lib/qdrant-helpers.js";
import { config } from "./test-harness/config.js";
import { loadDotenvIfPresent, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function idsFromRecall(body: unknown): string[] {
  const data = body as Record<string, unknown>;
  const recall = data?.recall as Record<string, unknown> | undefined;
  const results = (Array.isArray(data?.results) ? data.results : Array.isArray(recall?.results) ? recall.results : []) as Array<Record<string, unknown>>;
  return results.map((item) => String(item.memory_id ?? item.memoryId ?? item.id ?? "")).filter(Boolean);
}

async function runCli(args: readonly string[], expectSuccess = true): Promise<{ ok: boolean; stdout: string; stderr: string; json?: Record<string, unknown> }> {
  try {
    const result = await execFileAsync("npm", ["run", "--silent", ...args], {
      cwd: process.cwd(),
      timeout: 120_000,
      env: process.env,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, json: JSON.parse(result.stdout) as Record<string, unknown> };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    if (expectSuccess) throw error;
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
  }
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

async function waitForVisibility(memoryId: string, visible: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const points = await scrollByMemoryId(memoryId).catch(() => []);
    if ((points.length > 0) === visible) return true;
    await sleep(1500);
  }
  return false;
}

async function recallContains(memoryId: string, query: string): Promise<{ unified: boolean; mcp: boolean }> {
  const unified = await httpPost(apiUrl("/api/memory/v2/unified/recall"), {
    query,
    scope_type: "project",
    scope_id: "memory-xx",
    include_global: false,
    memory_ids: [memoryId],
    limit: 5,
  }, { token: config.wrapperToken, timeout: 30_000 });
  const unifiedHit = idsFromRecall(unified.body).includes(memoryId);
  const mcp = await httpPost(apiUrl("/mcp"), {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 100000),
    method: "tools/call",
    params: { name: "recall_memory", arguments: { query, project_ids: ["memory-xx"], memory_ids: [memoryId], limit: 5 } },
  }, { token: config.wrapperToken, timeout: 30_000 });
  const text = (((mcp.body as Record<string, unknown>)?.result as Record<string, unknown>)?.content as Array<Record<string, unknown>> | undefined)?.[0]?.text;
  const parsed = typeof text === "string" ? JSON.parse(text) as unknown : {};
  return { unified: unifiedHit, mcp: idsFromRecall(parsed).includes(memoryId) };
}

async function waitForRecall(memoryId: string, query: string, visible: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const result = await recallContains(memoryId, query);
    if (result.unified === visible && result.mcp === visible) return true;
    await sleep(1500);
  }
  return false;
}

async function seedRealProjectPair(client: import("pg").PoolClient, schema: string, runId: string): Promise<{ oldId: string; candidateId: string; oldContent: string; newContent: string }> {
  const oldId = id("memory");
  const candidateId = id("memory");
  const oldRequest = id("request");
  const candidateRequest = id("request");
  const marker = `real-project-update-${runId}`;
  const oldContent = `memory-xx project fact ${marker}: guarded update value is A.`;
  const newContent = `memory-xx project fact ${marker}: 之前值是 A，现在改成 B。`;
  await client.query(
    `INSERT INTO ${schema}.ingest_requests (request_id, command_type, payload_hash, payload_json, actor_id, status, completed_at, result_json)
     VALUES ($1, 'memory.create', $2, '{}'::jsonb, 'test:auto-update-real-project-guarded-e2e', 'completed', now(), '{}'::jsonb),
            ($3, 'memory.create', $4, '{}'::jsonb, 'test:auto-update-real-project-guarded-e2e', 'completed', now(), '{}'::jsonb)`,
    [oldRequest, `hash-${oldRequest}`, candidateRequest, `hash-${candidateRequest}`]
  );
  await client.query(
    `INSERT INTO ${schema}.memory_records (
       id, request_id, scope_type, scope_id, content, title, summary, metadata, dedupe_key,
       lifecycle_status, review_state, is_current, version, created_by, updated_by, agent_id, memory_type, created_at, updated_at
     )
     VALUES
       ($1, $2, 'project', 'memory-xx', $3, $4, NULL, $5::jsonb, NULL, 'approved', 'silent_approved', true, 1, 'codex', 'codex', 'codex', 'fact', now(), now()),
       ($6, $7, 'project', 'memory-xx', $8, $9, NULL, $10::jsonb, NULL, 'candidate', 'pending', true, 1, 'codex', 'codex', 'codex', 'fact', now(), now())`,
    [
      oldId,
      oldRequest,
      oldContent,
      `old ${marker}`,
      JSON.stringify({ source: "conversation_ingest", auto_update_real_project_guarded_run_id: runId, confidence: 0.99, quality_score: 0.99 }),
      candidateId,
      candidateRequest,
      newContent,
      `new ${marker}`,
      JSON.stringify({
        source: "conversation_ingest",
        conflict_action: "update",
        existing_memory_id: oldId,
        auto_update_real_project_guarded_run_id: runId,
        confidence: 0.99,
        quality_score: 0.99,
      }),
    ]
  );
  await client.query(
    `INSERT INTO ${schema}.memory_events (id, memory_id, request_id, event_type, actor_id, payload, created_at)
     VALUES ($1, $2, $3, $4, 'test:auto-update-real-project-guarded-e2e', $5::jsonb, now()),
            ($6, $7, $8, $4, 'test:auto-update-real-project-guarded-e2e', $9::jsonb, now())`,
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
  const eventId = id("outbox_event");
  await client.query(
    `INSERT INTO ${schema}.outbox_events (
       id, aggregate_id, request_id, event_type, payload, payload_version, dispatch_status, attempts, created_at, dispatched_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, 1, 'pending', 0, now(), NULL)`,
    [eventId, oldId, oldRequest, OutboxEventType.MemoryCreated, JSON.stringify({
      memoryId: oldId,
      requestId: oldRequest,
      lifecycleStatus: "approved",
      reviewState: "silent_approved",
      isCurrent: true,
      version: 1,
    })]
  );
  await client.query(
    `INSERT INTO ${schema}.outbox_events (
       id, aggregate_id, request_id, event_type, payload, payload_version, dispatch_status, attempts, created_at, dispatched_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, 1, 'pending', 0, now(), NULL)`,
    [id("outbox_event"), candidateId, candidateRequest, OutboxEventType.MemoryCreated, JSON.stringify({
      memoryId: candidateId,
      requestId: candidateRequest,
      lifecycleStatus: "candidate",
      reviewState: "pending",
      isCurrent: true,
      version: 1,
    })]
  );
  return { oldId, candidateId, oldContent, newContent };
}

function enableGuardedProjectApply(): { restore: () => void } {
  const file = autoApprovalRuntimeControlsPath();
  const existed = existsSync(file);
  const previous = existed ? readFileSync(file, "utf8") : null;
  const current = readAutoApprovalRuntimeControlsSync();
  writeAutoApprovalRuntimeControlsSync({
    ...current,
    update_apply: {
      ...current.update_apply,
      enabled: true,
      real_project_apply: true,
      explicit_replacement: true,
      same_fact_refresh: true,
      temporal_expiry: true,
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

async function main(): Promise<void> {
  const runId = `real-project-update-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const pgConfig = loadMemoryV2PostgresConfig(process.env);
  const schema = quoteIdent(pgConfig.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  const client = await pool.connect();
  const runtime = enableGuardedProjectApply();
  let seeded: { oldId: string; candidateId: string; oldContent: string; newContent: string } | null = null;
  try {
    seeded = await seedRealProjectPair(client, schema, runId);
    const oldProjected = await waitForVisibility(seeded.oldId, true);
    const dryRun = await runCli(["memory:auto-update", "--", "dry-run", "--scope=project:memory-xx", "--limit=20"]);
    const apply = await runCli(["memory:auto-update", "--", "apply", "--scope=project:memory-xx", `--candidate-id=${seeded.candidateId}`]);
    const newProjected = await waitForVisibility(seeded.candidateId, true);
    const oldHiddenAfterApply = await waitForVisibility(seeded.oldId, false);
    const newRecallHit = await waitForRecall(seeded.candidateId, seeded.newContent, true);
    const oldRecallHidden = await waitForRecall(seeded.oldId, seeded.oldContent, false);
    const userDryRun = await runCli(["memory:auto-update", "--", "dry-run", "--scope=user:current-user", "--limit=1"]);
    const globalDryRun = await runCli(["memory:auto-update", "--", "dry-run", "--scope=global:global", "--limit=1"]);
    const rollback = await runCli(["memory:auto-update", "--", "rollback", `--decision-id=${String(apply.json?.decision_id)}`, "--apply"]);
    const oldRestoredProjected = await waitForVisibility(seeded.oldId, true);
    const newHiddenAfterRollback = await waitForVisibility(seeded.candidateId, false);
    const oldRecallRestored = await waitForRecall(seeded.oldId, seeded.oldContent, true);
    const newRecallHiddenAfterRollback = await waitForRecall(seeded.candidateId, seeded.newContent, false);
    const rows = await client.query(
      `SELECT id, lifecycle_status, review_state, is_current, metadata FROM ${schema}.memory_records WHERE id = ANY($1::text[]) ORDER BY id`,
      [[seeded.oldId, seeded.candidateId]]
    );
    const ok = oldProjected &&
      dryRun.json?.ok === true &&
      apply.json?.ok === true &&
      newProjected &&
      oldHiddenAfterApply &&
      newRecallHit &&
      oldRecallHidden &&
      userDryRun.json?.ok === true &&
      globalDryRun.json?.ok === true &&
      rollback.json?.ok === true &&
      oldRestoredProjected &&
      newHiddenAfterRollback &&
      oldRecallRestored &&
      newRecallHiddenAfterRollback;
    const report = {
      ok,
      run_id: runId,
      scope: "project:memory-xx",
      old_memory_id: seeded.oldId,
      new_memory_id: seeded.candidateId,
      dry_run_candidate_count: dryRun.json?.candidate_count,
      apply: apply.json,
      rollback: rollback.json,
      user_scope_dry_run_probe: { ok: userDryRun.ok, candidate_count: userDryRun.json?.candidate_count },
      global_scope_dry_run_probe: { ok: globalDryRun.ok, candidate_count: globalDryRun.json?.candidate_count },
      verification: {
        old_projected_before_apply: oldProjected,
        new_projected_after_apply: newProjected,
        old_hidden_after_apply: oldHiddenAfterApply,
        new_recall_hit_after_apply: newRecallHit,
        old_recall_hidden_after_apply: oldRecallHidden,
        old_projected_after_rollback: oldRestoredProjected,
        new_hidden_after_rollback: newHiddenAfterRollback,
        old_recall_hit_after_rollback: oldRecallRestored,
        new_recall_hidden_after_rollback: newRecallHiddenAfterRollback,
      },
      rows: rows.rows,
    };
    const reportDir = join(process.cwd(), "reports", "auto-update-real-project-guarded-e2e");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `auto-update-real-project-guarded-e2e-${runId}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...report, report_path: reportPath }, null, 2)}\n`);
    if (!ok) process.exitCode = 1;
  } finally {
    runtime.restore();
    if (seeded) {
      await client.query(
        `UPDATE ${schema}.memory_records
         SET lifecycle_status = 'tombstone', is_current = false, updated_at = now()
         WHERE metadata->>'auto_update_real_project_guarded_run_id' = $1`,
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
