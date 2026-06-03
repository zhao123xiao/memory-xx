#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface StepResult {
  readonly name: string;
  readonly command: string;
  readonly ok: boolean;
  readonly status: number | null;
  readonly stdout_excerpt: string;
  readonly stderr_excerpt: string;
}

function runStep(name: string, args: readonly string[]): StepResult {
  const result = spawnSync("npm", ["run", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, TMPDIR: process.env.TMPDIR || "/tmp" },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    name,
    command: `npm run ${args.join(" ")}`,
    ok: result.status === 0,
    status: result.status,
    stdout_excerpt: (result.stdout ?? "").slice(-4000),
    stderr_excerpt: (result.stderr ?? "").slice(-4000),
  };
}

async function main(): Promise<void> {
  const runId = `closure-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const steps = [
    runStep("auto-approval-corpus", ["test:auto-approval-corpus"]),
    runStep("auto-approval-random-corpus", ["test:auto-approval-random-corpus", "--", "--cases=100"]),
    runStep("scope-matrix", ["test:auto-approval-scope-matrix"]),
    runStep("privacy-corpus", ["test:auto-approval-privacy-corpus"]),
    runStep("temporal-corpus", ["test:auto-approval-temporal-corpus"]),
    runStep("auto-update-corpus", ["test:auto-update-corpus"]),
    runStep("auto-update-random-corpus", ["test:auto-update-random-corpus", "--", "--cases=100"]),
    runStep("auto-update-apply-e2e", ["test:auto-update-apply-e2e"]),
    runStep("auto-update-rollback-e2e", ["test:auto-update-rollback-e2e"]),
    runStep("auto-update-real-project-guarded-e2e", ["test:auto-update-real-project-guarded-e2e"]),
    runStep("auto-approval-real-scope-e2e", ["test:auto-approval-real-scope-e2e"]),
  ];
  const ok = steps.every((step) => step.ok);
  const report = { ok, run_id: runId, steps };
  const reportDir = join(process.cwd(), "reports", "auto-approval-production-closure");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `auto-approval-production-closure-${runId}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ ...report, report_path: reportPath }, null, 2) + "\n");
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
