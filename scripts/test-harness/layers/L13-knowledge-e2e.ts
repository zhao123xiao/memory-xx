import { config } from "../config.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { createEmptyReport, finalizeReport, type CheckResult } from "../report-model.js";
import { createLogger } from "../../../app/shared/logger";

const log = createLogger("L13");
const runId = generateRunId();
const report = createEmptyReport("L13", runId);
const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + config.wrapperToken };

async function post(path: string, body: Record<string, unknown>) {
  const resp = await fetch(config.wrapperUrl + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: resp.status, data: await resp.json() };
}

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL";
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L13 Knowledge E2E — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  try {
    const { status, data } = await post("/api/memory/v2/knowledge/ingest", {});
    const collections = Array.isArray(data.collections) ? data.collections : [];
    const chunks = collections.reduce((sum: number, row: any) => sum + (Number(row.chunks) || 0), 0);
    check("knowledge:status", status === 200 && data.ok === true && chunks >= 12_000,
      `status=${status}, collections=${collections.length}, chunks=${chunks}`);
    report.metrics["knowledge_chunks"] = chunks;
  } catch (error) {
    check("knowledge:status", false, (error as Error).message);
  }

  try {
    const { status, data } = await post("/api/memory/v2/knowledge/search", {
      query: "OpenAI Codex sandbox permissions",
      limit: 3,
      knowledge_collections: ["openai_codex_source_qwen8b_api"],
    });
    const first = data.results?.[0];
    check("knowledge:search", status === 200 && data.ok === true && data.results?.length > 0,
      `status=${status}, results=${data.results?.length ?? 0}, first=${first?.source_path ?? "none"}`);
  } catch (error) {
    check("knowledge:search", false, (error as Error).message);
  }

  try {
    const { status, data } = await post("/api/memory/v2/unified/recall", {
      query: "OpenAI Codex sandbox permissions",
      scope_type: "project",
      scope_id: "memory-xx",
      limit: 2,
      include_knowledge: true,
      knowledge_budget: 2,
      knowledge_collections: ["openai_codex_source_qwen8b_api"],
    });
    check("unified:recall-knowledge-opt-in", status === 200 && data.knowledge_included === true && data.knowledge_results?.length > 0,
      `status=${status}, memory=${data.results?.length ?? 0}, knowledge=${data.knowledge_results?.length ?? 0}`);
  } catch (error) {
    check("unified:recall-knowledge-opt-in", false, (error as Error).message);
  }

  finalizeReport(report);
  log.info("Results", { passed: report.checks.filter(c => c.passed).length, failed: report.checks.filter(c => !c.passed).length, total: report.checks.length });
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  check("fatal", false, error instanceof Error ? error.message : String(error));
  finalizeReport(report);
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(1);
});
