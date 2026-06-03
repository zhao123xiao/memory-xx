#!/usr/bin/env tsx
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { evaluateAutoApprovalPolicy, type AutoApprovalPolicyInput } from "../app/governance/auto-approval-policy";

function base(scopeType: string, scopeId: string, metadata: Record<string, unknown>): AutoApprovalPolicyInput {
  const marker = randomBytes(3).toString("hex");
  return {
    mode: "write",
    agentId: "codex",
    source: "conversation_ingest",
    sourceText: `temporal marker ${marker}`,
    candidate: {
      scopeType,
      scopeId,
      memoryType: "fact",
      operation: "add",
      conflictAction: "create",
      confidence: 0.98,
      qualityScore: 0.97,
      title: `temporal ${marker}`,
      content: `temporal marker ${marker} is stable.`,
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
  const previousCanary = process.env.MEMORY_V2_AUTO_APPROVAL_CANARY;
  const previousScopes = process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
  const runId = `temporal-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const workspaceScope = `workspace-${runId}`;
  const cases = [
    { name: "expired-project", input: base("project", "memory-xx", { expires_at: new Date(Date.now() - 1000).toISOString() }), expected: "pending", blocked: "expired_candidate" },
    { name: "temporary-project", input: base("project", "memory-xx", { temporal_validity: "temporary" }), expected: "pending", blocked: "temporary_temporal_validity" },
    { name: "workspace-missing-review-at", input: base("workspace", workspaceScope, {}), expected: "pending", blocked: "review_at_required", envScopes: `workspace:${workspaceScope}` },
    { name: "workspace-review-at", input: base("workspace", workspaceScope, { review_at: new Date(Date.now() + 86400000).toISOString() }), expected: "approve", envScopes: `workspace:${workspaceScope}` },
    { name: "permanent-project", input: base("project", "memory-xx", { temporal_validity: "permanent" }), expected: "approve" },
  ];
  const failures: Array<Record<string, unknown>> = [];
  const results = cases.map((item) => {
    try {
      if (item.envScopes) {
        process.env.MEMORY_V2_AUTO_APPROVAL_CANARY = "1";
        process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = item.envScopes;
      } else {
        delete process.env.MEMORY_V2_AUTO_APPROVAL_CANARY;
        delete process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
      }
      const actual = evaluateAutoApprovalPolicy(item.input);
      if (actual.decision !== item.expected) failures.push({ name: item.name, expected: item.expected, actual: actual.decision, blocked_reasons: actual.blocked_reasons });
      if (item.blocked && !actual.blocked_reasons.some((reason) => reason.includes(item.blocked ?? ""))) {
        failures.push({ name: item.name, missing_blocked_reason: item.blocked, blocked_reasons: actual.blocked_reasons });
      }
      return { name: item.name, expected: item.expected, actual: actual.decision, blocked_reasons: actual.blocked_reasons, temporal: actual.temporal };
    } finally {
      if (previousCanary === undefined) delete process.env.MEMORY_V2_AUTO_APPROVAL_CANARY;
      else process.env.MEMORY_V2_AUTO_APPROVAL_CANARY = previousCanary;
      if (previousScopes === undefined) delete process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
      else process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = previousScopes;
    }
  });
  const report = { ok: failures.length === 0, run_id: runId, failures, results };
  const reportDir = join(process.cwd(), "reports", "auto-approval-temporal-corpus");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `auto-approval-temporal-corpus-${runId}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ ...report, report_path: reportPath }, null, 2) + "\n");
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
