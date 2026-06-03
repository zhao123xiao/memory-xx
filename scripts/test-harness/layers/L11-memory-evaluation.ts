import { config } from "../config.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { createEmptyReport, finalizeReport, type CheckResult } from "../report-model.js";
import { createLogger } from "../../../app/shared/logger";

const log = createLogger("L11");
const runId = generateRunId();
const report = createEmptyReport("L11", runId);
const BASE_URL = process.env.MEMORY_V2_TEST_URL || config.wrapperUrl;
const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + config.wrapperToken };
const createdMemoryIds: string[] = [];

async function post(path: string, body: Record<string, unknown>) {
  const resp = await fetch(BASE_URL + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: resp.status, data: await resp.json() };
}

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL";
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function cleanup() {
  report.cleanup.performed = true;
  for (const memoryId of createdMemoryIds) {
    try {
      const { status } = await post("/api/memory/v2/unified/forget", { memory_id: memoryId, agent_id: "l11-memory-evaluation", mode: "tombstone" });
      if (status >= 200 && status < 300) report.cleanup.resources_cleaned.push(memoryId);
      else report.cleanup.failed.push(`${memoryId}: status=${status}`);
    } catch (err) {
      report.cleanup.failed.push(`${memoryId}: ${(err as Error).message}`);
    }
  }
  check("cleanup:test-memories", report.cleanup.failed.length === 0, `cleaned=${report.cleanup.resources_cleaned.length}, failed=${report.cleanup.failed.length}`);
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L11 Memory Evaluation — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  try {
    const { status, data } = await post("/api/memory/v2/recall/query", { query: "数据保留策略", limit: 5 });
    const ok = status === 200 && (!data.results || data.results.every((r: any) => typeof r.score === "number" && r.score >= 0));
    check("metrics:scored-results", ok, `status=${status}, results=${data.results?.length ?? "n/a"}`);
  } catch (err) { check("metrics:scored-results", false, (err as Error).message); }

  try {
    const { status, data } = await post("/api/memory/v2/orchestrator/audit-memory-consistency", {});
    check("audit:consistency", status === 200 && data.ok === true, `status=${status}, ok=${data.ok}`);
  } catch (err) { check("audit:consistency", false, (err as Error).message); }

  try {
    const { status } = await post("/api/memory/v2/unified/remember", { user_id: "test" });
    check("unified:remember-required-fields", status === 400, `status=${status}`);
  } catch (err) { check("unified:remember-required-fields", false, (err as Error).message); }

  try {
    const { status, data } = await post("/api/memory/v2/unified/remember", {
      user_id: "l11-user",
      agent_id: "l11-agent",
      scope_id: `l11-${runId}`,
      content: `L11 memory evaluation test ${runId}`,
      metadata: { source: "memory-xx-test", run_id: runId },
    });
    if (data.memoryId) createdMemoryIds.push(data.memoryId);
    check("unified:remember-create", status === 201 && data.memoryId !== undefined, `status=${status}, memoryId=${data.memoryId ?? "missing"}`);
  } catch (err) { check("unified:remember-create", false, (err as Error).message); }

  await cleanup();
  finalizeReport(report);
  log.info("Results", { passed: report.checks.filter(c => c.passed).length, failed: report.checks.filter(c => !c.passed).length, total: report.checks.length });
  console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
  process.exit(report.ok ? 0 : 1);
}

main().catch(async (err) => { check("fatal", false, err.message); await cleanup(); finalizeReport(report); console.log(`@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`); process.exit(1); });
