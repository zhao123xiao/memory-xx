#!/usr/bin/env tsx

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isRuntimeAutoUpdateApplyScopeEnabled,
  readAutoApprovalRuntimeControlsSync,
} from "../app/governance/auto-approval-runtime-controls";
import { evaluateAutoUpdatePolicy, type AutoUpdateCandidateInput } from "../app/governance/auto-update-policy";

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function casesCount(): number {
  const parsed = Number.parseInt(arg("cases") || "1000", 10);
  return Number.isFinite(parsed) ? Math.max(10, Math.min(3000, parsed)) : 1000;
}

function marker(): string {
  return randomBytes(5).toString("hex");
}

const SAFE_WORDS = [
  "aurora", "beacon", "cobalt", "delta", "ember", "fable", "glimmer", "harbor",
  "indigo", "juniper", "keystone", "lumen", "matrix", "nebula", "orbit", "prism",
  "quartz", "ripple", "signal", "vector", "willow", "zenith",
];

function safeMarker(): string {
  const bytes = randomBytes(3);
  return [0, 1, 2].map((index) => SAFE_WORDS[bytes[index] % SAFE_WORDS.length]).join(" ");
}

function base(overrides: Partial<AutoUpdateCandidateInput> = {}): AutoUpdateCandidateInput {
  const m = marker();
  return {
    candidateId: `candidate-${m}`,
    existingMemoryId: `existing-${m}`,
    scopeType: "project",
    scopeId: `auto-update-test-${m}`,
    memoryType: "fact",
    operation: "update",
    conflictAction: "update",
    content: `Replace legacy auto-update marker ${m} with current marker ${m}-new.`,
    existingContent: `Legacy auto-update marker ${m}.`,
    confidence: 0.97,
    qualityScore: 0.96,
    agentId: "codex",
    source: "conversation_ingest",
    metadata: { source: "conversation_ingest", auto_update_random_run_id: m },
    ...overrides,
  };
}

