#!/usr/bin/env tsx
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { evaluateAutoApprovalPolicy, type AutoApprovalPolicyInput } from "../app/governance/auto-approval-policy";

function input(content: string, scopeType = "project", scopeId = "memory-xx", metadata: Record<string, unknown> = {}): AutoApprovalPolicyInput {
  return {
    mode: "write",
    agentId: "codex",
    source: "conversation_ingest",
    sourceText: content,
    candidate: {
      scopeType,
      scopeId,
      memoryType: scopeType === "user" ? "preference" : "fact",
      operation: "add",
      conflictAction: "create",
      confidence: 0.98,
      qualityScore: 0.97,
      title: `privacy ${randomBytes(3).toString("hex")}`,
      content,
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
  const runId = `privacy-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const workspaceScope = `workspace-${runId}`;
  const cases = [
    { name: "api-key", input: input("api_key=sk_1234567890abcdefghijklmnop"), expected: "pending", blocked: "sensitive_content_detected" },
    { name: "password", input: input("password=CorrectHorseBatteryStaple"), expected: "pending", blocked: "sensitive_content_detected" },
    { name: "connection-string", input: input("postgres://user:pass@localhost:5432/db"), expected: "pending", blocked: "sensitive_content_detected" },
    { name: "pii-email", input: input("用户邮箱是 person@example.com"), expected: "pending", blocked: "pii_requires_human_review" },
    { name: "safe-id", input: input(`issue-123456789 fixed in v3.0.21 marker ${runId}`), expected: "approve" },
    { name: "internal-path-user", input: input("<project-root> 是用户偏好的工作目录", "user", `user-${runId}`), expected: "pending", blocked: "internal_path_scope_requires_review", envScopes: `user:user-${runId}` },
    { name: "internal-path-workspace", input: input("<project-root> 是当前 workspace 根目录", "workspace", workspaceScope, { review_at: new Date(Date.now() + 86400000).toISOString() }), expected: "approve", envScopes: `workspace:${workspaceScope}` },
  ];
  const failures: Array<Record<string, unknown>> = [];
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
      return { name: item.name, expected: item.expected, actual: actual.decision, blocked_reasons: actual.blocked_reasons, privacy: actual.privacy };
    } finally {
      if (previousCanary === undefined) delete process.env.MEMORY_XX_AUTO_APPROVAL_CANARY;
      else process.env.MEMORY_XX_AUTO_APPROVAL_CANARY = previousCanary;
      if (previousScopes === undefined) delete process.env.MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
      else process.env.MEMORY_XX_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = previousScopes;
    }
  });
  const report = { ok: failures.length === 0, run_id: runId, failures, results };
  const reportDir = join(process.cwd(), "reports", "auto-approval-privacy-corpus");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `auto-approval-privacy-corpus-${runId}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ ...report, report_path: reportPath }, null, 2) + "\n");
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
