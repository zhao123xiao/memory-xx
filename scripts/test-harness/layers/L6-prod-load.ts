import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { httpPost, apiUrl } from "../lib/http-client.js";
import { createPool, query, closePool } from "../lib/db-helpers.js";
import { getCollectionInfo } from "../lib/qdrant-helpers.js";
import type { LayerReport, CheckResult } from "../report-model.js";
import { createEmptyReport, finalizeReport } from "../report-model.js";

const runId = generateRunId();
const report = createEmptyReport("L6", runId);

// Tier configuration
const TIERS = {
  smoke:    { total: 50,   concurrency: 5,  writeRatio: 0.3 },
  standard: { total: 500,  concurrency: 20, writeRatio: 0.3 },
  stress:   { total: 2000, concurrency: 50, writeRatio: 0.3 },
} as const;

function getTier(): keyof typeof TIERS {
  const arg = process.argv.find(a => a.startsWith("--tier="));
  const tier = arg?.split("=")[1] || "smoke";
  return tier in TIERS ? tier as keyof typeof TIERS : "smoke";
}

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : (severity === "warning" ? "WARN" : "FAIL");
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

interface LoadResult {
  status: number;
  durationMs: number;
  type: "write" | "recall";
  error?: string;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function sendWrite(): Promise<LoadResult> {
  const start = Date.now();
  try {
    const resp = await fetch(apiUrl("/api/memory/v2/write"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.wrapperToken}`,
        "X-API-Key": config.wrapperToken,
      },
      body: JSON.stringify({
        requestId: randomUUID(),
        actorId: `load-test-${runId}`,
        scopeType: "project",
        scopeId: `load-test-${runId}`,
        content: `Load test entry ${start} — ${Math.random().toString(36).slice(2)}`,
        title: `Load Test ${runId} ${start}`,
        metadata: { source: "memory-xx-prod-test", run_id: runId, tier: getTier() },
      }),
      signal: AbortSignal.timeout(30000),
    });
    return { status: resp.status, durationMs: Date.now() - start, type: "write" };
  } catch (e: any) {
    return { status: 0, durationMs: Date.now() - start, type: "write", error: e.message };
  }
}

async function sendRecall(): Promise<LoadResult> {
  const start = Date.now();
  try {
    const resp = await fetch(apiUrl("/api/memory/v2/recall/query"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.wrapperToken}`,
        "X-API-Key": config.wrapperToken,
      },
      body: JSON.stringify({
        query: `load test ${runId}`,
        scope_context: {
          user_id: `load-test-${runId}`,
          workspace_id: `load-test-${runId}`,
          include_global: true,
          project_ids: [`load-test-${runId}`],
        },
        limit: 5,
      }),
      signal: AbortSignal.timeout(30000),
    });
    return { status: resp.status, durationMs: Date.now() - start, type: "recall" };
  } catch (e: any) {
    return { status: 0, durationMs: Date.now() - start, type: "recall", error: e.message };
  }
}

