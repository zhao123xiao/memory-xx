import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { config } from "../config.js";
import { generateRunId, reportTimestamp } from "../lib/run-id.js";
import type { LayerReport, SummaryReport } from "../report-model.js";

export interface HarnessLayerScript {
  readonly id: string;
  readonly name: string;
  readonly script: string;
  readonly required: boolean;
}

export interface HarnessLayerOptions {
  readonly requireOpenClaw?: boolean;
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function openClawRequired(options: HarnessLayerOptions): boolean {
  return options.requireOpenClaw === true || envFlag("MEMORY_XX_REQUIRE_OPENCLAW_INTEGRATION");
}

export function buildHarnessLayerScripts(options: HarnessLayerOptions = {}): readonly HarnessLayerScript[] {
  const requireOpenClaw = openClawRequired(options);
  return [
  { id: "L0", name: "Static Gates",            script: "layers/L0-static-gates.ts",       required: true },
  { id: "L1", name: "Unit + Contract",          script: "layers/L1-unit-contract.ts",      required: true },
  { id: "L2", name: "Isolated Integration",     script: "layers/L2-isolated-integration.ts", required: false },
  { id: "L3", name: "Observation Gates",        script: "layers/L3-observation-gates.ts",  required: true },
  { id: "L4", name: "Recall Quality",           script: "layers/L4-recall-quality.ts",     required: true },
  { id: "L5", name: "Production E2E",           script: "layers/L5-prod-e2e.ts",           required: true },
  { id: "L6", name: "Production Load",          script: "layers/L6-prod-load.ts",          required: false },
  { id: "L7", name: "OpenClaw Integration",     script: "layers/L7-openclaw-integration.ts", required: requireOpenClaw },
  { id: "L8", name: "Intelligence E2E",        script: "layers/L8-intelligence-e2e.ts", required: true },
  { id: "L9", name: "MCP User Flow",           script: "layers/L9-mcp-user-flow.ts", required: true },
  { id: "L10", name: "Temporal Governance",    script: "layers/L10-temporal-governance.ts", required: true },
  { id: "L11", name: "Memory Evaluation",      script: "layers/L11-memory-evaluation.ts", required: true },
  { id: "L12", name: "Multi-Agent Contract",   script: "layers/L12-multi-agent-contract.ts", required: true },
  { id: "L13", name: "Knowledge E2E",           script: "layers/L13-knowledge-e2e.ts", required: true },
  { id: "L14", name: "Data Governance",         script: "layers/L14-data-governance.ts", required: true },
  { id: "L15", name: "Temporal Graph",          script: "layers/L15-temporal-graph.ts", required: true },
  { id: "L16", name: "Extraction Quality",      script: "layers/L16-extraction-quality.ts", required: true },
  { id: "L17", name: "Knowledge Hybrid Recall", script: "layers/L17-knowledge-hybrid-recall.ts", required: true },
  { id: "L18", name: "Graph Recall",            script: "layers/L18-graph-recall.ts", required: true },
  { id: "L19", name: "Conversation Monitor",   script: "layers/L19-conversation-monitor.ts", required: true },
  ];
}

function processSnapshot(): string {
  try {
    return execFileSync("ps", ["-eo", "pid,ppid,stat,etime,command"], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    })
      .split("\n")
      .filter((line) => /node|tsx|npm|memory-xx|test/iu.test(line))
      .slice(0, 100)
      .join("\n");
  } catch (error) {
    return `无法读取进程快照（process snapshot）：${error instanceof Error ? error.message : String(error)}`;
  }
}

