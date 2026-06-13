import { config } from "../config.js";
import { createPool, query, closePool } from "../lib/db-helpers.js";
import { httpPost, apiUrl } from "../lib/http-client.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { createEmptyReport, finalizeReport, type CheckResult } from "../report-model.js";

const runId = generateRunId();
const report = createEmptyReport("L17", runId);

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL";
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L17 Knowledge Hybrid Recall — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  const pool = createPool();
  try {
    const status = await query(pool, `
      SELECT
        count(*)::int AS chunks,
        count(*) FILTER (WHERE qdrant_point_id IS NOT NULL AND qdrant_point_id <> '')::int AS chunks_with_qdrant_point_id,
        count(*) FILTER (WHERE content_hash IS NOT NULL)::int AS chunks_with_content_hash,
        count(*) FILTER (WHERE embedding_dimension = 4096)::int AS chunks_4096
      FROM knowledge_v1.chunks
    `);
    const row = status.rows[0] ?? {};
    const chunks = Number(row.chunks ?? 0);
    const qdrant = Number(row.chunks_with_qdrant_point_id ?? 0);
    const contentHash = Number(row.chunks_with_content_hash ?? 0);
    const dim4096 = Number(row.chunks_4096 ?? 0);
    check("knowledge:metadata-integrity", chunks > 0 && qdrant === chunks && contentHash === chunks && dim4096 === chunks,
      `chunks=${chunks}, qdrant_point_id=${qdrant}, content_hash=${contentHash}, dim4096=${dim4096}`);
    report.metrics["knowledge_chunks"] = chunks;
    report.metrics["knowledge_chunks_with_qdrant_point_id"] = qdrant;
    report.metrics["knowledge_chunks_with_content_hash"] = contentHash;
  } finally {
    await closePool(pool);
  }

  try {
    const resp = await httpPost(apiUrl("/api/memory/xx/knowledge/ingest"), {}, { token: config.wrapperToken, timeout: 10000 });
    const body = resp.body as any;
    check("knowledge:status-api", resp.status === 200 && body?.ok === true,
      `status=${resp.status}, collections=${Array.isArray(body?.collections) ? body.collections.length : "n/a"}`);
  } catch (error) {
    check("knowledge:status-api", false, error instanceof Error ? error.message : String(error), "warning");
  }

  try {
    const resp = await httpPost(apiUrl("/api/memory/xx/unified/recall"), {
      query: "memory-xx",
      scope_type: "project",
      scope_id: "memory-xx",
      limit: 2,
      include_knowledge: false
    }, { token: config.wrapperToken, timeout: 15000 });
    const body = resp.body as any;
    check("knowledge:default-opt-out", resp.status === 200 && body?.knowledge_results === undefined,
      `status=${resp.status}, knowledge_results=${body?.knowledge_results === undefined ? "absent" : "present"}`);
  } catch (error) {
    check("knowledge:default-opt-out", false, error instanceof Error ? error.message : String(error), "warning");
  }

  try {
    const resp = await httpPost(apiUrl("/api/memory/xx/unified/recall"), {
      query: "OpenAI Codex",
      scope_type: "project",
      scope_id: "memory-xx",
      limit: 2,
      include_knowledge: true,
      memory_budget: 2,
      knowledge_budget: 2
    }, { token: config.wrapperToken, timeout: 30000 });
    const body = resp.body as any;
    const hybridOk = resp.status === 200 && body?.knowledge_included === true && Array.isArray(body?.hybrid_results);
    check("knowledge:hybrid-opt-in", hybridOk,
      `status=${resp.status}, knowledge_included=${body?.knowledge_included}, hybrid_results=${Array.isArray(body?.hybrid_results) ? body.hybrid_results.length : "n/a"}, degraded=${body?.knowledge_degraded}`,
      hybridOk ? "critical" : "warning");
  } catch (error) {
    check("knowledge:hybrid-opt-in", false, error instanceof Error ? error.message : String(error), "warning");
  }

  finalizeReport(report);
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  check("fatal", false, error instanceof Error ? error.message : String(error));
  finalizeReport(report);
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(1);
});
