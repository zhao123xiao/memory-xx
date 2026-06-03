#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function run(args: readonly string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync("npm", ["run", "--silent", "memory:auto-approval-ops", "--", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, TMPDIR: process.env.TMPDIR || "/tmp" },
    timeout: 120_000,
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const report = await run(["report", "--json"]);
  const plan = await run(["plan", "--json"]);
  const failures = [];
  if (report.ok !== true) failures.push({ step: "report", report });
  if (plan.ok !== true) failures.push({ step: "plan", plan });
  if (plan.can_apply_automatically !== false) failures.push({ step: "auto-apply-guard", plan });
  if (!Array.isArray(plan.blocked_actions) || !plan.blocked_actions.includes("enable_global_update_apply")) {
    failures.push({ step: "high-risk-block-list", plan });
  }
  const result = { ok: failures.length === 0, failures, report_mode: report.mode, plan_mode: plan.mode };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