function runLayerProcess(args: readonly string[], timeoutMs: number): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...args], {
      cwd: config.projectRoot,
      env: { ...process.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    let settled = false;
    const append = (chunk: Buffer | string): void => {
      const text = String(chunk);
      chunks.push(text);
      process.stdout.write(text);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const output = chunks.join("");
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
          else if (!child.killed) child.kill("SIGKILL");
        } catch {
          if (!child.killed) child.kill("SIGKILL");
        }
      }, 2000).unref();
      const diagnostic = [
        "",
        `all-gates layer timeout after ${timeoutMs}ms`,
        "最近输出尾部：",
        output.split("\n").slice(-160).join("\n"),
        "疑似相关子进程：",
        processSnapshot(),
      ].join("\n");
      process.stdout.write(diagnostic);
      resolve({ stdout: output + diagnostic, exitCode: 124 });
    }, timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = chunks.join("") + `\nlayer spawn error: ${error.message}\n`;
      process.stdout.write(output);
      resolve({ stdout: output, exitCode: 1 });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: chunks.join(""), exitCode: code ?? 1 });
    });
  });
}

function parseArgs(): { runAll: boolean; layers: string[]; tier: string; requireOpenClaw: boolean } {
  const args = process.argv.slice(2);
  const layerArg = args.find(a => a.startsWith("--layer="));
  const tierArg = args.find(a => a.startsWith("--tier="));
  const layers = layerArg ? layerArg.split("=")[1].split(",").filter(Boolean) : [];
  return {
    runAll: layers.length === 0 && (args.includes("--all") || args.length === 0),
    layers,
    tier: tierArg ? tierArg.split("=")[1] : "smoke",
    requireOpenClaw: args.includes("--require-openclaw") || envFlag("MEMORY_XX_REQUIRE_OPENCLAW_INTEGRATION"),
  };
}

