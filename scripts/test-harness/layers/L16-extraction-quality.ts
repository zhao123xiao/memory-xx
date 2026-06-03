import { config } from "../config.js";
import { httpPost } from "../lib/http-client.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { createEmptyReport, finalizeReport, type CheckResult } from "../report-model.js";

const runId = generateRunId();
const report = createEmptyReport("L16", runId);

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : severity === "warning" ? "WARN" : "FAIL";
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L16 Extraction Quality — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  const mem0Url = process.env.MEMORY_INTELLIGENCE_MEM0_URL || "http://127.0.0.1:5220";

  try {
    const response = await fetch(`${mem0Url.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(5000) });
    const body = await response.json().catch(() => ({}));
    check("mem0:health", response.status === 200 && body?.ok === true,
      `status=${response.status}, model=${body?.model ?? "unknown"}, protocol=${body?.protocol ?? "unknown"}`);
  } catch (error) {
    check("mem0:health", false, error instanceof Error ? error.message : String(error), "warning");
  }

  try {
    const response = await fetch(`${mem0Url.replace(/\/+$/, "")}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "这是临时测试，请不要把 run_id 或 schema 示例写入记忆", strategy_version: "v2" }),
      signal: AbortSignal.timeout(8000)
    });
    const body = await response.json().catch(() => ({}));
    check("mem0:skip-guard", response.status === 200 && body?.should_write === false && body?.operation === "no_change",
      `status=${response.status}, should_write=${body?.should_write}, operation=${body?.operation}, strategy=${body?.strategy}`);
  } catch (error) {
    check("mem0:skip-guard", false, error instanceof Error ? error.message : String(error), "warning");
  }

  try {
    const resp = await httpPost(`${config.wrapperUrl}/api/memory/v2/intelligence/extract`, {
      text: "这是临时测试，请不要把 schema example 写入记忆",
      agent_id: "l16-extraction-quality",
      scope_hint: { scope_type: "project", scope_id: `l16-${runId}` }
    }, { token: config.wrapperToken, timeout: 15000 });
    const body = resp.body as any;
    check("intelligence:no-write-precision", resp.status === 200 && body?.should_write === false,
      `status=${resp.status}, should_write=${body?.should_write}, failure_reason=${body?.failure_reason ?? "none"}`);
  } catch (error) {
    check("intelligence:no-write-precision", false, error instanceof Error ? error.message : String(error), "warning");
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
