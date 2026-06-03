#!/usr/bin/env tsx
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { evaluateAutoUpdatePolicy, type AutoUpdateCandidateInput, type AutoUpdateDecision } from "../app/governance/auto-update-policy";

function execFileResult(command: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], { cwd: process.cwd(), env: process.env }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException | null)?.code === "number"
        ? Number((error as NodeJS.ErrnoException).code)
        : error
          ? 1
          : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function base(overrides: Partial<AutoUpdateCandidateInput> = {}): AutoUpdateCandidateInput {
  const marker = randomBytes(3).toString("hex");
  return {
    candidateId: `candidate-${marker}`,
    existingMemoryId: `existing-${marker}`,
    scopeType: "project",
    scopeId: "memory-xx",
    memoryType: "fact",
    operation: "update",
    conflictAction: "update",
    content: `Replace old setting with new marker ${marker}.`,
    existingContent: `Old marker ${marker}.`,
    confidence: 0.96,
    qualityScore: 0.95,
    agentId: "codex",
    source: "conversation_ingest",
    metadata: { source: "conversation_ingest" },
    ...overrides,
  };
}

async function main(): Promise<void> {
  const runId = `auto-update-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const cases: Array<{ name: string; input: AutoUpdateCandidateInput; expected: AutoUpdateDecision; blocked?: string }> = [
    { name: "explicit-replacement", input: base({ content: "之前用 A，现在改成 B。" }), expected: "supersede_dry_run" },
    { name: "supersede-action", input: base({ conflictAction: "supersede" }), expected: "supersede_dry_run" },
    { name: "merge-action", input: base({ conflictAction: "merge", operation: "merge" }), expected: "merge_dry_run" },
    { name: "expired", input: base({ existingMemoryId: null, metadata: { expires_at: new Date(Date.now() - 1000).toISOString() } }), expected: "archive_expired_dry_run" },
    { name: "low-confidence", input: base({ confidence: 0.5 }), expected: "pending", blocked: "quality_or_confidence_below_update_threshold" },
    { name: "secret-block", input: base({ content: "replace token=sk_1234567890abcdefghijklmnop" }), expected: "pending", blocked: "sensitive_content_detected" },
    { name: "no-signal", input: base({ operation: "add", conflictAction: "create", existingMemoryId: null }), expected: "pending", blocked: "no_update_conflict_or_expiry_signal" },
  ];
  const failures: Array<Record<string, unknown>> = [];
  const results = cases.map((item) => {
    const actual = evaluateAutoUpdatePolicy(item.input);
    if (actual.decision !== item.expected) failures.push({ name: item.name, expected: item.expected, actual: actual.decision, blocked_reasons: actual.blocked_reasons });
    if (actual.dry_run !== true || actual.apply_allowed !== false || !actual.apply_blocked_reason) {
      failures.push({
        name: item.name,
        missing_dry_run_guard: {
          dry_run: actual.dry_run,
          apply_allowed: actual.apply_allowed,
          apply_blocked_reason: actual.apply_blocked_reason,
        },
      });
    }
    if (item.blocked && !actual.blocked_reasons.some((reason) => reason.includes(item.blocked ?? ""))) {
      failures.push({ name: item.name, missing_blocked_reason: item.blocked, blocked_reasons: actual.blocked_reasons });
    }
    return {
      name: item.name,
      expected: item.expected,
      actual: actual.decision,
      dry_run: actual.dry_run,
      apply_allowed: actual.apply_allowed,
      apply_blocked_reason: actual.apply_blocked_reason,
      blocked_reasons: actual.blocked_reasons,
      action_plan: actual.action_plan,
    };
  });
  const applyProbe = await execFileResult("npm", ["run", "--silent", "memory:auto-update", "--", "apply", "--scope=project:memory-xx"]);
  if (applyProbe.code === 0 || !/auto_update_apply_real_scope_disabled/u.test(`${applyProbe.stdout}\n${applyProbe.stderr}`)) {
    failures.push({
      name: "cli-apply-disabled",
      expected_nonzero: true,
      actual_code: applyProbe.code,
      stdout: applyProbe.stdout.slice(0, 500),
      stderr: applyProbe.stderr.slice(0, 500),
    });
  }
  const report = { ok: failures.length === 0, run_id: runId, failures, apply_probe: applyProbe, results };
  const reportDir = join(process.cwd(), "reports", "auto-update-corpus");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `auto-update-corpus-${runId}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ ...report, report_path: reportPath }, null, 2) + "\n");
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
