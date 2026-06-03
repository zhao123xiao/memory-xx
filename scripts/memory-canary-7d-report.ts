#!/usr/bin/env tsx
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildMemoryCanary7dReport } from "../app/governance/memory-canary-7d-report";

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

async function loadReports(reportDir: string): Promise<Record<string, unknown>[]> {
  const names = await readdir(reportDir).catch(() => []);
  const reports: Record<string, unknown>[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    try {
      const parsed = JSON.parse(await readFile(path.join(reportDir, name), "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) reports.push(parsed as Record<string, unknown>);
    } catch {
      // Ignore malformed partial reports; the aggregate will surface insufficient coverage.
    }
  }
  return reports;
}

async function main(): Promise<void> {
  const json = hasFlag("--json");
  const writeReport = hasFlag("--write-report");
  const days = Number.parseInt(argValue("--days") ?? "7", 10);
  const landingReportDir = argValue("--landing-report-dir") ?? path.join(process.cwd(), "reports", "memory-landing-scan");
  const reportDir = argValue("--report-dir") ?? path.join(process.cwd(), "reports", "memory-canary");
  const minRealFeedbackSamples = Number.parseInt(argValue("--min-real-feedback-samples") ?? "20", 10);

  const report = buildMemoryCanary7dReport({
    reports: await loadReports(landingReportDir),
    days: Number.isFinite(days) && days > 0 ? days : 7,
    minRealFeedbackSamples: Number.isFinite(minRealFeedbackSamples) && minRealFeedbackSamples > 0 ? minRealFeedbackSamples : 20,
  });

  const output: Record<string, unknown> = { ...report };
  if (writeReport) {
    await mkdir(reportDir, { recursive: true });
    const safeTs = report.generated_at.replace(/[:.]/gu, "-");
    const reportPath = path.join(reportDir, `production-canary-7d-${safeTs}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    output.report_path = reportPath;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`memory canary ${report.days}d: ok=${report.ok} reports=${report.days_observed}/${report.days} candidate_only_exit_ready=${report.candidate_only_exit_ready}\n`);
    if (report.blockers.length > 0) process.stdout.write(`blockers: ${report.blockers.join(", ")}\n`);
    if (report.warnings.length > 0) process.stdout.write(`warnings: ${report.warnings.join(", ")}\n`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
