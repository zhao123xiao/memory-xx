import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  defaultAutoApprovalRuntimeControls,
  evaluateAutoUpdatePolicy,
  evaluateAutoApprovalPolicy,
  LifecycleStatus,
  ReviewState,
  scanMemoryPrivacy,
  shouldFreezeAutoApprovalCohort,
  shouldFreezeAutoApprovalCohortMetrics,
} from "../app";

function withRuntimeDir<T>(callback: (dir: string) => T): T {
  const previousRuntimeDir = process.env.MEMORY_V2_RUNTIME_DIR;
  const dir = mkdtempSync(join(tmpdir(), "memory-xx-runtime-controls-"));
  process.env.MEMORY_V2_RUNTIME_DIR = dir;
  try {
    return callback(dir);
  } finally {
    if (previousRuntimeDir === undefined) delete process.env.MEMORY_V2_RUNTIME_DIR;
    else process.env.MEMORY_V2_RUNTIME_DIR = previousRuntimeDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

type RuntimeControls = ReturnType<typeof defaultAutoApprovalRuntimeControls>;

function writeRuntimeControls(dir: string, overrides: {
  readonly user?: Partial<RuntimeControls["user"]>;
  readonly global?: Partial<RuntimeControls["global"]>;
  readonly update_apply?: Partial<RuntimeControls["update_apply"]>;
}): void {
  const defaults = defaultAutoApprovalRuntimeControls();
  writeFileSync(join(dir, "auto-approval-runtime-controls.json"), JSON.stringify({
    ...defaults,
    ...overrides,
    user: { ...defaults.user, ...overrides.user },
    global: { ...defaults.global, ...overrides.global },
    update_apply: { ...defaults.update_apply, ...overrides.update_apply },
  }, null, 2));
}

function writeScopeEnablements(dir: string, scopes: readonly string[]): void {
  writeFileSync(join(dir, "auto-approval-scope-enablements.json"), JSON.stringify({
    enabled_scopes: scopes,
    agents: ["codex"],
    allowed_sources: ["conversation_ingest"],
    allowed_operations: ["add"],
    enablements: scopes.map((scope) => ({
      scope,
      enabled: true,
      agents: ["codex"],
      allowed_sources: ["conversation_ingest"],
      allowed_operations: ["add"],
    })),
  }, null, 2));
}

function baseInput(overrides: Partial<Parameters<typeof evaluateAutoApprovalPolicy>[0]> = {}) {
  return {
    mode: "write" as const,
    agentId: "codex",
    source: "conversation_ingest",
    sourceText: "请记住：memory-xx 的自动审批策略必须保留可回滚审计。",
    candidate: {
      scopeType: "project",
      scopeId: "memory-xx",
      memoryType: "fact",
      operation: "add",
      conflictAction: "create",
      confidence: 0.96,
      qualityScore: 0.94,
      title: "auto approval audit",
      content: "memory-xx 的自动审批策略必须保留可回滚审计。",
      metadata: { source: "conversation_ingest" },
    },
    trustedAgent: true,
    hasScopeGrant: true,
    candidateOnly: false,
    candidateOnlyReasons: [],
    semanticConflict: false,
    semanticDuplicate: false,
    autoApproveEnabled: true,
    recentApprovedCount: 0,
    ...overrides,
  };
}

test("auto approval policy approves high-quality memory-xx project facts", () => {
  const result = evaluateAutoApprovalPolicy(baseInput());
  assert.equal(result.decision, "approve");
  assert.equal(result.lifecycleStatus, LifecycleStatus.Approved);
  assert.equal(result.reviewState, ReviewState.SilentApproved);
  assert.equal(result.blocked_reasons.length, 0);
  assert.equal(result.rollback_plan.invalidates_cache, true);
});

test("auto approval policy blocks missing DB scope grant", () => {
  const result = evaluateAutoApprovalPolicy(baseInput({ hasScopeGrant: false }));
  assert.equal(result.decision, "pending");
  assert.match(result.blocked_reasons.join(","), /scope_grant_missing/u);
});

test("auto approval policy blocks questions, temporary tests, and sensitive content", () => {
  const question = evaluateAutoApprovalPolicy(baseInput({
    sourceText: "刚刚这个 run 是否应该写入？",
    candidate: { ...baseInput().candidate, content: "刚刚这个 run 是否应该写入？" },
  }));
  assert.equal(question.decision, "pending");
  assert.match(question.blocked_reasons.join(","), /question_only/u);

  const pollution = evaluateAutoApprovalPolicy(baseInput({
    candidate: {
      ...baseInput().candidate,
      scopeId: "memory-xx",
      title: "Unified API test sample",
      content: "Unified API test sample",
      metadata: { governance_test_pollution: true },
    },
  }));
  assert.equal(pollution.decision, "pending");
  assert.match(pollution.blocked_reasons.join(","), /test_pollution_detected/u);

  const secret = evaluateAutoApprovalPolicy(baseInput({
    candidate: {
      ...baseInput().candidate,
      content: "service token=sk_1234567890abcdefghijklmnop",
    },
  }));
  assert.equal(secret.decision, "pending");
  assert.match(secret.blocked_reasons.join(","), /sensitive_content_detected/u);

  const spacedToken = evaluateAutoApprovalPolicy(baseInput({
    sourceText: "请记住这个临时 token sk_llm-mpqf3mma-3fe0d90a5f-8-be370f0e9e_1234567890abcdefghijklmnop，后面调用服务用。",
    candidate: {
      ...baseInput().candidate,
      content: "临时 token sk_llm-mpqf3mma-3fe0d90a5f-8-be370f0e9e_1234567890abcdefghijklmnop 用于后续服务调用",
    },
  }));
  assert.equal(spacedToken.decision, "pending");
  assert.match(spacedToken.blocked_reasons.join(","), /sensitive_content_detected/u);

  const lowValue = evaluateAutoApprovalPolicy(baseInput({
    sourceText: "继续",
    candidate: { ...baseInput().candidate, title: "fact:user-继续", content: "user:继续", confidence: 0.99, qualityScore: 0.99 },
  }));
  assert.equal(lowValue.decision, "reject");
  assert.match(lowValue.blocked_reasons.join(","), /low_value_or_temporary_content/u);
  assert.equal(lowValue.memory_policy.memory_class, "runtime_noise");

  const continuationMarker = evaluateAutoApprovalPolicy(baseInput({
    sourceText: "继续",
    candidate: {
      ...baseInput().candidate,
      title: "继续 llm-mpqf3mma-3fe0d90a5f-17-349ca7c103",
      content: "继续 llm-mpqf3mma-3fe0d90a5f-17-349ca7c103",
      confidence: 0.99,
      qualityScore: 0.99,
    },
  }));
  assert.equal(continuationMarker.decision, "reject");
  assert.match(continuationMarker.blocked_reasons.join(","), /low_value_or_temporary_content/u);
  assert.equal(continuationMarker.memory_policy.memory_class, "runtime_noise");
});

test("memory policy rejects explicit no-memory and runtime noise before pending", () => {
  const noMemory = evaluateAutoApprovalPolicy(baseInput({
    sourceText: "只是验证 Codex JSONL bridge 到 worker 的临时事件，不需要记住。",
    candidate: {
      ...baseInput().candidate,
      title: "临时 bridge 验证",
      content: "只是验证 Codex JSONL bridge 到 worker 的临时事件，不需要记住。",
      confidence: 0.99,
      qualityScore: 0.99,
    },
  }));
  assert.equal(noMemory.decision, "reject");
  assert.equal(noMemory.memory_policy.memory_class, "explicit_no_memory");
  assert.equal(noMemory.memory_policy.storage_target, "event_log_only");
  assert.equal(noMemory.memory_policy.recall_policy, "never");
  assert.equal(noMemory.memory_policy.policy_action, "reject_by_policy");

  const continuation = evaluateAutoApprovalPolicy(baseInput({
    sourceText: "继续",
    candidate: {
      ...baseInput().candidate,
      title: "继续 llm-mpqf3mma-3fe0d90a5f-17-349ca7c103",
      content: "user: 继续",
      confidence: 0.99,
      qualityScore: 0.99,
    },
  }));
  assert.equal(continuation.decision, "reject");
  assert.equal(continuation.memory_policy.memory_class, "runtime_noise");
  assert.equal(continuation.memory_policy.policy_action, "reject_by_policy");

  const planPrompt = evaluateAutoApprovalPolicy(baseInput({
    sourceText: "PLEASE IMPLEMENT THIS PLA<windows-drive>\n# Memory XX 全面扫描与落地差距评估计划\n\n## Summary\n当前结论：主链路可以正常使用，但还不能说所有功能已经完整落地。\n\n## Acceptance Criteria\n- candidate_current=0\n\n## Assumptions\n- 不扩大生产权限。",
    candidate: {
      ...baseInput().candidate,
      memoryType: "constraint",
      title: "constraint:user-please-implement-this-plan-memory-xx",
      content: "user: PLEASE IMPLEMENT THIS PLAN: # Memory XX 全面扫描与落地差距评估计划 ## Summary 当前结论：主链路可以正常使用，但还不能说所有功能已经完整落地。",
      metadata: { source: "conversation_ingest" },
    },
  }));
  assert.equal(planPrompt.decision, "reject");
  assert.equal(planPrompt.memory_policy.memory_class, "runtime_noise");
  assert.equal(planPrompt.memory_policy.policy_action, "reject_by_policy");
  assert.match(planPrompt.memory_policy.reasons.join(","), /implementation_plan_prompt_not_long_term_memory/u);

  const assistantProposedPlan = evaluateAutoApprovalPolicy(baseInput({
    sourceText: "1.建立 7 天 canary 报告机制：可以添加自动化的定时任务。\n2.我会在claude和openclaw进行真实的对话，这边需要你进行数据监控\nassistant: <proposed_plan> # Memory XX 7 天 Canary 报告与 Claude/OpenClaw 数据监控计划 ## Summary 目标是在不扩大生产权限的前提下，把当前 memory-xx 推进到真实生产反馈闭环。",
    candidate: {
      ...baseInput().candidate,
      memoryType: "constraint",
      title: "constraint:assistant-proposed-plan-memory-xx-7-天-canary-报告",
      content: "assistant: <proposed_plan> # Memory XX 7 天 Canary 报告与 Claude/OpenClaw 数据监控计划 ## Summary 目标是在不扩大生产权限的前提下，把当前 memory-xx 推进到真实生产反馈闭环。",
      metadata: { source: "conversation_ingest", source_role: "assistant" },
    },
  }));
  assert.equal(assistantProposedPlan.decision, "pending");
  assert.equal(assistantProposedPlan.memory_policy.memory_class, "decision");
  assert.equal(assistantProposedPlan.memory_policy.recall_policy, "explicit_only");
  assert.equal(assistantProposedPlan.memory_policy.policy_action, "create_candidate");
  assert.equal(assistantProposedPlan.memory_policy.assistant_memory_kind, "proposed_plan");
  assert.equal(assistantProposedPlan.memory_policy.evidence_level, "assistant_claim");
  assert.equal(assistantProposedPlan.memory_policy.lifecycle_intent, "proposed");
  assert.match(assistantProposedPlan.memory_policy.reasons.join(","), /assistant_proposed_plan_not_completed_fact/u);
});

test("memory policy separates assistant process noise from verified project status", () => {
  const processNoise = evaluateAutoApprovalPolicy(baseInput({
    sourceText: "assistant: 我会先检查当前文件和测试，然后再给出结果。",
    candidate: {
      ...baseInput().candidate,
      memoryType: "procedure",
      title: "assistant process update",
      content: "assistant: 我会先检查当前文件和测试，然后再给出结果。",
      metadata: { source: "conversation_ingest", source_role: "assistant" },
    },
  }));
  assert.equal(processNoise.decision, "reject");
  assert.equal(processNoise.memory_policy.memory_class, "runtime_noise");
  assert.equal(processNoise.memory_policy.policy_action, "reject_by_policy");
  assert.equal(processNoise.memory_policy.assistant_memory_kind, "process_noise");
  assert.equal(processNoise.memory_policy.evidence_level, "none");

  const verifiedStatus = evaluateAutoApprovalPolicy(baseInput({
    mode: "auto_approve",
    candidateOnly: false,
    sourceText: "assistant: 已验证 memory:qdrant-reconcile 输出 missing/stale/payload_drift/orphan 均为 0，Qdrant drift 为 0。",
    candidate: {
      ...baseInput().candidate,
      memoryType: "fact",
      title: "Qdrant projection status",
      content: "assistant: 已验证 memory:qdrant-reconcile 输出 missing/stale/payload_drift/orphan 均为 0，Qdrant drift 为 0。",
      metadata: {
        source: "conversation_ingest",
        source_role: "assistant",
        evidence_refs: ["memory:qdrant-reconcile -- --json"],
      },
      confidence: 0.99,
      qualityScore: 0.99,
    },
  }));
  assert.equal(verifiedStatus.decision, "approve");
  assert.equal(verifiedStatus.memory_policy.memory_class, "long_term_fact");
  assert.equal(verifiedStatus.memory_policy.recall_policy, "default");
  assert.equal(verifiedStatus.memory_policy.policy_action, "create_memory");
  assert.equal(verifiedStatus.memory_policy.assistant_memory_kind, "status_snapshot");
  assert.equal(verifiedStatus.memory_policy.evidence_level, "tool_observed");
  assert.match(verifiedStatus.memory_policy.reasons.join(","), /assistant_status_snapshot_with_evidence/u);
});

test("memory policy rejects memory-xx tools weekly short-memory promotion digests", () => {
  const digest = evaluateAutoApprovalPolicy(baseInput({
    source: "memory-xx-tools-plugin",
    sourceText: "# 短时记忆晋升记录\n\n**触发**: Memory Dreaming Promotion\n**类型**: 周度短时记忆晋升",
    candidate: {
      ...baseInput().candidate,
      scopeType: "workspace",
      scopeId: "current-instance",
      memoryType: "unknown",
      title: "周度短时记忆晋升 2026-06-01 03:30",
      content: "# 短时记忆晋升记录\n\n**时间**: 2026-06-01 03:30 (Asia/Shanghai)\n**触发**: cron Memory Dreaming Promotion\n**类型**: 周度短时记忆晋升",
      metadata: { source: "memory-xx-tools-plugin" },
      confidence: 0.99,
      qualityScore: 0.99,
    },
  }));

  assert.equal(digest.decision, "reject");
  assert.equal(digest.memory_policy.memory_class, "runtime_noise");
  assert.equal(digest.memory_policy.storage_target, "event_log_only");
  assert.equal(digest.memory_policy.recall_policy, "never");
  assert.equal(digest.memory_policy.policy_action, "reject_by_policy");
  assert.match(digest.memory_policy.reasons.join(","), /weekly_short_memory_promotion_digest_not_long_term_memory/u);
});

test("memory policy classifies test evidence, operational issues, and unknown source quarantine", () => {
  const perf = evaluateAutoApprovalPolicy(baseInput({
    sourceText: "perf-1",
    candidate: {
      ...baseInput().candidate,
      title: "perf-1",
      content: "perf-1",
      confidence: 0.99,
      qualityScore: 0.99,
    },
  }));
  assert.equal(perf.decision, "pending");
  assert.equal(perf.memory_policy.memory_class, "test_evidence");
  assert.equal(perf.memory_policy.recall_policy, "test_only");
  assert.equal(perf.memory_policy.policy_action, "create_candidate");

  const issue = evaluateAutoApprovalPolicy(baseInput({
    sourceText: "真实性问题：pending 候选池会把明确不需要记住的测试内容放入人工审批。",
    candidate: {
      ...baseInput().candidate,
      memoryType: "fact",
      title: "pending 候选池真实性问题",
      content: "pending 候选池会把明确不需要记住的测试内容放入人工审批。",
      confidence: 0.95,
      qualityScore: 0.93,
    },
  }));
  assert.equal(issue.memory_policy.memory_class, "operational_issue");
  assert.equal(issue.memory_policy.lifecycle_intent, "issue_open");
  assert.equal(issue.memory_policy.recall_policy, "explicit_only");

  const unknown = evaluateAutoApprovalPolicy(baseInput({
    source: "unknown",
    candidate: {
      ...baseInput().candidate,
      metadata: { source: "unknown" },
    },
  }));
  assert.equal(unknown.decision, "pending");
  assert.equal(unknown.memory_policy.memory_class, "unknown_source_quarantine");
  assert.equal(unknown.memory_policy.storage_target, "quarantine");
  assert.equal(unknown.memory_policy.recall_policy, "never");
  assert.equal(unknown.memory_policy.policy_action, "quarantine_candidate");
});

test("memory policy treats known internal sources as governed instead of unknown quarantine", () => {
  const selfImprovement = evaluateAutoApprovalPolicy({
    ...baseInput(),
    source: "memory:self-improvement",
    candidate: {
      ...baseInput().candidate,
      content: "memory-xx self-improvement entry reports doctor warnings for review.",
      title: "self improvement learning",
      metadata: { source: "memory:self-improvement" },
    },
  });

  assert.notEqual(selfImprovement.memory_policy.memory_class, "unknown_source_quarantine");
  assert.notEqual(selfImprovement.memory_policy.policy_action, "quarantine_candidate");
});

test("auto approval policy keeps conflict update supersede candidates pending", () => {
  for (const conflictAction of ["merge", "supersede", "update"]) {
    const result = evaluateAutoApprovalPolicy(baseInput({
      candidate: { ...baseInput().candidate, conflictAction },
      semanticConflict: true,
    }));
    assert.equal(result.decision, "pending");
    assert.match(result.blocked_reasons.join(","), /semantic_conflict|conflict_action_not_create/u);
  }

  const explicitUpdate = evaluateAutoApprovalPolicy(baseInput({
    sourceText: "我之前说 memory-xx 使用策略 A，现在改成策略 B，旧说法不要再用了。",
    candidate: {
      ...baseInput().candidate,
      memoryType: "decision",
      title: "memory-xx 策略从 A 改为 B",
      content: "memory-xx 使用策略 B，不再使用策略 A。",
      conflictAction: "create",
      confidence: 0.95,
      qualityScore: 1,
    },
  }));
  assert.equal(explicitUpdate.decision, "pending");
  assert.match(explicitUpdate.blocked_reasons.join(","), /explicit_update_requires_human_review/u);
});

test("auto approval policy honors candidate-only kill switch and hourly cap", () => {
  const candidateOnly = evaluateAutoApprovalPolicy(baseInput({
    candidate: { ...baseInput().candidate, scopeId: "memory-xx-no-scoped-bypass" },
    candidateOnly: true,
    candidateOnlyReasons: ["false_positive_proxy_high"],
  }));
  assert.equal(candidateOnly.decision, "pending");
  assert.match(candidateOnly.blocked_reasons.join(","), /candidate_only_kill_switch/u);
  assert.match(candidateOnly.blocked_reasons.join(","), /candidate_only:false_positive_proxy_high/u);

  const capped = evaluateAutoApprovalPolicy(baseInput({ recentApprovedCount: 20 }));
  assert.equal(capped.decision, "pending");
  assert.match(capped.blocked_reasons.join(","), /hourly_limit_reached/u);
});

test("auto approval policy allows scoped canary to bypass candidate-only", () => {
  const previousCanary = process.env.MEMORY_V2_AUTO_APPROVAL_CANARY;
  const previousScopes = process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
  try {
    process.env.MEMORY_V2_AUTO_APPROVAL_CANARY = "1";
    process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = "project:memory-xx";
    const result = evaluateAutoApprovalPolicy(baseInput({
      candidateOnly: true,
      candidateOnlyReasons: ["false_positive_proxy_high"],
    }));
    assert.equal(result.decision, "approve");
    assert.equal(result.candidate_only_bypassed, true);
    assert.doesNotMatch(result.blocked_reasons.join(","), /candidate_only_kill_switch/u);
  } finally {
    if (previousCanary === undefined) delete process.env.MEMORY_V2_AUTO_APPROVAL_CANARY;
    else process.env.MEMORY_V2_AUTO_APPROVAL_CANARY = previousCanary;
    if (previousScopes === undefined) delete process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
    else process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = previousScopes;
  }
});

test("auto approval policy treats scoped canary project as enabled", () => {
  const previousCanary = process.env.MEMORY_V2_AUTO_APPROVAL_CANARY;
  const previousScopes = process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
  try {
    process.env.MEMORY_V2_AUTO_APPROVAL_CANARY = "1";
    process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = "project:memory-xx-canary-scope";
    const result = evaluateAutoApprovalPolicy(baseInput({
      candidate: { ...baseInput().candidate, scopeId: "memory-xx-canary-scope" },
    }));
    assert.equal(result.decision, "approve");
    assert.doesNotMatch(result.blocked_reasons.join(","), /project_not_enabled/u);
  } finally {
    if (previousCanary === undefined) delete process.env.MEMORY_V2_AUTO_APPROVAL_CANARY;
    else process.env.MEMORY_V2_AUTO_APPROVAL_CANARY = previousCanary;
    if (previousScopes === undefined) delete process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
    else process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = previousScopes;
  }
});

test("auto approval policy supports tiered workspace and user canary scopes", () => {
  const previousCanary = process.env.MEMORY_V2_AUTO_APPROVAL_CANARY;
  const previousScopes = process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
  try {
    process.env.MEMORY_V2_AUTO_APPROVAL_CANARY = "1";
    process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = "workspace:current-instance,user:current-instance-owner";
    const workspace = evaluateAutoApprovalPolicy(baseInput({
      candidate: {
        ...baseInput().candidate,
        scopeType: "workspace",
        scopeId: "current-instance",
        memoryType: "fact",
        metadata: { source: "conversation_ingest", review_at: new Date(Date.now() + 86400000).toISOString() },
      },
    }));
    assert.equal(workspace.decision, "approve");
    assert.equal(workspace.scope_profile.id, "workspace");

    const user = evaluateAutoApprovalPolicy(baseInput({
      candidate: {
        ...baseInput().candidate,
        scopeType: "user",
        scopeId: "current-instance-owner",
        memoryType: "preference",
      },
    }));
    assert.equal(user.decision, "approve");
    assert.equal(user.scope_profile.id, "user");
  } finally {
    if (previousCanary === undefined) delete process.env.MEMORY_V2_AUTO_APPROVAL_CANARY;
    else process.env.MEMORY_V2_AUTO_APPROVAL_CANARY = previousCanary;
    if (previousScopes === undefined) delete process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
    else process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = previousScopes;
  }
});

test("auto approval policy keeps global scope manual by default", () => {
  withRuntimeDir(() => {
    const result = evaluateAutoApprovalPolicy(baseInput({
      sourceText: "请记住：默认全局作用域仍走人工审批。",
      candidate: {
        ...baseInput().candidate,
        scopeType: "global",
        scopeId: "global",
        memoryType: "fact",
        content: "默认全局作用域仍走人工审批。",
        confidence: 0.99,
        qualityScore: 0.99,
      },
    }));
    assert.equal(result.decision, "pending");
    assert.match(result.blocked_reasons.join(","), /global_scope_default_manual|scope_dry_run_only/u);
  });
});

test("auto approval policy does not open real workspace or user scopes without explicit test-scope bypass", () => {
  withRuntimeDir(() => {
    const workspace = evaluateAutoApprovalPolicy(baseInput({
      candidate: {
        ...baseInput().candidate,
        scopeType: "workspace",
        scopeId: "real-workspace",
        memoryType: "fact",
        metadata: { source: "conversation_ingest", review_at: new Date(Date.now() + 86400000).toISOString() },
      },
    }));
    assert.equal(workspace.decision, "pending");
    assert.match(workspace.blocked_reasons.join(","), /auto_approval_not_requested|scope_not_enabled/u);

    const user = evaluateAutoApprovalPolicy(baseInput({
      candidate: {
        ...baseInput().candidate,
        scopeType: "user",
        scopeId: "real-user",
        memoryType: "preference",
      },
    }));
    assert.equal(user.decision, "pending");
    assert.match(user.blocked_reasons.join(","), /auto_approval_not_requested|scope_not_enabled/u);
  });
});

test("auto approval runtime controls can hot-enable user and global add-only scopes", () => {
  withRuntimeDir((dir) => {
    writeScopeEnablements(dir, ["user:real-user", "global:global"]);
    writeRuntimeControls(dir, {
      user: {
        enabled: true,
        add_only: true,
        stable_preference: true,
        candidate_only_bypass: true,
      },
      global: {
        enabled: true,
        add_only: true,
        fact: true,
        candidate_only_bypass: true,
      },
    });

    const user = evaluateAutoApprovalPolicy(baseInput({
      candidateOnly: true,
      candidateOnlyReasons: ["false_positive_proxy_high"],
      candidate: {
        ...baseInput().candidate,
        scopeType: "user",
        scopeId: "real-user",
        memoryType: "preference",
        confidence: 0.97,
        qualityScore: 0.97,
      },
    }));
    assert.equal(user.decision, "approve");
    assert.equal(user.candidate_only_bypassed, true);
    assert.deepEqual(user.scope_profile.allowed_memory_types, ["preference"]);

    const global = evaluateAutoApprovalPolicy(baseInput({
      sourceText: "请把这条写进全局记忆：memory-xx 全局事实必须有显式全局写入意图。",
      candidateOnly: true,
      candidateOnlyReasons: ["false_positive_proxy_high"],
      candidate: {
        ...baseInput().candidate,
        scopeType: "global",
        scopeId: "global",
        memoryType: "fact",
        content: "memory-xx 全局事实必须有显式全局写入意图。",
        confidence: 0.99,
        qualityScore: 0.99,
      },
    }));
    assert.equal(global.decision, "approve");
    assert.equal(global.candidate_only_bypassed, true);
    assert.deepEqual(global.scope_profile.allowed_memory_types, ["fact"]);
  });
});

test("global add-only requires explicit global memory intent even when runtime switch is enabled", () => {
  withRuntimeDir((dir) => {
    writeScopeEnablements(dir, ["global:global"]);
    writeRuntimeControls(dir, {
      global: {
        enabled: true,
        add_only: true,
        fact: true,
        candidate_only_bypass: true,
      },
    });

    const result = evaluateAutoApprovalPolicy(baseInput({
      candidateOnly: true,
      candidateOnlyReasons: ["false_positive_proxy_high"],
      candidate: {
        ...baseInput().candidate,
        scopeType: "global",
        scopeId: "global",
        memoryType: "fact",
        confidence: 0.99,
        qualityScore: 0.99,
      },
    }));
    assert.equal(result.decision, "pending");
    assert.match(result.blocked_reasons.join(","), /global_explicit_intent_required/u);
  });
});

test("auto approval runtime subfeature switches narrow user memory types", () => {
  withRuntimeDir((dir) => {
    writeScopeEnablements(dir, ["user:real-user"]);
    writeRuntimeControls(dir, {
      user: {
        enabled: true,
        add_only: true,
        stable_preference: true,
        candidate_only_bypass: true,
      },
    });
    const result = evaluateAutoApprovalPolicy(baseInput({
      candidateOnly: true,
      candidateOnlyReasons: ["false_positive_proxy_high"],
      candidate: {
        ...baseInput().candidate,
        scopeType: "user",
        scopeId: "real-user",
        memoryType: "decision",
        confidence: 0.97,
        qualityScore: 0.97,
      },
    }));
    assert.equal(result.decision, "pending");
    assert.match(result.blocked_reasons.join(","), /memory_type_not_allowed/u);
  });
});

test("auto update runtime controls gate test and real scope apply", () => {
  withRuntimeDir((dir) => {
    const baseUpdate = {
      candidateId: "candidate-1",
      existingMemoryId: "old-1",
      scopeType: "project",
      scopeId: "auto-update-test-runtime",
      memoryType: "fact",
      operation: "update",
      conflictAction: "update",
      content: "之前使用 A，现在改成 B。",
      existingContent: "之前使用 A。",
      confidence: 0.99,
      qualityScore: 0.99,
      agentId: "codex",
      source: "conversation_ingest",
      metadata: {},
    } as const;

    writeRuntimeControls(dir, { update_apply: { test_scope_apply: true } });
    assert.equal(evaluateAutoUpdatePolicy(baseUpdate).apply_allowed, true);

    writeRuntimeControls(dir, { update_apply: { test_scope_apply: false } });
    const disabledTestScope = evaluateAutoUpdatePolicy(baseUpdate);
    assert.equal(disabledTestScope.apply_allowed, false);
    assert.equal(disabledTestScope.apply_blocked_reason, "auto_update_apply_real_scope_disabled");

    writeRuntimeControls(dir, {
      update_apply: {
        enabled: true,
        real_project_apply: true,
        explicit_replacement: true,
      },
    });
    const realProject = evaluateAutoUpdatePolicy({ ...baseUpdate, scopeId: "memory-xx" });
    assert.equal(realProject.apply_allowed, true);
    assert.match(realProject.why_safe_or_unsafe, /guarded project:memory-xx/u);

    const otherRealProject = evaluateAutoUpdatePolicy({ ...baseUpdate, scopeId: "other-project" });
    assert.equal(otherRealProject.apply_allowed, false);
    assert.equal(otherRealProject.apply_blocked_reason, "auto_update_apply_real_scope_disabled");

    const userUpdate = evaluateAutoUpdatePolicy({ ...baseUpdate, scopeType: "user", scopeId: "current-user" });
    assert.equal(userUpdate.apply_allowed, false);
    assert.equal(userUpdate.apply_blocked_reason, "auto_update_apply_real_scope_disabled");

    const workspaceUpdate = evaluateAutoUpdatePolicy({ ...baseUpdate, scopeType: "workspace", scopeId: "current-instance" });
    assert.equal(workspaceUpdate.apply_allowed, false);
    assert.equal(workspaceUpdate.apply_blocked_reason, "auto_update_apply_real_scope_disabled");

    writeRuntimeControls(dir, {
      update_apply: {
        enabled: true,
        user_apply: true,
        preference_change_apply: true,
      },
    });
    const currentUserPreference = evaluateAutoUpdatePolicy({
      ...baseUpdate,
      scopeType: "user",
      scopeId: "current-user",
      memoryType: "preference",
      content: "我之前偏好 A，现在改成 B。",
    });
    assert.equal(currentUserPreference.apply_allowed, true);
    assert.equal(currentUserPreference.apply_blocked_reason, null);
    assert.match(currentUserPreference.why_safe_or_unsafe, /guarded user:current-user/u);

    const otherUserPreference = evaluateAutoUpdatePolicy({
      ...baseUpdate,
      scopeType: "user",
      scopeId: "other-user",
      memoryType: "preference",
      content: "我之前偏好 A，现在改成 B。",
    });
    assert.equal(otherUserPreference.apply_allowed, false);
    assert.equal(otherUserPreference.apply_blocked_reason, "auto_update_apply_real_scope_disabled");

    writeRuntimeControls(dir, {
      update_apply: {
        enabled: true,
        global_apply: true,
        explicit_replacement: true,
      },
    });
    const globalWithoutIntent = evaluateAutoUpdatePolicy({ ...baseUpdate, scopeType: "global", scopeId: "global" });
    assert.equal(globalWithoutIntent.apply_allowed, false);
    assert.equal(globalWithoutIntent.apply_blocked_reason, "global_explicit_intent_required");

    const globalWithIntent = evaluateAutoUpdatePolicy({
      ...baseUpdate,
      scopeType: "global",
      scopeId: "global",
      content: "请写进全局记忆：之前全局约束 A，现在改成全局约束 B。",
      existingContent: "全局约束 A。",
    });
    assert.equal(globalWithIntent.apply_allowed, true);
    assert.match(globalWithIntent.why_safe_or_unsafe, /global keyword-intent/u);

    writeRuntimeControls(dir, {
      update_apply: {
        enabled: true,
        real_project_apply: true,
        explicit_replacement: false,
      },
    });
    const typeDisabled = evaluateAutoUpdatePolicy({ ...baseUpdate, scopeId: "memory-xx" });
    assert.equal(typeDisabled.apply_allowed, false);
    assert.equal(typeDisabled.apply_blocked_reason, "auto_update_type_apply_disabled");
  });
});

test("auto update never auto applies merge unclear conflict or non-user preference change", () => {
  withRuntimeDir((dir) => {
    writeRuntimeControls(dir, {
      update_apply: {
        enabled: true,
        test_scope_apply: true,
        user_apply: true,
        global_apply: true,
        merge_apply: true,
        preference_change_apply: true,
      },
    });
    const baseUpdate = {
      candidateId: "candidate-1",
      existingMemoryId: "old-1",
      scopeType: "project",
      scopeId: "auto-update-test-guard",
      memoryType: "fact",
      operation: "update",
      content: "候选内容",
      existingContent: "旧内容",
      confidence: 0.99,
      qualityScore: 0.99,
      agentId: "codex",
      source: "conversation_ingest",
      metadata: {},
    } as const;

    const merge = evaluateAutoUpdatePolicy({ ...baseUpdate, conflictAction: "merge" });
    assert.equal(merge.detected_update_type, "merge_candidate");
    assert.equal(merge.apply_allowed, false);
    assert.equal(merge.apply_blocked_reason, "auto_update_type_apply_disabled");

    const unclear = evaluateAutoUpdatePolicy({ ...baseUpdate, conflictAction: "conflict", content: "可能是另一个事实。" });
    assert.equal(unclear.detected_update_type, "conflict_unclear");
    assert.equal(unclear.apply_allowed, false);
    assert.equal(unclear.apply_blocked_reason, "auto_update_type_apply_disabled");

    const projectPreference = evaluateAutoUpdatePolicy({
      ...baseUpdate,
      memoryType: "preference",
      conflictAction: "update",
      content: "我之前偏好 A，现在改成 B。",
    });
    assert.equal(projectPreference.detected_update_type, "preference_change");
    assert.equal(projectPreference.apply_allowed, false);
    assert.equal(projectPreference.apply_blocked_reason, "auto_update_type_apply_disabled");

    const userPreference = evaluateAutoUpdatePolicy({
      ...baseUpdate,
      scopeType: "user",
      scopeId: "current-user",
      memoryType: "preference",
      conflictAction: "update",
      content: "我之前偏好 A，现在改成 B。",
    });
    assert.equal(userPreference.detected_update_type, "preference_change");
    assert.equal(userPreference.apply_allowed, true);
    assert.equal(userPreference.apply_blocked_reason, null);
  });
});

test("auto approval policy blocks on operational health blockers", () => {
  const result = evaluateAutoApprovalPolicy(baseInput({
    operationalBlockers: ["outbox_failed_events"],
  }));
  assert.equal(result.decision, "pending");
  assert.match(result.blocked_reasons.join(","), /operational_blocker:outbox_failed_events/u);
});

test("auto approval policy requires rebuildable evidence for graph relation memories", () => {
  const missing = evaluateAutoApprovalPolicy(baseInput({
    candidate: {
      ...baseInput().candidate,
      memoryType: "fact",
      content: "module A depends on module B",
      metadata: {
        source: "conversation_ingest",
        auto_approval_test_case_type: "graph_relation",
        graph_relation: true,
      },
    },
  }));
  assert.equal(missing.decision, "pending");
  assert.match(missing.blocked_reasons.join(","), /graph_evidence_required/u);
  assert.match(missing.blocked_reasons.join(","), /graph_source_evidence_missing/u);

  const approved = evaluateAutoApprovalPolicy(baseInput({
    candidate: {
      ...baseInput().candidate,
      memoryType: "fact",
      content: "module A depends on module B",
      metadata: {
        source: "conversation_ingest",
        auto_approval_test_case_type: "graph_relation",
        graph_relation: true,
        graph_evidence: {
          source_uri: "memory-xx-test:graph:1",
          source_evidence: ["content:module A depends on module B"],
          entity_path: ["module:A", "module:B"],
          relation_path: ["module:A -> depends_on -> module:B"],
          rebuildable: true,
        },
      },
    },
  }));
  assert.equal(approved.decision, "approve");
  assert.match(approved.reasons.join(","), /graph_evidence_ok/u);
});

test("auto approval policy blocks PII, expired candidates, and workspace records without review_at", () => {
  const pii = evaluateAutoApprovalPolicy(baseInput({
    sourceText: "user email is person@example.com",
    candidate: { ...baseInput().candidate, content: "user email is person@example.com" },
  }));
  assert.equal(pii.decision, "pending");
  assert.match(pii.blocked_reasons.join(","), /pii_requires_human_review/u);

  const expired = evaluateAutoApprovalPolicy(baseInput({
    candidate: { ...baseInput().candidate, metadata: { expires_at: new Date(Date.now() - 1000).toISOString() } },
  }));
  assert.equal(expired.decision, "pending");
  assert.match(expired.blocked_reasons.join(","), /expired_candidate/u);

  const previousCanary = process.env.MEMORY_V2_AUTO_APPROVAL_CANARY;
  const previousScopes = process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
  try {
    process.env.MEMORY_V2_AUTO_APPROVAL_CANARY = "1";
    process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = "workspace:current-instance";
    const workspace = evaluateAutoApprovalPolicy(baseInput({
      candidate: {
        ...baseInput().candidate,
        scopeType: "workspace",
        scopeId: "current-instance",
        memoryType: "fact",
      },
    }));
    assert.equal(workspace.decision, "pending");
    assert.match(workspace.blocked_reasons.join(","), /review_at_required/u);
  } finally {
    if (previousCanary === undefined) delete process.env.MEMORY_V2_AUTO_APPROVAL_CANARY;
    else process.env.MEMORY_V2_AUTO_APPROVAL_CANARY = previousCanary;
    if (previousScopes === undefined) delete process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
    else process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = previousScopes;
  }
});

test("self-improvement auto approval remains report-only", () => {
  const previousCanary = process.env.MEMORY_V2_AUTO_APPROVAL_CANARY;
  const previousScopes = process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
  try {
    process.env.MEMORY_V2_AUTO_APPROVAL_CANARY = "1";
    process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = "project:memory-xx-self-improvement";
    const result = evaluateAutoApprovalPolicy(baseInput({
      sourceText: "建议自动修复并重启服务。",
      candidate: {
        ...baseInput().candidate,
        scopeType: "project",
        scopeId: "memory-xx-self-improvement",
        memoryType: "ops_proposal",
        content: "建议自动修复并重启服务。",
      },
    }));
    assert.equal(result.decision, "pending");
    assert.match(result.blocked_reasons.join(","), /self_improvement_report_only/u);
  } finally {
    if (previousCanary === undefined) delete process.env.MEMORY_V2_AUTO_APPROVAL_CANARY;
    else process.env.MEMORY_V2_AUTO_APPROVAL_CANARY = previousCanary;
    if (previousScopes === undefined) delete process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES;
    else process.env.MEMORY_V2_AUTO_APPROVAL_CANDIDATE_ONLY_BYPASS_SCOPES = previousScopes;
  }
});

test("privacy scanner blocks hard secrets but not safe ids and versions", () => {
  const secret = scanMemoryPrivacy("api_key=sk_1234567890abcdefghijklmnop");
  assert.equal(secret.blocked, true);
  assert.equal(secret.findings.some((finding) => finding.kind === "secret"), true);

  const spacedProviderToken = scanMemoryPrivacy("临时 token sk_llm-mpqf3mma-3fe0d90a5f-8-be370f0e9e_1234567890abcdefghijklmnop 用于调用");
  assert.equal(spacedProviderToken.blocked, true);
  assert.equal(spacedProviderToken.findings.some((finding) => finding.reason === "secret_keyword_provider_token" || finding.reason === "provider_token"), true);

  const safe = scanMemoryPrivacy("issue-123456789 fixed in v3.0.21");
  assert.equal(safe.blocked, false);
  assert.equal(safe.findings.some((finding) => finding.kind === "safe"), true);
});

test("auto approval feedback freeze requires sample size and false positive threshold", () => {
  assert.deepEqual(shouldFreezeAutoApprovalCohort({
    sampleSize: 10,
    negativeCount: 2,
    minSample: 20,
    freezeRate: 0.05,
  }), {
    freeze: false,
    falsePositiveRate: 0.2,
    reason: "insufficient_sample",
  });

  const frozen = shouldFreezeAutoApprovalCohort({
    sampleSize: 20,
    negativeCount: 1,
    minSample: 20,
    freezeRate: 0.05,
  });
  assert.equal(frozen.freeze, true);
  assert.equal(frozen.reason, "freeze_threshold_met");
});

test("auto approval feedback freeze metrics cover rollback manual and recall negative triggers", () => {
  const insufficient = shouldFreezeAutoApprovalCohortMetrics({
    sampleSize: 10,
    negativeCount: 9,
    rollbackCount: 9,
    manualArchiveDeleteCount: 9,
    recallNegativeCount: 9,
    positiveCount: 0,
    minSample: 20,
    falsePositiveFreezeRate: 0.05,
    rollbackFreezeRate: 0.03,
    manualArchiveDeleteFreezeRate: 0.05,
    recallNegativeFreezeRate: 0.05,
  });
  assert.equal(insufficient.freeze, false);
  assert.equal(insufficient.reason, "insufficient_sample");

  const frozen = shouldFreezeAutoApprovalCohortMetrics({
    sampleSize: 100,
    negativeCount: 0,
    rollbackCount: 3,
    manualArchiveDeleteCount: 5,
    recallNegativeCount: 5,
    positiveCount: 80,
    minSample: 20,
    falsePositiveFreezeRate: 0.05,
    rollbackFreezeRate: 0.03,
    manualArchiveDeleteFreezeRate: 0.05,
    recallNegativeFreezeRate: 0.05,
  });
  assert.equal(frozen.freeze, true);
  assert.equal(frozen.reason, "freeze_threshold_met");
  assert.deepEqual(frozen.triggeredBy, ["rollback_rate", "manual_archive_delete_rate", "recall_negative_feedback_rate"]);
  assert.equal(frozen.rollbackRate, 0.03);
  assert.equal(frozen.manualArchiveDeleteRate, 0.05);
  assert.equal(frozen.recallNegativeFeedbackRate, 0.05);
  assert.equal(frozen.cleanRunCount, 80);
});
