#!/usr/bin/env tsx
import { evaluateMemoryPolicy, type MemoryPolicyResult } from "../app/governance/memory-policy-engine";

interface PolicyEvalCase {
  readonly name: string;
  readonly source: string;
  readonly content: string;
  readonly memoryType: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly expect: Pick<MemoryPolicyResult, "memory_class" | "policy_action" | "recall_policy">;
}

const cases: readonly PolicyEvalCase[] = [
  {
    name: "explicit_no_memory",
    source: "conversation_ingest",
    content: "只是验证 Codex JSONL bridge 到 worker 的临时事件，不需要记住。",
    memoryType: "fact",
    expect: { memory_class: "explicit_no_memory", policy_action: "reject_by_policy", recall_policy: "never" },
  },
  {
    name: "runtime_continue",
    source: "conversation_ingest",
    content: "user: 继续",
    memoryType: "fact",
    expect: { memory_class: "runtime_noise", policy_action: "reject_by_policy", recall_policy: "never" },
  },
  {
    name: "hook_marker",
    source: "conversation_ingest",
    content: "hook 验收标识",
    memoryType: "fact",
    expect: { memory_class: "runtime_noise", policy_action: "reject_by_policy", recall_policy: "never" },
  },
  {
    name: "perf_sample",
    source: "conversation_ingest",
    content: "perf-1",
    memoryType: "fact",
    expect: { memory_class: "test_evidence", policy_action: "create_candidate", recall_policy: "test_only" },
  },
  {
    name: "operational_issue",
    source: "conversation_ingest",
    content: "Qdrant projector 出现停滞，导致数据同步失败，需要修复。",
    memoryType: "fact",
    expect: { memory_class: "operational_issue", policy_action: "create_candidate", recall_policy: "explicit_only" },
  },
  {
    name: "stable_preference",
    source: "conversation_ingest",
    content: "用户偏好用中文回答架构问题。",
    memoryType: "preference",
    expect: { memory_class: "preference", policy_action: "create_candidate", recall_policy: "default" },
  },
  {
    name: "unknown_source",
    source: "unknown",
    content: "source unknown content should not be silently approved",
    memoryType: "fact",
    metadata: { source: "unknown" },
    expect: { memory_class: "unknown_source_quarantine", policy_action: "quarantine_candidate", recall_policy: "never" },
  },
];

function runCase(item: PolicyEvalCase) {
  const actual = evaluateMemoryPolicy({
    source: item.source,
    sourceText: item.content,
    baseDecision: "pending",
    blockedReasons: [],
    candidate: {
      scopeType: "project",
      scopeId: "policy-eval",
      memoryType: item.memoryType,
      operation: "create",
      confidence: 0.8,
      qualityScore: 0.8,
      title: item.name,
      content: item.content,
      metadata: { source: item.source, ...(item.metadata ?? {}) },
    },
  });
  const passed = actual.memory_class === item.expect.memory_class &&
    actual.policy_action === item.expect.policy_action &&
    actual.recall_policy === item.expect.recall_policy;
  return {
    name: item.name,
    passed,
    expect: item.expect,
    actual: {
      memory_class: actual.memory_class,
      policy_action: actual.policy_action,
      recall_policy: actual.recall_policy,
      reasons: actual.reasons,
    },
  };
}

const results = cases.map(runCase);
const ok = results.every((result) => result.passed);
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ ok, results }, null, 2)}\n`);
} else {
  for (const result of results) {
    process.stdout.write(`${result.passed ? "ok" : "not ok"} ${result.name}: ${JSON.stringify(result.actual)}\n`);
  }
}
process.exitCode = ok ? 0 : 1;
