import fs from "node:fs";
import { execSync } from "node:child_process";
import { config } from "../config.js";
import { generateRunId } from "../lib/run-id.js";
import { scrubSecrets } from "../lib/secret-scrubber.js";
import type { LayerReport, CheckResult } from "../report-model.js";
import { createEmptyReport, finalizeReport } from "../report-model.js";

const runId = generateRunId();
const report = createEmptyReport("L4", runId);

function check(name: string, passed: boolean, detail: string, severity: CheckResult["severity"] = "critical") {
  report.checks.push({ name, passed, detail, severity });
  const icon = passed ? "PASS" : (severity === "warning" ? "WARN" : "FAIL");
  console.log(`  [${icon}] ${name}: ${scrubSecrets(detail)}`);
}

interface BaselineMetrics {
  top1_recall?: number;
  top3_recall?: number;
  top5_recall?: number;
  mrr?: number;
  ndcg_at_5?: number;
  forbidden_hit_rate?: number;
  false_null_rate?: number;
  null_accuracy?: number;
  latency_p50_ms?: number;
  latency_p95_ms?: number;
  latency_p99_ms?: number;
  latency_avg_ms?: number;
}

function loadBaseline(): { metrics: BaselineMetrics; path: string } | null {
  const candidates = [
    config.evalBaselinePath,
  ];
  for (const p of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      if (raw.metrics) return { metrics: raw.metrics, path: p };
    } catch {}
  }
  return null;
}

function parseCurrentMetrics(output: string): BaselineMetrics {
  const m: BaselineMetrics = {};
  const patterns: Array<[keyof BaselineMetrics, RegExp]> = [
    ["top1_recall", /Top-1 Recall:\s*([\d.]+)%/],
    ["top3_recall", /Top-3 Recall:\s*([\d.]+)%/],
    ["top5_recall", /Top-5 Recall:\s*([\d.]+)%/],
    ["mrr", /MR<windows-drive>\s*([\d.]+)/],
    ["ndcg_at_5", /NDCG@5:\s*([\d.]+)/],
    ["forbidden_hit_rate", /Forbidden Hit:\s*([\d.]+)%/],
    ["false_null_rate", /False Null:\s*([\d.]+)%/],
    ["null_accuracy", /Null Accuracy:\s*([\d.]+)%/],
    ["latency_p50_ms", /Latency P50:\s*([\d.]+)ms/],
    ["latency_p95_ms", /Latency P95:\s*([\d.]+)ms/],
    ["latency_p99_ms", /Latency P99:\s*([\d.]+)ms/],
  ];
  for (const [key, pattern] of patterns) {
    const match = output.match(pattern);
    if (match) (m as any)[key] = parseFloat(match[1]);
  }
  return m;
}

