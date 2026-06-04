#!/usr/bin/env tsx
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { evaluateAutoApprovalPolicy, type AutoApprovalPolicyInput } from "../app/governance/auto-approval-policy";

function base(scopeType: string, scopeId: string, memoryType: string, metadata: Record<string, unknown> = {}): AutoApprovalPolicyInput {
  const marker = `scope-${randomBytes(4).toString("hex")}`;
  return {
    mode: "write",
    agentId: "codex",
    source: "conversation_ingest",
    sourceText: `记住：${scopeType}:${scopeId} auto approval marker ${marker}.`,
    candidate: {
      scopeType,
      scopeId,
      memoryType,
      operation: "add",
      conflictAction: "create",
      confidence: 0.98,
      qualityScore: 0.97,
      title: `${scopeType} ${marker}`,
      content: `${scopeType}:${scopeId} stable memory marker ${marker}.`,
      metadata: { source: "conversation_ingest", ...metadata },
    },
    trustedAgent: true,
    hasScopeGrant: true,
    candidateOnly: false,
    candidateOnlyReasons: [],
    semanticConflict: false,
    semanticDuplicate: false,
    autoApproveEnabled: true,
    recentApprovedCount: 0,
  };
}

async function main(): Promise<void> {
  const previousCanary = process.env.MEMORY_XX_AUTO_APPROVAL_CANARY;
  const previousScopes = process.env.MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
  const runId = `scope-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const failures: Array<Record<string, unknown>> = [];
  const cases: Array<{ name: string; input: AutoApprovalPolicyInput; envScopes?: string; expected: "approve" | "pending"; blocked?: string }> = [
    { name: "project-default", input: base("project", "memory-xx", "fact"), expected: "approve" },
    { name: "workspace-current-real-scope", input: base("workspace", "current-instance", "fact", { review_at: new Date(Date.now() + 86400000).toISOString() }), expected: "approve" },
    { name: "workspace-other-default-pending", input: base("workspace", `real-workspace-${runId}`, "fact", { review_at: new Date(Date.now() + 86400000).toISOString() }), expected: "pending", blocked: "auto_approval_not_requested" },
    { name: "workspace-canary", input: base("workspace", `workspace-${runId}`, "fact", { review_at: new Date(Date.now() + 86400000).toISOString() }), envScopes: `workspace:workspace-${runId}`, expected: "approve" },
    { name: "user-default-pending", input: base("user", "current-instance-owner", "preference"), expected: "pending", blocked: "auto_approval_not_requested" },
    { name: "user-canary", input: base("user", `user-${runId}`, "preference"), envScopes: `user:user-${runId}`, expected: "approve" },
    { name: "global-default-manual", input: base("global", "global", "fact"), expected: "pending", blocked: "global_scope_default_manual" },
    { name: "self-improvement-canary", input: base("project", "memory-xx-self-improvement", "ops_learning"), envScopes: "project:memory-xx-self-improvement", expected: "approve" },
    { name: "self-improvement-repair-block", input: base("project", "memory-xx-self-improvement", "ops_proposal"), envScopes: "project:memory-xx-self-improvement", expected: "pending", blocked: "self_improvement_report_only" },
  ];
  const repairIndex = cases.findIndex((item) => item.name === "self-improvement-repair-block");
  cases[repairIndex] = {
    ...cases[repairIndex],
    input: {
      ...cases[repairIndex].input,
      sourceText: "建议自动修复并重启服务。",
      candidate: { ...cases[repairIndex].input.candidate, content: "建议自动修复并重启服务。" },
    },
  };

  const results = cases.map((item) => {
    try {
      if (item.envScopes) {
        process.env.MEMORY_XX_AUTO_APPROVAL_CANARY = "1";
        process.env.MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = item.envScopes;
      } else {
        delete process.env.MEMORY_XX_AUTO_APPROVAL_CANARY;
        delete process.env.MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
      }
      const actual = evaluateAutoApprovalPolicy(item.input);
      if (actual.decision !== item.expected) failures.push({ name: item.name, expected: item.expected, actual: actual.decision, blocked_reasons: actual.blocked_reasons });
      if (item.blocked && !actual.blocked_reasons.some((reason) => reason.includes(item.blocked ?? ""))) {
        failures.push({ name: item.name, missing_blocked_reason: item.blocked, blocked_reasons: actual.blocked_reasons });
      }
      return { name: item.name, expected: item.expected, actual: actual.decision, blocked_reasons: actual.blocked_reasons, scope_profile: actual.scope_profile };
    } finally {
      if (previousCanary === undefined) delete process.env.MEMORY_XX_AUTO_APPROVAL_CANARY;
      else process.env.MEMORY_XX_AUTO_APPROVAL_CANARY = previousCanary;
      if (previousScopes === undefined) delete process.env.MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
      else process.env.MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = previousScopes;
    }
  });

  const report = { ok: failures.length === 0, run_id: runId, failures, results };
  const reportDir = join(process.cwd(), "reports", "auto-approval-scope-matrix");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `auto-approval-scope-matrix-${runId}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ ...report, report_path: reportPath }, null, 2) + "\n");
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