async function main() {
  const tier = getTier();
  const cfg = TIERS[tier];

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L6 Production Load Test — run_id: ${runId}`);
  console.log(`  Tier: ${tier} (${cfg.total} req, c=${cfg.concurrency}, wr=${cfg.writeRatio})`);
  console.log(`${"=".repeat(50)}\n`);

  // Pre-snapshot
  let prePgCount = 0, preQdrantCount = 0;
  const pool = createPool();
  try {
    const r = await query(pool, `SELECT count(*) as cnt FROM ${config.dbSchema}.memory_records`);
    prePgCount = parseInt(r.rows[0]?.cnt || "0");
  } catch {}
  try {
    const info = await getCollectionInfo();
    preQdrantCount = info.pointsCount;
  } catch {}
  console.log(`  Pre-snapshot: PG=${prePgCount}, Qdrant=${preQdrantCount}`);

  // Run load test
  const results: LoadResult[] = [];
  let submitted = 0;
  let aborted = false;

  function claimSlot(): boolean {
    if (submitted >= cfg.total || aborted) return false;
    submitted++;
    return true;
  }

  async function worker(): Promise<void> {
    while (claimSlot()) {
      const isWrite = Math.random() < cfg.writeRatio;
      const result = isWrite ? await sendWrite() : await sendRecall();
      results.push(result);

      // Auto-abort check
      if (results.length % 50 === 0) {
        const errorRate = results.filter(r => r.status >= 500 || r.status === 0).length / results.length;
        if (errorRate > 0.05) {
          console.log(`  [ABORT] 5xx rate ${(errorRate * 100).toFixed(1)}% > 5%, stopping`);
          aborted = true;
          return;
        }
      }

      if (results.length % 100 === 0) {
        process.stdout.write(`  ${results.length}/${cfg.total}\r`);
      }
    }
  }

  console.log(`  Running...`);
  const workers = Array.from({ length: cfg.concurrency }, () => worker());
  await Promise.all(workers);

  // Analysis
  const durations = results.map(r => r.durationMs).sort((a, b) => a - b);
  const writes = results.filter(r => r.type === "write");
  const recalls = results.filter(r => r.type === "recall");
  const errors5xx = results.filter(r => r.status >= 500 || r.status === 0);
  const errors429 = results.filter(r => r.status === 429);
  const errors4xx = results.filter(r => r.status >= 400 && r.status < 500 && r.status !== 429);
  const totalTime = durations.reduce((a, b) => a + b, 0);
  const qps = results.length > 0 ? (results.length / totalTime * 1000) : 0;

  const errorRate5xx = results.length > 0 ? (errors5xx.length / results.length * 100) : 0;
  const p50 = durations.length > 0 ? percentile(durations, 50) : 0;
  const p95 = durations.length > 0 ? percentile(durations, 95) : 0;
  const p99 = durations.length > 0 ? percentile(durations, 99) : 0;

  console.log(`\n  === Results ===`);
  console.log(`  Total: ${results.length} (writes=${writes.length}, recalls=${recalls.length})`);
  console.log(`  5xx: ${errors5xx.length} (${errorRate5xx.toFixed(1)}%) | 429: ${errors429.length} | 4xx: ${errors4xx.length}`);
  console.log(`  QPS: ${qps.toFixed(1)}`);
  console.log(`  P50: ${p50}ms | P95: ${p95}ms | P99: ${p99}ms`);

  report.metrics["total_requests"] = results.length;
  report.metrics["writes"] = writes.length;
  report.metrics["recalls"] = recalls.length;
  report.metrics["errors_5xx"] = errors5xx.length;
  report.metrics["errors_429"] = errors429.length;
  report.metrics["qps"] = parseFloat(qps.toFixed(1));
  report.metrics["p50_ms"] = p50;
  report.metrics["p95_ms"] = p95;
  report.metrics["p99_ms"] = p99;
  report.metrics["aborted"] = aborted ? 1 : 0;

  // Gates
  check("load:5xx-rate", errorRate5xx < 1,
    `5xx rate: ${errorRate5xx.toFixed(1)}% (threshold: 1%)`,
    errorRate5xx < 1 ? "critical" : "critical");

  if (tier === "standard" || tier === "stress") {
    check("load:p95", p95 < 3000,
      `P95: ${p95}ms (threshold: 3000ms)`,
      p95 < 3000 ? "critical" : "warning");
    check("load:p99", p99 < 8000,
      `P99: ${p99}ms (threshold: 8000ms)`,
      p99 < 8000 ? "critical" : "warning");
  }

  check("load:abort", !aborted,
    aborted ? "Test was auto-aborted due to high error rate" : "No auto-abort triggered");

  // Post-snapshot
  let postPgCount = 0, postQdrantCount = 0;
  try {
    const r = await query(pool, `SELECT count(*) as cnt FROM ${config.dbSchema}.memory_records`);
    postPgCount = parseInt(r.rows[0]?.cnt || "0");
  } catch {}
  try {
    const info = await getCollectionInfo();
    postQdrantCount = info.pointsCount;
  } catch {}
  console.log(`  Post-snapshot: PG=${postPgCount}, Qdrant=${postQdrantCount}`);

  // Cleanup: tombstone load test records via API
  console.log(`  Cleaning up load test records via API...`);
  try {
    // Find all load test record IDs
    const r = await query(pool,
      `SELECT id FROM ${config.dbSchema}.memory_records WHERE scope_id='load-test-${runId}' AND lifecycle_status != 'tombstone'`,
    );
    const ids = r.rows.map((row: any) => row.id);
    if (ids.length === 0) {
      check("cleanup", true, "No load test records to clean");
    } else {
      let cleaned = 0, failed = 0;
      for (const memId of ids) {
        try {
          const resp = await httpPost(apiUrl("/api/memory/v2/orchestrator/forget-memory"), {
            memoryId: memId, mode: "tombstone", actorId: `load-test-cleanup-${runId}`, requestId: randomUUID(),
          }, { token: config.wrapperToken, timeout: 10000 });
          if (resp.status === 200) cleaned++;
          else failed++;
        } catch { failed++; }
      }
      check("cleanup", failed === 0,
        failed === 0 ? `${cleaned} records tombstoned via API` : `${cleaned} cleaned, ${failed} failed`,
        failed === 0 ? "critical" : "warning");
    }
    report.cleanup.performed = true;
    report.cleanup.resources_cleaned.push(`scope:load-test-${runId}`);
  } catch (e: any) {
    check("cleanup", false, `Cleanup error: ${e.message}`, "warning");
    report.cleanup.failed.push(`scope:load-test-${runId}`);
  }

  await closePool(pool);
  finalizeReport(report);

  console.log(`\n@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);

  const passed = report.checks.filter(c => c.passed).length;
  const total = report.checks.length;
  console.log(`\n  L6 Result: ${report.ok ? "PASS" : "FAIL"} (${passed}/${total} checks passed)\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