function buildCase(index: number): { name: string; input: AutoUpdateCandidateInput; expectApplyAllowed: boolean; expectReason?: string } {
  const m = marker();
  const safe = safeMarker();
  const controls = readAutoApprovalRuntimeControlsSync();
  switch (index % 14) {
    case 0:
      return {
        name: "explicit-test-scope",
        input: base({
          scopeId: `auto-update-test-${m}`,
          existingContent: `项目标记 ${safe} 使用旧方案 alpha。`,
          content: `项目标记 ${safe} 明确从旧方案 alpha 改成新方案 beta。`,
        }),
        expectApplyAllowed: true,
      };
    case 1:
      return {
        name: "same-fact-refresh",
        input: base({
          scopeId: `auto-update-test-${m}`,
          conflictAction: "refresh",
          operation: "refresh",
          existingContent: `项目事实 ${safe} 当前有效。`,
          content: `重新确认项目事实 ${safe} 仍然有效。`,
        }),
        expectApplyAllowed: true,
      };
    case 2:
      return {
        name: "temporal-expiry",
        input: base({
          scopeId: `auto-update-test-${m}`,
          existingMemoryId: null,
          existingContent: `旧的项目事实 ${safe} 已经过期。`,
          content: `项目事实 ${safe} 已经过期，需要归档旧结论并采用当前结论。`,
          metadata: { expires_at: new Date(Date.now() - 1000).toISOString(), auto_update_random_run_id: m },
        }),
        expectApplyAllowed: true,
      };
    case 3:
      return {
        name: "real-project-guard",
        input: base({ scopeId: "memory-xx" }),
        expectApplyAllowed: isRuntimeAutoUpdateApplyScopeEnabled("project", "memory-xx"),
        expectReason: isRuntimeAutoUpdateApplyScopeEnabled("project", "memory-xx") ? undefined : "auto_update_apply_real_scope_disabled",
      };
    case 4:
      return { name: "merge-block", input: base({ scopeId: `auto-update-test-${m}`, operation: "merge", conflictAction: "merge" }), expectApplyAllowed: false, expectReason: "auto_update_type_apply_disabled" };
    case 5:
      return { name: "low-quality", input: base({ scopeId: `auto-update-test-${m}`, confidence: 0.5 }), expectApplyAllowed: false, expectReason: "quality_or_confidence_below_update_threshold" };
    case 6:
      return { name: "secret-block", input: base({ scopeId: `auto-update-test-${m}`, content: `replace secret token=sk_1234567890abcdefghijklmnop ${m}` }), expectApplyAllowed: false, expectReason: "sensitive_content_detected" };
    case 7:
      return { name: "no-signal", input: base({ scopeId: `auto-update-test-${m}`, operation: "add", conflictAction: "create", existingMemoryId: null }), expectApplyAllowed: false, expectReason: "no_update_conflict_or_expiry_signal" };
    case 8:
      return { name: "global-keyword-required", input: base({ scopeType: "global", scopeId: "global" }), expectApplyAllowed: false, expectReason: "global_explicit_intent_required" };
    case 9:
      return { name: "preference-change-block", input: base({ scopeId: `auto-update-test-${m}`, memoryType: "preference", content: `我之前喜欢 A-${m}，现在改成 B-${m}。` }), expectApplyAllowed: false, expectReason: "auto_update_type_apply_disabled" };
    case 10:
      return { name: "pii-soft-block", input: base({ scopeId: `auto-update-test-${m}`, content: `之前联系人邮箱是 old-${m}@example.com，现在改成 new-${m}@example.com。` }), expectApplyAllowed: false, expectReason: "pii_requires_human_review" };
    case 11:
      return { name: "workspace-hard-block", input: base({ scopeType: "workspace", scopeId: "current-instance", content: `之前 workspace path ${m} 是 A，现在改成 B。` }), expectApplyAllowed: false, expectReason: "auto_update_apply_real_scope_disabled" };
    case 12: {
      const userScopeEnabled = isRuntimeAutoUpdateApplyScopeEnabled("user", "current-user", controls);
      const userTypeEnabled = controls.update_apply.preference_change_apply;
      return {
        name: "user-current-guard",
        input: base({ scopeType: "user", scopeId: "current-user", memoryType: "preference", content: `我之前偏好 A-${m}，现在改成 B-${m}。` }),
        expectApplyAllowed: userScopeEnabled && userTypeEnabled,
        expectReason: userScopeEnabled ? (userTypeEnabled ? undefined : "auto_update_type_apply_disabled") : "auto_update_apply_real_scope_disabled",
      };
    }
    default:
      return {
        name: "graph-relation-merge-block",
        input: base({
          scopeId: `auto-update-test-${m}`,
          operation: "merge",
          conflictAction: "merge",
          metadata: {
            auto_update_random_run_id: m,
            graph_relation: true,
            graph_evidence: {
              source_uri: `memory-xx://random/${m}`,
              entity_path: ["A", "B"],
              relation_path: ["depends_on"],
              source_evidence: [`relation evidence ${m}`],
              rebuildable: true,
            },
          },
        }),
        expectApplyAllowed: false,
        expectReason: "auto_update_type_apply_disabled",
      };
  }
}

async function main(): Promise<void> {
  const runId = `auto-update-random-${Date.now().toString(36)}-${marker()}`;
  const cases = Array.from({ length: casesCount() }, (_, index) => buildCase(index));
  const failures: Array<Record<string, unknown>> = [];
  const results = cases.map((item) => {
    const actual = evaluateAutoUpdatePolicy(item.input);
    if (actual.apply_allowed !== item.expectApplyAllowed) {
      failures.push({ name: item.name, expected_apply_allowed: item.expectApplyAllowed, actual_apply_allowed: actual.apply_allowed, actual });
    }
    if (item.expectReason && ![actual.apply_blocked_reason, ...actual.blocked_reasons].filter(Boolean).some((reason) => String(reason).includes(item.expectReason ?? ""))) {
      failures.push({ name: item.name, missing_reason: item.expectReason, actual });
    }
    return {
      name: item.name,
      apply_allowed: actual.apply_allowed,
      apply_blocked_reason: actual.apply_blocked_reason,
      decision: actual.decision,
      detected_update_type: actual.detected_update_type,
      replacement_confidence: actual.replacement_confidence,
      blocked_reasons: actual.blocked_reasons,
      diff_summary: actual.diff_summary,
    };
  });
  const summary = results.reduce((acc, row) => {
    const name = String(row.name);
    acc[name] = (acc[name] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const report = {
    ok: failures.length === 0,
    run_id: runId,
    cases: cases.length,
    failures,
    summary,
    apply_allowed: results.filter((row) => row.apply_allowed).length,
    blocked: results.filter((row) => !row.apply_allowed).length,
    results,
  };
  const reportDir = join(process.cwd(), "reports", "auto-update-random-corpus");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `auto-update-random-corpus-${runId}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ ...report, report_path: reportPath }, null, 2) + "\n");
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