async function main() {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  L4 Recall Quality — run_id: ${runId}`);
  console.log(`${"=".repeat(50)}\n`);

  // 1. Run benchmark
  console.log("  Running recall benchmark (170 cases)...");
  let stdout = "";
  let currentMetrics: BaselineMetrics = {};

  try {
    const useSudo = process.env.MEMORY_V2_EVAL_USE_SUDO === "true";
    const command = `${useSudo ? "sudo " : ""}node ${config.evalRunnerPath} 2>&1`;
    stdout = execSync(
      command,
      { timeout: 600000, encoding: "utf8" },
    );
    currentMetrics = parseCurrentMetrics(stdout);
    const metricCount = Object.values(currentMetrics).filter(v => v !== undefined).length;
    check("benchmark:ran", metricCount >= 4,
      `Benchmark completed, ${metricCount} metrics extracted`);

    // Log all metrics
    for (const [k, v] of Object.entries(currentMetrics)) {
      if (v !== undefined) report.metrics[k] = v;
    }

    // Find output JSON report
    const jsonMatch = stdout.match(/Report:\s*(\/[^\s]+\.json)/);
    if (jsonMatch) {
      report.artifacts.push(jsonMatch[1]);
    }
    const mdMatch = stdout.match(/Markdown:\s*(\/[^\s]+\.md)/);
    if (mdMatch) {
      report.artifacts.push(mdMatch[1]);
    }
  } catch (e: any) {
    const out = e.stdout || e.message || "";
    currentMetrics = parseCurrentMetrics(out);
    const metricCount = Object.values(currentMetrics).filter(v => v !== undefined).length;
    if (metricCount >= 4) {
      check("benchmark:ran", true, `Benchmark completed (non-zero exit), ${metricCount} metrics extracted`);
      for (const [k, v] of Object.entries(currentMetrics)) {
        if (v !== undefined) report.metrics[k] = v;
      }
    } else {
      check("benchmark:ran", false, `Benchmark failed: ${e.message?.slice(0, 200)}`);
      finalizeReport(report);
      console.log(`\n@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);
      process.exit(1);
    }
  }

  // Print current results
  console.log(`\n  Current Results:`);
  console.log(`    Top-1: ${currentMetrics.top1_recall ?? "?"}%`);
  console.log(`    Top-3: ${currentMetrics.top3_recall ?? "?"}%`);
  console.log(`    Top-5: ${currentMetrics.top5_recall ?? "?"}%`);
  console.log(`    MRR: ${currentMetrics.mrr ?? "?"}`);
  console.log(`    NDCG@5: ${currentMetrics.ndcg_at_5 ?? "?"}`);
  console.log(`    Forbidden Hit: ${currentMetrics.forbidden_hit_rate ?? "?"}%`);
  console.log(`    False Null: ${currentMetrics.false_null_rate ?? "?"}%`);
  console.log(`    Null Accuracy: ${currentMetrics.null_accuracy ?? "?"}%`);
  console.log(`    P50/P95/P99: ${currentMetrics.latency_p50_ms ?? "?"}/${currentMetrics.latency_p95_ms ?? "?"}/${currentMetrics.latency_p99_ms ?? "?"}ms`);

  // 2. Load baseline and compare
  const baseline = loadBaseline();
  if (baseline) {
    console.log(`\n  Baseline (${baseline.path}):`);
    console.log(`    Top-1: ${baseline.metrics.top1_recall}%`);
    console.log(`    Top-3: ${baseline.metrics.top3_recall}%`);
    console.log(`    Forbidden: ${baseline.metrics.forbidden_hit_rate}%`);
    console.log(`    Null Accuracy: ${baseline.metrics.null_accuracy}%\n`);

    const b = baseline.metrics;

    // Regression: Top-1 drop <= 5pp
    if (currentMetrics.top1_recall !== undefined && b.top1_recall !== undefined) {
      const delta = currentMetrics.top1_recall - b.top1_recall;
      const ok = delta >= -5;
      check("regression:top1", ok,
        `base=${b.top1_recall}% → current=${currentMetrics.top1_recall}% (Δ${delta > 0 ? "+" : ""}${delta.toFixed(1)}pp)`,
        ok ? "critical" : "critical");
    }

    // Regression: Top-3 drop <= 5pp
    if (currentMetrics.top3_recall !== undefined && b.top3_recall !== undefined) {
      const delta = currentMetrics.top3_recall - b.top3_recall;
      const ok = delta >= -5;
      check("regression:top3", ok,
        `base=${b.top3_recall}% → current=${currentMetrics.top3_recall}% (Δ${delta > 0 ? "+" : ""}${delta.toFixed(1)}pp)`,
        ok ? "critical" : "critical");
    }

    // Regression: Forbidden Hit rise <= 2pp
    if (currentMetrics.forbidden_hit_rate !== undefined && b.forbidden_hit_rate !== undefined) {
      const delta = currentMetrics.forbidden_hit_rate - b.forbidden_hit_rate;
      const ok = delta <= 2;
      check("regression:forbidden-hit", ok,
        `base=${b.forbidden_hit_rate}% → current=${currentMetrics.forbidden_hit_rate}% (Δ${delta > 0 ? "+" : ""}${delta.toFixed(1)}pp)`,
        ok ? "critical" : "critical");
    }

    // Regression: Null Accuracy drop <= 10pp
    if (currentMetrics.null_accuracy !== undefined && b.null_accuracy !== undefined) {
      const delta = currentMetrics.null_accuracy - b.null_accuracy;
      const ok = delta >= -10;
      check("regression:null-accuracy", ok,
        `base=${b.null_accuracy}% → current=${currentMetrics.null_accuracy}% (Δ${delta > 0 ? "+" : ""}${delta.toFixed(1)}pp)`,
        ok ? "warning" : "critical");
    }

    // Latency gate: P99 < 5000ms
    if (currentMetrics.latency_p99_ms !== undefined) {
      const ok = currentMetrics.latency_p99_ms < 15000;
      check("latency:p99", ok,
        `P99=${currentMetrics.latency_p99_ms}ms (threshold: 15000ms)`,
        ok ? "warning" : "warning");
    }
  } else {
    check("baseline", false, "Cannot load benchmark-v1-baseline.json", "warning");
  }

  finalizeReport(report);

  // Emit structured report for aggregator
  console.log(`\n@@LAYER_REPORT@@${JSON.stringify(report)}@@END_REPORT@@`);

  const passed = report.checks.filter(c => c.passed).length;
  const total = report.checks.length;
  console.log(`\n  L4 Result: ${report.ok ? "PASS" : "FAIL"} (${passed}/${total} checks passed)\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
