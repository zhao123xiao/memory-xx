#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildOpenSourcePreauditReport,
  defaultOpenSourceTargetDir,
} from "../app/ops/open-source-release";

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

function safeTimestamp(value = new Date().toISOString()): string {
  return value.replace(/[:.]/gu, "-");
}

async function main(): Promise<void> {
  const json = hasFlag("--json");
  const writeReport = hasFlag("--write-report");
  const root = path.resolve(argValue("--root") ?? process.cwd());
  const targetDir = path.resolve(argValue("--target-dir") ?? defaultOpenSourceTargetDir());
  const runId = argValue("--run-id") ?? `open-source-preaudit-${safeTimestamp()}`;
  const reportDir = path.resolve(argValue("--report-dir") ?? path.join(process.cwd(), "reports", "open-source-preaudit", runId));
  const report = await buildOpenSourcePreauditReport({ root, targetDir });
  const output = {
    ...report,
    run_id: runId,
    report_path: writeReport ? path.join(reportDir, "summary.json") : null,
  };

  if (writeReport) {
    await mkdir(reportDir, { recursive: true });
    await writeFile(path.join(reportDir, "summary.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`open-source preaudit: ok=${report.ok} blockers=${report.blockers.length} warnings=${report.warnings.length}\n`);
    if (writeReport) process.stdout.write(`report: ${path.join(reportDir, "summary.json")}\n`);
  }

  if (!report.ok && hasFlag("--fail-on-blockers")) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
