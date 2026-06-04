#!/usr/bin/env tsx
import "./test-harness/config.js";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config";
import { mapMemoryIdToQdrantPointId } from "../app/qdrant-sync/projector";
import { config } from "./test-harness/config.js";
import { loadDotenvIfPresent, quoteIdent } from "./lib/runtime-env";

loadDotenvIfPresent();

const execFileAsync = promisify(execFile);

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function casesCount(): number {
  const parsed = Number.parseInt(arg("cases") || "300", 10);
  return Number.isFinite(parsed) ? Math.max(3, Math.min(800, parsed)) : 300;
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

async function runCli(args: readonly string[], expectSuccess = true): Promise<{ ok: boolean; stdout: string; stderr: string; json?: Record<string, unknown> }> {
  try {
    const result = await execFileAsync("npm", ["run", "--silent", ...args], {
      cwd: process.cwd(),
      timeout: 120_000,
      env: process.env,
    });
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    return { ok: true, stdout: result.stdout, stderr: result.stderr, json };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    if (expectSuccess) throw error;
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
  }
}

async function deleteQdrantMemoryIds(memoryIds: readonly string[]): Promise<void> {
  if (memoryIds.length === 0) return;
  const pointIds = [...new Set(memoryIds.map(mapMemoryIdToQdrantPointId))];
  const response = await fetch(`${config.qdrantUrl}/collections/${config.qdrantCollection}/points/delete?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points: pointIds }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`qdrant cleanup failed status=${response.status} body=${await response.text()}`);
  }
}

type UpdateKind = "explicit_replacement" | "same_fact_refresh" | "temporal_expiry";

function updateKind(index: number): UpdateKind {
  return index % 3 === 0 ? "explicit_replacement" : index % 3 === 1 ? "same_fact_refresh" : "temporal_expiry";
}

async function seedPair(client: import("pg").PoolClient, schema: string, runId: string, index: number, kind: UpdateKind): Promise<{ scopeId: string; oldId: string; candidateId: string }> {
  const scopeId = `auto-update-test-${runId}-${index}`;
  const oldId = id("memory");
  const candidateId = id("memory");
  const oldRequest = id("request");
  const candidateRequest = id("request");
  const marker = `${runId}-${index}-${kind}`;
  const conflictAction = kind === "same_fact_refresh" ? "refresh" : kind === "temporal_expiry" ? "update" : "update";
  const candidateContent = kind === "explicit_replacement"
    ? `之前使用 setting-A-${marker}，现在改成 setting-B-${marker}。`
    : kind === "same_fact_refresh"
      ? `重新确认 same fact refresh marker ${marker} still true.`
      : `旧事实 ${marker} 已过期，需要归档并采用 current-${marker}.`;
  await client.query(
    `INSERT INTO ${schema}.ingest_requests (request_id, command_type, payload_hash, payload_json, actor_id, status, completed_at, result_json)
     VALUES ($1, 'memory.create', $2, '{}'::jsonb, 'test:auto-update-apply-random-e2e', 'completed', now(), '{}'::jsonb),
            ($3, 'memory.create', $4, '{}'::jsonb, 'test:auto-update-apply-random-e2e', 'completed', now(), '{}'::jsonb)`,
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
      `Old update apply random marker ${marker}.`,
      `old ${marker}`,
      JSON.stringify({ source: "conversation_ingest", auto_update_random_run_id: runId, confidence: 0.99, quality_score: 0.99 }),
      candidateId,
      candidateRequest,
      candidateContent,
      `new ${marker}`,
      JSON.stringify({
        source: "conversation_ingest",
        conflict_action: conflictAction,
        existing_memory_id: oldId,
        auto_update_random_run_id: runId,
        auto_update_type: kind,
        expires_at: kind === "temporal_expiry" ? new Date(Date.now() - 60_000).toISOString() : undefined,
        confidence: 0.99,
        quality_score: 0.99,
      }),
    ]
  );
  return { scopeId, oldId, candidateId };
}

async function main(): Promise<void> {
  const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const pgConfig = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(pgConfig.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  const client = await pool.connect();
  const seededScopes: string[] = [];
  const seededMemoryIds: string[] = [];
  const failures: Array<Record<string, unknown>> = [];
  const results: Array<Record<string, unknown>> = [];
  try {
    for (let index = 0; index < casesCount(); index += 1) {
      const kind = updateKind(index);
      const seeded = await seedPair(client, schema, runId, index, kind);
      seededScopes.push(seeded.scopeId);
      seededMemoryIds.push(seeded.oldId, seeded.candidateId);
      const apply = await runCli(["memory:auto-update", "--", "apply", `--scope=project:${seeded.scopeId}`, `--candidate-id=${seeded.candidateId}`]);
      const decisionId = String(apply.json?.decision_id ?? "");
      const rollback = await runCli(["memory:auto-update", "--", "rollback", `--decision-id=${decisionId}`, "--apply"]);
      const rows = await client.query(
        `SELECT id, lifecycle_status, review_state, is_current, metadata FROM ${schema}.memory_records WHERE id = ANY($1::text[]) ORDER BY id`,
        [[seeded.oldId, seeded.candidateId]]
      );
      const old = rows.rows.find((row) => row.id === seeded.oldId);
      const newer = rows.rows.find((row) => row.id === seeded.candidateId);
      const ok = apply.json?.ok === true &&
        rollback.json?.ok === true &&
        old?.lifecycle_status === "approved" &&
        old?.is_current === true &&
        newer?.lifecycle_status === "tombstone" &&
        newer?.is_current === false;
      if (!ok) failures.push({ index, kind, scope: seeded.scopeId, apply: apply.json, rollback: rollback.json, rows: rows.rows });
      results.push({
        index,
        kind,
        scope: `project:${seeded.scopeId}`,
        old_memory_id: seeded.oldId,
        new_memory_id: seeded.candidateId,
        decision_id: decisionId,
        ok,
        apply_update_type: (apply.json?.decision as Record<string, unknown> | undefined)?.detected_update_type,
        rollback_verified: rollback.json?.rollback_verified === true,
      });
    }
    const realProjectDryRun = await runCli(["memory:auto-update", "--", "dry-run", "--scope=project:memory-xx", "--limit=1"]);
    const globalDryRun = await runCli(["memory:auto-update", "--", "dry-run", "--scope=global:global", "--limit=1"]);
    const report = {
      ok: failures.length === 0,
      run_id: runId,
      cases: casesCount(),
      failures,
      summary: {
        applied: results.filter((row) => row.ok === true).length,
        failed: failures.length,
        rollback_verified: results.filter((row) => row.rollback_verified === true).length,
        by_kind: results.reduce((acc, row) => {
          const kind = String(row.kind);
          acc[kind] = (acc[kind] ?? 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      },
      real_project_dry_run_probe: { ok: realProjectDryRun.ok, candidate_count: realProjectDryRun.json?.candidate_count },
      global_dry_run_probe: { ok: globalDryRun.ok, candidate_count: globalDryRun.json?.candidate_count },
      results,
    };
    const reportDir = join(process.cwd(), "reports", "auto-update-apply-random-e2e");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `auto-update-apply-random-e2e-${runId}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(JSON.stringify({ ...report, report_path: reportPath }, null, 2) + "\n");
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    if (seededScopes.length > 0) {
      await client.query(
        `UPDATE ${schema}.memory_records SET lifecycle_status = 'tombstone', is_current = false, updated_at = now() WHERE scope_type = 'project' AND scope_id = ANY($1::text[])`,
        [seededScopes]
      ).catch(() => undefined);
    }
    await deleteQdrantMemoryIds(seededMemoryIds).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
