#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildMemoryLandingScanReport } from "../app/governance/memory-landing-scan";

interface CommandResult {
  readonly ok: boolean;
  readonly exit_code: number;
  readonly json: Record<string, unknown> | null;
  readonly error?: string | null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function parseJsonFromOutput(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

function runJsonCommand(args: readonly string[]): CommandResult {
  try {
    const stdout = execFileSync(args[0] ?? "npm", args.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: "/tmp" },
      encoding: "utf8",
      maxBuffer: 80 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, exit_code: 0, json: parseJsonFromOutput(stdout) };
  } catch (error: any) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    return {
      ok: false,
      exit_code: typeof error?.status === "number" ? error.status : 1,
      json: stdout ? parseJsonFromOutput(stdout) : null,
      error: stderr.trim() || (error instanceof Error ? error.message : String(error)),
    };
  }
}

async function main(): Promise<void> {
  const json = hasFlag("--json");
  const writeReport = hasFlag("--write-report");
  const maxFiles = argValue("--max-files") ?? "100";
  const reportDir = argValue("--report-dir") ?? path.join(process.cwd(), "reports", "memory-landing-scan");

  const memoryStatus = runJsonCommand(["tsx", "scripts/memory-status.ts", "--json"]);
  const pending = runJsonCommand(["tsx", "scripts/memory-pending.ts", "--json"]);
  const qdrantReconcile = runJsonCommand(["tsx", "scripts/qdrant-reconcile.ts", "--json"]);
  const p1Gate = runJsonCommand(["tsx", "scripts/p1-production-gate.ts"]);
  const policyReport = runJsonCommand(["tsx", "scripts/memory-policy-report.ts", "--json"]);
  const autoApprovalStatus = runJsonCommand(["tsx", "scripts/memory-auto-approval.ts", "status", "--json"]);
  const productionGuard = runJsonCommand(["tsx", "scripts/memory-auto-approval.ts", "production-guard", "--json"]);
  const conversationSources = runJsonCommand(["tsx", "scripts/memory-conversation-sources.ts", "scan", "--dry-run", "--json", `--max-files=${maxFiles}`]);
  const conversationMonitorReport = runJsonCommand(["tsx", "scripts/memory-conversation-monitor-report.ts", "--json"]);

  const commandStatus = {
    memory_status: { ok: memoryStatus.ok, exit_code: memoryStatus.exit_code, error: memoryStatus.error ?? null },
    pending: { ok: pending.ok, exit_code: pending.exit_code, error: pending.error ?? null },
    qdrant_reconcile: { ok: qdrantReconcile.ok, exit_code: qdrantReconcile.exit_code, error: qdrantReconcile.error ?? null },
    p1_gate: { ok: p1Gate.ok, exit_code: p1Gate.exit_code, error: p1Gate.error ?? null },
    policy_report: { ok: policyReport.ok, exit_code: policyReport.exit_code, error: policyReport.error ?? null },
    auto_approval_status: { ok: autoApprovalStatus.ok, exit_code: autoApprovalStatus.exit_code, error: autoApprovalStatus.error ?? null },
    production_guard: { ok: productionGuard.ok, exit_code: productionGuard.exit_code, error: productionGuard.error ?? null },
    conversation_sources: { ok: conversationSources.ok, exit_code: conversationSources.exit_code, error: conversationSources.error ?? null },
    conversation_monitor_report: { ok: conversationMonitorReport.ok, exit_code: conversationMonitorReport.exit_code, error: conversationMonitorReport.error ?? null },
  };

  const report = buildMemoryLandingScanReport({
    memoryStatus: memoryStatus.json,
    pending: pending.json,
    qdrantReconcile: qdrantReconcile.json,
    p1Gate: p1Gate.json,
    policyReport: policyReport.json,
    autoApprovalStatus: autoApprovalStatus.json,
    productionGuard: productionGuard.json,
    conversationSources: conversationSources.json,
    conversationMonitorReport: conversationMonitorReport.json,
    commandStatus,
  });

  const output: Record<string, unknown> = { ...report };
  if (writeReport) {
    await mkdir(reportDir, { recursive: true });
    const safeTs = report.generated_at.replace(/[:.]/gu, "-");
    const reportPath = path.join(reportDir, `landing-scan-${safeTs}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    output.report_path = reportPath;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`memory landing scan: current=${report.current_usability} production_complete=${report.production_landing_complete}\n`);
    if (report.blockers.length > 0) process.stdout.write(`blockers: ${report.blockers.join(", ")}\n`);
    if (report.warnings.length > 0) process.stdout.write(`warnings: ${report.warnings.join(", ")}\n`);
    if (report.next_actions.length > 0) process.stdout.write(`next actions:\n${report.next_actions.map((item) => `- ${item}`).join("\n")}\n`);
  }

  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
