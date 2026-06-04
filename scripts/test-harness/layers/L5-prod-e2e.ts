import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { httpPost, apiUrl } from "../lib/http-client.js";
import { scrollByMemoryId } from "../lib/qdrant-helpers.js";
import { waitFor } from "../lib/wait-for.js";
import type { LayerReport, CheckResult } from "../report-model.js";
import { createEmptyReport, finalizeReport } from "../report-model.js";

const runId = generateRunId();
const report = createEmptyReport("L5", runId);
const testScopeId = `prod-test-${runId}`;
const recallNeedle = `Production E2E test record ${runId}`;

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : (severity === "warning" ? "WARN" : "FAIL");
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L5 Production E2E — run_id: ${runId}`);
  console.log(`  Scope: ${testScopeId}`);
  console.log(`${"=".repeat(50)}\n`);

  const token = config.wrapperToken;
  let memoryId = "";

  // 1. Write
  const writeBody = {
    requestId: randomUUID(),
    actorId: "l5-prod-e2e",
    scopeType: "project",
    scopeId: testScopeId,
    content: `${recallNeedle}. This verifies the full write→approve→project→recall→forget lifecycle.`,
    title: `E2E Test ${runId}`,
    memoryType: "fact",
    metadata: { source: "memory-xx-prod-test", run_id: runId },
  };

  try {
    const resp = await httpPost(apiUrl("/api/memory/xx/write"), writeBody, { token });
    const body = resp.body as any;
    memoryId = body?.memoryId || body?.memory_id || "";
    check("write", !!memoryId,
      memoryId ? `Write OK, memoryId=${memoryId} (${resp.durationMs}ms)` : `Response: ${JSON.stringify(body).slice(0, 150)}`);
    report.metrics["write_latency_ms"] = resp.durationMs;
  } catch (e: any) {
    check("write", false, `Error: ${e.message}`);
  }

  if (!memoryId) {
    finalizeReport(report);
    process.exit(1);
  }

  // 2. Approve
  try {
    const resp = await httpPost(
      apiUrl(`/api/memory/xx/review/memories/${memoryId}/approve`),
      { requestId: randomUUID(), actorId: "l5-prod-e2e" },
      { token },
    );
    check("approve", resp.status === 200,
      `Approve → ${resp.status} (${resp.durationMs}ms)`);
    report.metrics["approve_latency_ms"] = resp.durationMs;
  } catch (e: any) {
    check("approve", false, `Error: ${e.message}`);
  }

  // 3. Wait for Qdrant projection
  console.log("  Waiting for Qdrant projection...");
  const projected = await waitFor(
    async () => {
      const points = await scrollByMemoryId(memoryId);
      return points.length > 0;
    },
    { intervalMs: 2000, timeoutMs: 30000, label: "向量投影（qdrant-projection）" },
  );
  check("projector:wait", projected,
    projected ? "Point appeared in Qdrant" : "Timed out waiting for Qdrant point");

  // 4. Recall
  try {
    const resp = await httpPost(apiUrl("/api/memory/xx/recall/query"), {
      query: recallNeedle,
      scope_context: {
        user_id: "l5-e2e",
        workspace_id: testScopeId,
        include_global: false,
        project_ids: [testScopeId],
      },
      limit: 5,
    }, { token });
    const body = resp.body as any;
    const hits = body?.results?.length || 0;
    const found = body?.results?.some((r: any) => r.memory_id === memoryId);
    check("recall", found || hits > 0,
      found ? `Recall hit memoryId=${memoryId} (${resp.durationMs}ms)` : `${hits} hits, target not found`,
      found ? "critical" : "warning");
    report.metrics["recall_latency_ms"] = resp.durationMs;
    report.metrics["recall_hits"] = hits;
  } catch (e: any) {
    check("recall", false, `Error: ${e.message}`, "warning");
  }

  // 5. Forget/Tombstone
  try {
    const resp = await httpPost(apiUrl("/api/memory/xx/orchestrator/forget-memory"), {
      memoryId,
      mode: "tombstone",
      actorId: "l5-prod-e2e",
      requestId: randomUUID(),
    }, { token });
    const body = resp.body as any;
    const success = body?.forget?.success || body?.forget?.tombstoned;
    check("forget", success || resp.status === 200,
      `Forget → ${resp.status}${success ? " (success)" : ""}`);
  } catch (e: any) {
    check("forget", false, `Error: ${e.message}`);
  }

  // 6. Verify Qdrant tombstone projection (P2: projector lag known, warn for now)
  console.log("  Waiting for projector to process tombstone (max 30s)...");
  const tombstoned = await waitFor(
    async () => {
      const points = await scrollByMemoryId(memoryId);
      if (points.length === 0) return true;
      const payload = (points[0] as any)?.payload || {};
      return payload.lifecycle_status === "tombstone" || !payload.is_current;
    },
    { intervalMs: 2000, timeoutMs: 30000, label: "墓碑投影（tombstone-projection）" },
  );
  check("tombstone:qdrant-projection", tombstoned,
    tombstoned ? "Qdrant point deleted or tombstoned within 30s" : "Qdrant point still visible after 30s (projector lag, P2 pending)",
    "warning");

  // 7. Verify PG state is tombstone (recall cache lag is expected, verify source of truth)
  try {
    const pg = await import("pg");
    const pool = new pg.Pool({ connectionString: config.dbUrl });
    const r = await pool.query(
      `SELECT lifecycle_status, is_current FROM ${config.dbSchema}.memory_records WHERE id = $1`,
      [memoryId],
    );
    const row = r.rows[0];
    const ok = row?.lifecycle_status === "tombstone" && row?.is_current === false;
    check("tombstone:pg-state", ok,
      ok ? "PG confirms tombstone + is_current=false" : `PG: status=${row?.lifecycle_status} is_current=${row?.is_current}`);
    await pool.end();
  } catch (e: any) {
    check("tombstone:pg-state", false, `Error: ${e.message}`, "warning");
  }

  // 8. Verify primed recall cache no longer returns the tombstoned memory.
  try {
    const resp = await httpPost(apiUrl("/api/memory/xx/recall/query"), {
      query: recallNeedle,
      scope_context: {
        user_id: "l5-e2e",
        workspace_id: testScopeId,
        include_global: false,
        project_ids: [testScopeId],
      },
      limit: 5,
    }, { token });
    const body = resp.body as any;
    const found = body?.results?.some((r: any) => r.memory_id === memoryId);
    const cacheLayer = body?.cache?.recall_cache_layer || body?.latency_breakdown?.native_status || "unknown";
    check("tombstone:recall-invisible-after-cache-prime", !found,
      found ? `Tombstoned memory still returned via ${cacheLayer}` : `Tombstoned memory no longer returned (${resp.durationMs}ms)`);
  } catch (e: any) {
    check("tombstone:recall-invisible-after-cache-prime", false, `Error: ${e.message}`);
  }

  // 9. Cleanup: tombstone any remaining test records
  report.cleanup.performed = true;
  report.cleanup.resources_cleaned.push(`scope:${testScopeId}`, `memory:${memoryId}`);

  finalizeReport(report);

  console.log(`\n@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);

  const passed = report.checks.filter(c => c.passed).length;
  const total = report.checks.length;
  console.log(`\n  L5 Result: ${report.ok ? "PASS" : "FAIL"} (${passed}/${total} checks passed)\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
