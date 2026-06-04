#!/usr/bin/env tsx
import "./test-harness/config.js";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";

import { createPostgresPoolConfig, loadMemoryXXPostgresConfig } from "../app/db/adapters/postgres-config.js";
import { shouldFreezeAutoApprovalCohortMetrics } from "../app/governance/auto-approval-feedback.js";
import { collectRuntimeSnapshot } from "./control-panel/runtime-snapshot.js";
import { quoteIdent } from "./lib/runtime-env.js";

const execFileAsync = promisify(execFile);

async function runTraceFeedback(args: readonly string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync("npm", ["run", "--silent", "memory:trace-feedback", "--", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, TMPDIR: process.env.TMPDIR || "/tmp" },
    timeout: 120_000,
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const runId = `feedback-loop-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const memoryId = `memory_${randomUUID()}`;
  const requestId = `request_${randomUUID()}`;
  const traceId = `recall_trace_${randomUUID()}`;
  const pgConfig = loadMemoryXXPostgresConfig(process.env);
  const schema = quoteIdent(pgConfig.schema ?? "memory_xx");
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  const failures: Record<string, unknown>[] = [];
  try {
    await pool.query(
      `
        INSERT INTO ${schema}.ingest_requests (request_id, command_type, payload_hash, payload_json, actor_id, status, completed_at, result_json)
        VALUES ($1, 'memory.create', $2, '{}'::jsonb, 'test:feedback-real-loop', 'completed', now(), '{}'::jsonb)
      `,
      [requestId, `hash-${requestId}`]
    );
    await pool.query(
      `
        INSERT INTO ${schema}.memory_records (
          id, request_id, scope_type, scope_id, content, title, metadata,
          lifecycle_status, review_state, is_current, version, created_by, updated_by, agent_id, memory_type, created_at, updated_at
        )
        VALUES ($1, $2, 'project', $3, $4, $5, $6::jsonb,
          'approved', 'silent_approved', true, 1, 'codex', 'codex', 'codex', 'fact', now(), now())
      `,
      [
        memoryId,
        requestId,
        runId,
        `feedback loop target memory ${runId}`,
        `feedback loop ${runId}`,
        JSON.stringify({ source: "conversation_ingest", feedback_real_loop_run_id: runId }),
      ]
    );
    await pool.query(
      `
        INSERT INTO ${schema}.recall_traces (
          id, query_hash, query_excerpt, actor_id, scope_context, query_type, strategy,
          degrade_level, results, audit, created_at
        )
        VALUES ($1, $2, $3, 'test:feedback-real-loop', $4::jsonb, 'test', 'hybrid',
          0, $5::jsonb, '{}'::jsonb, now())
      `,
      [
        traceId,
        `query-${runId}`,
        `feedback loop query ${runId}`,
        JSON.stringify({ project_ids: [runId] }),
        JSON.stringify({ memory_ids: [memoryId] }),
      ]
    );

    const candidates = await runTraceFeedback(["candidates", "--limit=5", "--days=1"]);
    const used = await runTraceFeedback(["apply", `--trace-id=${traceId}`, `--memory-id=${memoryId}`, "--feedback-type=used_in_context", "--reason=feedback loop positive"]);
    const falseNull = await runTraceFeedback(["apply", `--trace-id=${traceId}`, "--feedback-type=false_null", "--reason=feedback loop false null"]);
    const freeze = shouldFreezeAutoApprovalCohortMetrics({
      sampleSize: 20,
      negativeCount: 1,
      rollbackCount: 0,
      manualArchiveDeleteCount: 0,
      recallNegativeCount: 1,
      positiveCount: 19,
      minSample: 20,
      falsePositiveFreezeRate: 0.05,
      rollbackFreezeRate: 0.03,
      manualArchiveDeleteFreezeRate: 0.05,
      recallNegativeFreezeRate: 0.05,
    });
    const repair = await pool.query(`SELECT * FROM ${schema}.recall_repair_queue WHERE recall_trace_id = $1`, [traceId]);
    const snapshot = await collectRuntimeSnapshot({ persist: false, schema: pgConfig.schema ?? "memory_xx" });
    if (used.ok !== true) failures.push({ step: "used-feedback", used });
    if (falseNull.ok !== true) failures.push({ step: "false-null-feedback", falseNull });
    if (repair.rowCount === 0) failures.push({ step: "repair-queue-missing" });
    if (!freeze.freeze || !freeze.triggeredBy.includes("false_positive_rate") || !freeze.triggeredBy.includes("recall_negative_feedback_rate")) {
      failures.push({ step: "freeze-metrics", freeze });
    }
    const report = {
      ok: failures.length === 0,
      run_id: runId,
      failures,
      candidates_count: Array.isArray(candidates.candidates) ? candidates.candidates.length : 0,
      used,
      false_null: falseNull,
      freeze,
      repair_count: repair.rowCount,
      runtime_feedback_1h: (snapshot.metrics.feedback as Record<string, unknown> | undefined)?.feedback_1h ?? null,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await pool.query(`DELETE FROM ${schema}.recall_repair_queue WHERE recall_trace_id = $1`, [traceId]).catch(() => undefined);
    await pool.query(`DELETE FROM ${schema}.recall_feedback_events WHERE recall_trace_id = $1`, [traceId]).catch(() => undefined);
    await pool.query(`DELETE FROM ${schema}.recall_traces WHERE id = $1`, [traceId]).catch(() => undefined);
    await pool.query(`DELETE FROM ${schema}.memory_records WHERE id = $1`, [memoryId]).catch(() => undefined);
    await pool.query(`DELETE FROM ${schema}.ingest_requests WHERE request_id = $1`, [requestId]).catch(() => undefined);
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
