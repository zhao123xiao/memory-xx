import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import { httpPost, apiUrl } from "../lib/http-client.js";
import type { CheckResult } from "../report-model.js";
import { createEmptyReport, finalizeReport } from "../report-model.js";

const runId = generateRunId();
const report = createEmptyReport("L8", runId);
const HTTP_TIMEOUT_MS = 45000;

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : (severity === "warning" ? "WARN" : "FAIL");
  console.log("  [" + icon + "] " + name + ": " + scrubSecrets(detail));
}

function memories(body: any): any[] {
  return Array.isArray(body?.memories) ? body.memories : [];
}

function loadRecentFallbackRates(limit: number): number[] {
  try {
    const dirs = fs.readdirSync(config.reportDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    const rates: number[] = [];
    for (const dir of dirs) {
      const reportPath = path.join(config.reportDir, dir, "L8-report.json");
      if (!fs.existsSync(reportPath)) continue;
      const parsed = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      const rate = Number(parsed?.metrics?.fallback_rate);
      if (Number.isFinite(rate)) rates.push(rate);
      if (rates.length >= limit) break;
    }
    return rates;
  } catch {
    return [];
  }
}

async function main() {
  console.log("\n" + "=".repeat(50));
  console.log("  L8 Intelligence E2E - run_id: " + runId);
  console.log("=".repeat(50) + "\n");

  const text = "请记住：以后 memory-xx P4 测试报告必须先给结论，再列证据，不要写太长。测试标记 " + runId;
  const scopeHint = { scope_type: "project", scope_id: "intelligence-e2e-" + runId };

  const extractionCases = [
    { id: "remember-report-rule", text, expectWrite: true },
    { id: "remember-model-routing", text: "以后关于模型选择，优先使用本地小模型做高频轻任务，复杂冲突交给远程大模型。测试标记 " + runId, expectWrite: true },
    { id: "remember-release-procedure", text: "记一下：发布前先跑 smoke，再跑 standard，失败时先清理测试 scope 再回滚。测试标记 " + runId, expectWrite: true },
    { id: "temporary-skip", text: "今天只是临时测试，不需要记住。测试标记 " + runId, expectWrite: false },
    { id: "question-skip", text: "这套记忆框架现在还有哪些问题？测试标记 " + runId, expectWrite: false },
  ];

  let fallbackCount = 0;
  const fallbackReasons: Record<string, number> = {};
  let mem0UsedCount = 0;
  let mem0ErrorCount = 0;
  let schemaRepairCount = 0;
  let transportErrorCount = 0;
  let provider = "unknown";
  let mem0StrategyVersion = "unknown";
  let maxExtractLatency = 0;
  const strategyCounts: Record<string, number> = {};

  try {
    for (const tc of extractionCases) {
      const resp = await httpPost(apiUrl("/api/memory/xx/intelligence/extract"), {
        text: tc.text,
        agent_id: "l8-intelligence-e2e",
        scope_hint: scopeHint,
      }, { token: config.wrapperToken, timeout: HTTP_TIMEOUT_MS });
      const body = resp.body as any;
      const ms = memories(body);
      const fallbackUsed = body?.fallback_used === true;
      const reason = body?.fallback_reason || "none";
      provider = body?.provider || provider;
      mem0StrategyVersion = body?.mem0_strategy_version || body?.strategy_version || mem0StrategyVersion;
      if (body?.mem0_used === true) mem0UsedCount += 1;
      const mem0Reason = body?.mem0_fallback_reason || body?.failure_reason;
      const transportError = body?.transport_error === true || ["llm_http_429", "llm_http_5xx", "timeout", "network_error", "http_error"].includes(mem0Reason);
      if (transportError) mem0ErrorCount += 1;
      if (body?.schema_repair_applied === true) schemaRepairCount += 1;
      if (transportError) transportErrorCount += 1;
      const strategy = body?.strategy || "unknown";
      strategyCounts[strategy] = (strategyCounts[strategy] ?? 0) + 1;
      maxExtractLatency = Math.max(maxExtractLatency, resp.durationMs);
      if (fallbackUsed) {
        fallbackCount += 1;
        fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
      }

      check("extract:" + tc.id + ":http", resp.status === 200, "status=" + resp.status + " latency=" + resp.durationMs + "ms");
      check("extract:" + tc.id + ":ok", body?.ok === true && body?.should_write === tc.expectWrite,
        "ok=" + body?.ok + " should_write=" + body?.should_write + " expected=" + tc.expectWrite + " error=" + (body?.error || ""));
      if (tc.expectWrite) {
        check("extract:" + tc.id + ":canonical", ms.length > 0 && typeof ms[0]?.canonical_content === "string" && ms[0].canonical_content.length > 0,
          ms[0]?.canonical_content || "no canonical content");
        check("extract:" + tc.id + ":not-raw", ms.length > 0 && ms[0]?.canonical_content !== tc.text, "canonical differs from raw text");
      }
      check("extract:" + tc.id + ":model-trace", !!body?.model?.primary && !!body?.model?.final, JSON.stringify(body?.model || {}), "info");
      check("extract:" + tc.id + ":provider", !!body?.provider,
        "provider=" + (body?.provider || "none") + " mem0_used=" + (body?.mem0_used === true), "info");
      check("extract:" + tc.id + ":fallback-reason", fallbackUsed ? reason !== "none" : true,
        "fallback_used=" + fallbackUsed + " reason=" + reason, fallbackUsed ? "critical" : "info");
    }

    const fallbackRate = extractionCases.length === 0 ? 0 : fallbackCount / extractionCases.length;
    report.metrics["extract_cases"] = extractionCases.length;
    report.metrics["extract_max_latency_ms"] = maxExtractLatency;
    report.metrics["fallback_count"] = fallbackCount;
    report.metrics["fallback_rate"] = Number(fallbackRate.toFixed(4));
    report.metrics["fallback_reasons"] = fallbackReasons as any;
    report.metrics["intelligence_provider"] = provider;
    report.metrics["mem0_strategy_version"] = mem0StrategyVersion;
    report.metrics["strategy_counts"] = strategyCounts as any;
    report.metrics["mem0_used"] = mem0UsedCount > 0 ? 1 : 0;
    report.metrics["mem0_used_rate"] = Number((mem0UsedCount / extractionCases.length).toFixed(4));
    report.metrics["mem0_error_rate"] = Number((mem0ErrorCount / extractionCases.length).toFixed(4));
    report.metrics["schema_repair_rate"] = Number((schemaRepairCount / extractionCases.length).toFixed(4));
    report.metrics["transport_error_rate"] = Number((transportErrorCount / extractionCases.length).toFixed(4));
    report.metrics["native_shadow_disagreement_rate"] = 0;
    check("extract:fallback-rate", true,
      "fallback_count=" + fallbackCount + "/" + extractionCases.length + " rate=" + (fallbackRate * 100).toFixed(1) + "% reasons=" + JSON.stringify(fallbackReasons), "info");
    const recentRates = [fallbackRate, ...loadRecentFallbackRates(2)];
    const hasThreeRuns = recentRates.length >= 3;
    const rollingCritical = hasThreeRuns && recentRates.every((rate) => rate > 0.5);
    const rollingWarning = hasThreeRuns && recentRates.every((rate) => rate > 0.2);
    check("extract:fallback-rate-rolling", !rollingCritical && !rollingWarning,
      "latest_rates=" + recentRates.map((rate) => (rate * 100).toFixed(1) + "%").join(",") +
        (hasThreeRuns ? "" : " (need 3 runs for threshold)"),
      rollingCritical ? "critical" : rollingWarning ? "warning" : "info");
    check("extract:latency", maxExtractLatency < 45000, "max_latency=" + maxExtractLatency + "ms");
  } catch (e: any) {
    check("extract:http", false, "Error: " + e.message);
  }

  try {
    const resp = await httpPost(apiUrl("/api/memory/xx/intelligence/smart-write"), {
      text,
      agent_id: "l8-intelligence-e2e",
      scope_hint: scopeHint,
      mode: "draft",
    }, { token: config.wrapperToken, timeout: HTTP_TIMEOUT_MS });
    const body = resp.body as any;
    check("smart-write:draft", resp.status === 200 && Array.isArray(body?.created) && body.created.length === 0, "status=" + resp.status + " created=" + (body?.created?.length ?? "?") + " fallback_used=" + (body?.fallback_used === true));
  } catch (e: any) {
    check("smart-write:draft", false, "Error: " + e.message);
  }

  finalizeReport(report);
  console.log("\n@@LAYER_REPORT@@" + JSON.stringify(report) + "@@END_REPORT@@");
  const passed = report.checks.filter(c => c.passed).length;
  const total = report.checks.length;
  console.log("\n  L8 Result: " + (report.ok ? "PASS" : "FAIL") + " (" + passed + "/" + total + " checks passed)\n");
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
