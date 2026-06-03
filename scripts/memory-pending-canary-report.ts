#!/usr/bin/env tsx
import "./test-harness/config.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { planAutonomousPendingClosure, type PendingAutonomousClosureRow } from "../app/governance/memory-auto-approval-sweep";
import { buildPendingCanaryTrainingReport } from "../app/governance/pending-canary-training-report";
import { config } from "./test-harness/config.js";
import { closePool, createPool, query } from "./test-harness/lib/db-helpers.js";
import { quoteIdent } from "./lib/runtime-env";

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function readLimit(): number {
  const raw = Number.parseInt(argValue("--limit") ?? "500", 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 5000) : 500;
}

function defaultRunId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/gu, "");
  return `pending-canary-${date}-v1`;
}

async function loadPendingRows(limit: number): Promise<PendingAutonomousClosureRow[]> {
  const pool = createPool();
  const schema = quoteIdent(config.dbSchema);
  try {
    const rows = await query(pool,
      `SELECT id, scope_type, scope_id, title, content, memory_type, metadata, created_by
         FROM ${schema}.memory_records
        WHERE is_current = true
          AND lifecycle_status = 'candidate'
          AND review_state = 'pending'
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows.rows.map((record) => ({
      id: String(record.id),
      scope_type: String(record.scope_type),
      scope_id: String(record.scope_id),
      title: record.title === null || record.title === undefined ? null : String(record.title),
      content: String(record.content ?? ""),
      memory_type: record.memory_type === null || record.memory_type === undefined ? null : String(record.memory_type),
      metadata: record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
        ? record.metadata as Record<string, unknown>
        : {},
      created_by: record.created_by === null || record.created_by === undefined ? null : String(record.created_by),
    }));
  } finally {
    await closePool(pool);
  }
}

async function main(): Promise<void> {
  const json = hasFlag("--json");
  const writeReport = hasFlag("--write-report");
  const limit = readLimit();
  const runId = argValue("--run-id") ?? defaultRunId();
  const generatedAt = new Date().toISOString();
  const rows = await loadPendingRows(limit);
  const plan = planAutonomousPendingClosure(rows);
  const report = buildPendingCanaryTrainingReport({ runId, generatedAt, rows, plan });
  const reportDir = argValue("--report-dir") ?? path.join(process.cwd(), "reports", "memory-canary");
  const reportPath = path.join(reportDir, `${runId}.json`);
  const output = writeReport ? { ...report, report_path: reportPath } : report;

  if (writeReport) {
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(output, null, 2)}\n`);
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`pending canary report: run=${runId} pending=${report.pending_count} keep_pending=${report.sweep_summary.would_keep_pending}\n`);
    if (writeReport) process.stdout.write(`report: ${reportPath}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
