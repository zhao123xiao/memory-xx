import { config } from "../config.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { createEmptyReport, finalizeReport, type CheckResult } from "../report-model.js";
import { createLogger } from "../../../app/shared/logger";

const log = createLogger("L10");
const runId = generateRunId();
const report = createEmptyReport("L10", runId);
const BASE_URL = process.env.MEMORY_XX_TEST_URL || config.wrapperUrl;
const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + config.wrapperToken };

async function post(path: string, body: Record<string, unknown>) {
  const resp = await fetch(BASE_URL + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: resp.status, data: await resp.json() };
}

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL";
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L10 Temporal Governance — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  try {
    const { status, data } = await post("/api/memory/xx/recall/query", { query: "数据保留", temporal_scope: "current", limit: 5 });
    check("recall:temporal-current", status === 200 && Array.isArray(data.results), `status=${status}, results=${data.results?.length ?? "n/a"}`);
  } catch (err) { check("recall:temporal-current", false, (err as Error).message); }

  try {
    const { status, data } = await post("/api/memory/xx/recall/query", { query: "数据保留", temporal_scope: "all", limit: 5 });
    check("recall:temporal-all", status === 200 && Array.isArray(data.results), `status=${status}, results=${data.results?.length ?? "n/a"}`);
  } catch (err) { check("recall:temporal-all", false, (err as Error).message); }

  try {
    const { status, data } = await post("/api/memory/xx/recall/query", { query: "数据保留", limit: 3 });
    check("recall:backward-compatible", status === 200 && Array.isArray(data.results), `status=${status}, results=${data.results?.length ?? "n/a"}`);
  } catch (err) { check("recall:backward-compatible", false, (err as Error).message); }

  try {
    const { data } = await post("/api/memory/xx/recall/query", { query: "数据保留", limit: 1 });
    const memId = data.results?.[0]?.memory_id;
    if (!memId) {
      check("read-memory", true, "No recall result available; read-memory probe skipped", "warning");
    } else {
      const { status, data: rd } = await post("/api/memory/xx/orchestrator/read-memory", { memoryId: memId });
      check("read-memory", status === 200 && rd.memory?.id === memId, `status=${status}, memoryId=${memId}`);
    }
  } catch (err) { check("read-memory", false, (err as Error).message); }

  finalizeReport(report);
  log.info("Results", { passed: report.checks.filter(c => c.passed).length, failed: report.checks.filter(c => !c.passed).length, total: report.checks.length });
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => { check("fatal", false, err.message); finalizeReport(report); console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`); process.exit(1); });
