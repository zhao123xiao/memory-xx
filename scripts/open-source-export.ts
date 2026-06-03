#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertNoPublicPathBlockers,
  buildOpenSourcePreauditReport,
  defaultOpenSourceTargetDir,
  exportOpenSourceProject,
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
  const apply = hasFlag("--apply");
  const writeReport = hasFlag("--write-report");
  const root = path.resolve(argValue("--root") ?? process.cwd());
  const explicitTargetDir = argValue("--target-dir");
  const targetDir = path.resolve(explicitTargetDir ?? defaultOpenSourceTargetDir());
  const runId = argValue("--run-id") ?? `open-source-export-${safeTimestamp()}`;
  const reportDir = path.resolve(argValue("--report-dir") ?? path.join(process.cwd(), "reports", "open-source-preaudit", runId));

  const sourcePreaudit = await buildOpenSourcePreauditReport({ root, targetDir });
  const exportResult = await exportOpenSourceProject({
    root,
    targetDir,
    apply,
    targetExplicit: explicitTargetDir !== null,
    backupId: runId,
  });
  const targetBlockers = apply ? await assertNoPublicPathBlockers(targetDir) : [];
  const output = {
    ok: exportResult.ok && targetBlockers.length === 0,
    run_id: runId,
    mode: apply ? "apply" : "dry_run",
    source_preaudit: {
      ok: sourcePreaudit.ok,
      blocker_count: sourcePreaudit.blockers.length,
      warning_count: sourcePreaudit.warnings.length,
      blockers: sourcePreaudit.blockers.slice(0, 200),
    },
    export: exportResult,
    target_public_scan: {
      ok: targetBlockers.length === 0,
      blocker_count: targetBlockers.length,
      blockers: targetBlockers,
    },
    report_path: writeReport ? path.join(reportDir, "summary.json") : null,
  };

  if (writeReport) {
    await mkdir(reportDir, { recursive: true });
    await writeFile(path.join(reportDir, "summary.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`open-source export: mode=${output.mode} ok=${output.ok} target=${targetDir}\n`);
    process.stdout.write(`source blockers=${sourcePreaudit.blockers.length} target blockers=${targetBlockers.length}\n`);
    if (writeReport) process.stdout.write(`report: ${path.join(reportDir, "summary.json")}\n`);
  }

  if (!output.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
