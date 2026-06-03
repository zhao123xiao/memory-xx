#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function nowId(): string {
  return `auto-update-random-full-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

async function runStep(name: string, script: string, args: readonly string[], timeoutMs: number): Promise<Record<string, unknown>> {
  try {
    const result = await execFileAsync("npm", ["run", "--silent", script, "--", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: process.env.TMPDIR || "/tmp" },
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    return { name, ok: true, status: 0, report: parsed };
  } catch (error) {
    const err = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    let parsed: unknown = null;
    const stdout = String(err.stdout ?? "");
    try {
      parsed = stdout.trim() ? JSON.parse(stdout) : null;
    } catch {
      parsed = stdout.slice(-4000);
    }
    return {
      name,
      ok: false,
      status: err.status ?? 1,
      stdout_tail: stdout.slice(-4000),
      stderr_tail: String(err.stderr ?? err.message ?? "").slice(-4000),
      report: parsed,
    };
  }
}

async function main(): Promise<void> {
  const runId = nowId();
  const policy = await runStep("policy-corpus-1000", "test:auto-update-random-corpus", ["--cases=1000"], 180_000);
  const apply = await runStep("apply-rollback-300", "test:auto-update-apply-random-e2e", ["--cases=300"], 1_800_000);
  const steps = [policy, apply];
  const failures = steps.filter((step) => step.ok !== true);
  const report = {
    ok: failures.length === 0,
    run_id: runId,
    generated_at: new Date().toISOString(),
    profile: "balanced",
    policy_cases: 1000,
    apply_cases: 300,
    failures,
    steps,
  };
  const reportDir = join(process.cwd(), "reports", "auto-update-random-full");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${runId}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, report_path: reportPath }, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