async function main() {
  const runId = generateRunId();
  const ts = reportTimestamp();
  const reportDir = `${config.reportDir}/${ts}`;
  const parsedArgs = parseArgs();
  const { runAll, layers } = parsedArgs;
  const layerScripts = buildHarnessLayerScripts({ requireOpenClaw: parsedArgs.requireOpenClaw });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  memory-xx Test Framework — run_id: ${runId}`);
  console.log(`  Report dir: ${reportDir}`);
  console.log(`${"=".repeat(60)}\n`);

  fs.mkdirSync(reportDir, { recursive: true });

  const toRun = runAll
    ? layerScripts
    : layerScripts.filter(l => layers.includes(l.id));

  if (toRun.length === 0) {
    console.log("No layers to run. Use --all or --layer=L0,L1,L3");
    process.exit(1);
  }

  const layerReports: Record<string, LayerReport> = {};
  let anyCriticalFail = false;

  for (const layer of toRun) {
    const scriptPath = path.join(config.projectRoot, "scripts/test-harness", layer.script);
    if (!fs.existsSync(scriptPath)) {
      console.log(`  SKIP ${layer.id}: script not found`);
      layerReports[layer.id] = {
        ok: false, run_id: runId, started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(), target: layer.id,
        checks: [{ name: "skipped", passed: false, detail: "Script not found", severity: "warning" }],
        metrics: {}, artifacts: [], cleanup: { performed: false, resources_cleaned: [], failed: [] },
      };
      continue;
    }

    console.log(`\n${"─".repeat(50)}`);
    console.log(`  Running ${layer.id}: ${layer.name}${layer.required ? " (required)" : ""}`);
    console.log(`${"─".repeat(50)}`);

    const tierArg = layer.id === "L6" ? ` --tier=${parsedArgs.tier}` : "";
    const args = ["--import", "tsx", `scripts/test-harness/${layer.script}`];
    if (tierArg) args.push(tierArg.trim());
    const { stdout, exitCode } = await runLayerProcess(args, 600000);

    // Try to parse layer JSON report from output
    let layerReport: LayerReport | null = null;
    try {
      // Look for a JSON report line marker
      const jsonMatch = stdout.match(/@@LAYER_REPORT@@\s*([\s\S]*?)@@END_REPORT@@/);
      if (jsonMatch) {
        layerReport = JSON.parse(jsonMatch[1]);
      }
    } catch {}

    // Fallback: reconstruct from exit code and output
    if (!layerReport) {
      const passed = exitCode === 0;
      // Try to count checks from output
      const passCount = (stdout.match(/\[PASS\]/g) || []).length;
      const failCount = (stdout.match(/\[FAIL\]/g) || []).length;
      const warnCount = (stdout.match(/\[WARN\]/g) || []).length;

      layerReport = {
        ok: passed,
        run_id: runId,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        target: layer.id,
        checks: [
          { name: "exit_code", passed, detail: passed ? "All checks passed" : `Exit code ${exitCode}`, severity: passed ? "info" : "critical" },
        ],
        metrics: { pass_count: passCount, fail_count: failCount, warn_count: warnCount },
        artifacts: [],
        cleanup: { performed: false, resources_cleaned: [], failed: [] },
      };
    }

    layerReports[layer.id] = layerReport;

    // Track critical failures
    if (!layerReport.ok && layer.required) {
      anyCriticalFail = true;
      console.log(`  >>> ${layer.id} REQUIRED layer FAILED — marking overall as FAIL`);
    }

    // Save per-layer output
    try {
      fs.writeFileSync(path.join(reportDir, `${layer.id}-output.txt`), stdout);
      if (layerReport) {
        fs.writeFileSync(path.join(reportDir, `${layer.id}-report.json`), JSON.stringify(layerReport, null, 2));
      }
    } catch {}
  }

  // Generate summary
  let totalChecks = 0, passedChecks = 0, failedChecks = 0;
  for (const report of Object.values(layerReports)) {
    totalChecks += report.checks.length;
    passedChecks += report.checks.filter(c => c.passed).length;
    failedChecks += report.checks.filter(c => !c.passed).length;
  }

  const summary: SummaryReport = {
    ok: !anyCriticalFail,
    run_id: runId,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    layers: layerReports,
    overall_checks_total: totalChecks,
    overall_checks_passed: passedChecks,
    overall_checks_failed: failedChecks,
  };

  // Write JSON report
  fs.writeFileSync(path.join(reportDir, "summary.json"), JSON.stringify(summary, null, 2));

  // Write Markdown report
  const md: string[] = [
    `# memory-xx Test Report`,
    ``,
    `- **Run ID**: ${runId}`,
    `- **Time**: ${summary.started_at}`,
    `- **Result**: ${summary.ok ? "PASS" : "FAIL"}`,
    `- **Checks**: ${passedChecks}/${totalChecks} passed (${failedChecks} failed)`,
    ``,
    `## Layer Results`,
    ``,
    `| Layer | Name | Required | Result | Checks |`,
    `|-------|------|----------|--------|--------|`,
  ];

  for (const layer of layerScripts) {
    const report = layerReports[layer.id];
    if (!report) continue;
    const icon = report.ok ? "PASS" : "FAIL";
    const req = layer.required ? "Yes" : "No";
    const checkSummary = `${report.checks.filter(c => c.passed).length}/${report.checks.length}`;
    md.push(`| ${layer.id} | ${layer.name} | ${req} | ${icon} | ${checkSummary} |`);
  }

  md.push("");
  md.push("## Layer Details");
  md.push("");

  for (const [id, report] of Object.entries(layerReports)) {
    md.push(`### ${id}`);
    md.push(`- **OK**: ${report.ok}`);
    for (const check of report.checks) {
      const icon = check.passed ? "x" : " ";
      md.push(`- [${icon}] ${check.name}: ${check.detail}`);
    }
    if (Object.keys(report.metrics).length > 0) {
      md.push("");
      md.push("**Metrics**:");
      for (const [k, v] of Object.entries(report.metrics)) {
        md.push(`- ${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : v}`);
      }
    }
    md.push("");
  }

  fs.writeFileSync(path.join(reportDir, "summary.md"), md.join("\n"));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Report:  ${reportDir}/summary.md`);
  console.log(`  JSON:    ${reportDir}/summary.json`);
  console.log(`  Result:  ${summary.ok ? "PASS" : "FAIL"}`);
  console.log(`  Checks:  ${passedChecks}/${totalChecks} passed`);
  console.log(`${"=".repeat(60)}\n`);

  process.exit(summary.ok ? 0 : 1);
}

const entrypoint = process.argv[1] ?? "";
if (entrypoint.endsWith("scripts/test-harness/reports/aggregator.ts") || entrypoint.endsWith("scripts\\test-harness\\reports\\aggregator.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
