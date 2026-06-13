import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAutonomousClosureGovernanceAction,
  buildAutonomousClosureMetadata,
  isAutonomousClosureAlreadyApplied,
  planAutonomousPendingClosure,
  type PendingAutonomousClosureRow,
} from "../app/governance/memory-auto-approval-sweep";

function row(input: {
  id: string;
  scope_id?: string;
  title: string;
  content: string;
  memory_type?: string;
  source?: string;
  agent_id?: string;
  metadata?: Record<string, unknown>;
}): PendingAutonomousClosureRow {
  return {
    id: input.id,
    scope_type: input.scope_id?.startsWith("current-instance") ? "workspace" : "project",
    scope_id: input.scope_id ?? "memory-xx",
    title: input.title,
    content: input.content,
    memory_type: input.memory_type ?? "fact",
    metadata: {
      source: input.source ?? "conversation_ingest",
      agent_id: input.agent_id ?? "openclaw",
      ...input.metadata,
    },
    created_by: "klee",
  };
}

function phase3Fixture(): PendingAutonomousClosureRow[] {
  return [
    row({ id: "model", title: "Preferred model", content: "User uses model dreamfield/DeepSeek-V4-Flash" }),
    row({
      id: "subagent",
      title: "子agent模型和并发限制",
      content: "可以使用子agent，子agent模型使用dreamfield/DeepSeek-V4-Flash，没有并发上限。必须进行真实的测评和检查。",
      memory_type: "constraint",
    }),
    row({
      id: "wsl",
      title: "codex运行环境：WSL运行，Windows前端显示",
      content: "在WSL下运行codex，前端工具显示在Windows下，设置中可配置。",
      memory_type: "constraint",
    }),
    row({ id: "issue-1", title: "模型连接失败报错", content: "用户报告模型无法连接，报错信息为stream disconnected before completion: stream closed before response.completed" }),
    row({ id: "issue-2", title: "模型持续重新安装配置", content: "用户报告模型会一直重新安装配置空间" }),
    row({ id: "issue-3", title: "无法下载插件和skills", content: "用户报告无法下载插件和skills" }),
    ...Array.from({ length: 9 }, (_, index) => row({
      id: `unknown-${index + 1}`,
      title: index === 8 ? "MCP测试" : index >= 3 ? `perf-${index - 2}` : "unknown",
      content: index === 8 ? "通过MCP写入的记忆审计测试" : index >= 3 ? `性能测试记忆第${index - 2}条` : "unknown source audit row",
      memory_type: "unknown",
      source: "unknown",
      agent_id: "klee",
      metadata: { memory_class: "unknown_source_quarantine", recall_policy: "never" },
    })),
    row({
      id: "test-only",
      title: "memory-xx完整审计测试要求",
      content: "需要对memory-xx进行完整的代码审计和功能测试，包括全部完整的功能。",
      memory_type: "procedure",
      metadata: { memory_class: "test_evidence", recall_policy: "test_only" },
    }),
    ...Array.from({ length: 8 }, (_, index) => row({
      id: `conversation-process-${index + 1}`,
      scope_id: `real-user-${index}`,
      title: index % 2 === 0 ? "候选生成与审批流程" : "conversation ingest 生成待审批候选",
      content: "通过 conversation ingest 生成待审批候选，不会自动批准。",
      memory_type: "procedure",
      agent_id: "codex",
    })),
    ...Array.from({ length: 3 }, (_, index) => row({
      id: `canary-${index + 1}`,
      scope_id: `memory-xx-auto-approval-e2e-aac-${index}`,
      title: "Auto approval canary rollback evidence requirement",
      content: `memory-xx automatic approval canary requires rollback evidence. Auto approval canary marker aac-${index}.`,
      memory_type: "constraint",
      agent_id: "codex",
    })),
    ...Array.from({ length: 2 }, (_, index) => row({
      id: `worker-${index + 1}`,
      scope_id: `conversation-worker-${index}`,
      title: `conversation worker ${index} 执行顺序`,
      content: `conversation worker ${index} 必须先落 JSONL spool，再通过 worker 生成 pending candidate`,
      memory_type: "constraint",
      agent_id: "codex",
    })),
    ...Array.from({ length: 2 }, (_, index) => row({
      id: `weekly-${index + 1}`,
      scope_id: "current-instance",
      title: `周度短时记忆晋升 2026-05-${29 + index} 03:30`,
      content: "# 短时记忆晋升记录\n\n**触发**: Memory Dreaming Promotion\n**类型**: 周度短时记忆晋升",
      memory_type: "unknown",
      source: "memory-xx-tools-plugin",
      agent_id: "main",
    })),
    ...Array.from({ length: 3 }, (_, index) => row({
      id: `self-${index + 1}`,
      scope_id: "memory-xx-self-improvement",
      title: "[SELF-IMPROVEMENT:learning] memory-xx doctor reported warnings",
      content: "memory-xx self-improvement entry.\nType: learning\nStatus: pending\nReport-Only: true\nRecurrence-Count: 1",
      memory_type: "status",
      source: "memory:self-improvement",
      agent_id: "memory-xx-self-improvement",
      metadata: { recurrence_count: 1, report_only: true },
    })),
    row({
      id: "one-time-audit",
      title: "审计最终目标",
      content: "最终目标：找出记忆框架目前存在的问题，将结果整理汇总为一份.md文件。",
      memory_type: "decision",
    }),
    row({
      id: "config-dump",
      title: "preference:user-现在windows的codex好像出了点问题-你看一下-d-codex-home-这是",
      content: "user: 现在windows的codex好像出了点问题，你看一下\"<windows-drive>\\codex-home\"这是他的项目地址 下面是他的配置文件 model_provider = \"codexshare\" model = \"gpt-5.5\" model_reasoning_effort = \"high\" [mcp_servers.example.env]",
      memory_type: "preference",
    }),
  ];
}

test("autonomous pending closure classifies the 36 pending sample into 6 approvals and 30 rejections", () => {
  const plan = planAutonomousPendingClosure(phase3Fixture());

  assert.equal(plan.summary.total, 36);
  assert.equal(plan.summary.would_approve_default, 3);
  assert.equal(plan.summary.would_approve_explicit_issue, 3);
  assert.equal(plan.summary.would_reject_closed, 6);
  assert.equal(plan.summary.would_reject_test_noise, 14);
  assert.equal(plan.summary.would_reject_sensitive, 1);
  assert.equal(plan.summary.would_reject_unknown_source, 9);
  assert.equal(plan.summary.would_keep_pending, 0);
});

test("autonomous pending closure applies explicit issue isolation and default approval metadata", () => {
  const plan = planAutonomousPendingClosure(phase3Fixture());
  const model = plan.groups.would_approve_default.find((item) => item.id === "model");
  const issue = plan.groups.would_approve_explicit_issue.find((item) => item.id === "issue-1");
  assert.ok(model);
  assert.ok(issue);

  assert.equal(model.recall_policy, "default");
  assert.equal(model.lifecycle_intent, "active");
  assert.equal(issue.recall_policy, "explicit_only");
  assert.equal(issue.lifecycle_intent, "issue_open");

  const metadata = buildAutonomousClosureMetadata(
    { source: "conversation_ingest" },
    issue,
    { runId: "auto-sweep-run-1", appliedAt: "2026-06-01T00:00:00.000Z" },
  );
  assert.equal(metadata.autonomous_action, "approve_explicit_issue");
  assert.equal(metadata.recall_policy, "explicit_only");
  assert.equal(metadata.lifecycle_intent, "issue_open");
  assert.equal(isAutonomousClosureAlreadyApplied(metadata, issue), true);
});

test("autonomous pending closure governance action preserves before and after evidence", () => {
  const item = planAutonomousPendingClosure(phase3Fixture()).groups.would_reject_sensitive[0];
  assert.ok(item);

  const action = buildAutonomousClosureGovernanceAction({
    runId: "auto-sweep-run-1",
    row: phase3Fixture().find((candidate) => candidate.id === item.id)!,
    item,
    beforeState: {
      lifecycle_status: "candidate",
      review_state: "pending",
      is_current: true,
    },
    afterState: {
      lifecycle_status: "rejected",
      review_state: "rejected",
      is_current: false,
    },
  });

  assert.equal(action.actionType, "memory_auto_approval_sweep");
  assert.equal(action.memoryId, "config-dump");
  assert.equal(action.evidence.autonomous_action, "reject_sensitive");
  assert.equal(action.evidence.memory_class, "runtime_noise");
  assert.equal(action.status, "applied");
});

test("autonomous pending closure uses assistant memory kind for canary assistant samples", () => {
  const plan = planAutonomousPendingClosure([
    row({
      id: "assistant-process",
      title: "assistant process update",
      content: "assistant: 我会先检查当前文件和测试，然后再给出结果。",
      memory_type: "procedure",
      agent_id: "codex",
      metadata: { source_role: "assistant" },
    }),
    row({
      id: "assistant-plan",
      title: "assistant proposed plan",
      content: "assistant: <proposed_plan> # Memory XX Pending Canary 修复计划\n## Summary\n完善自动审批规则。",
      memory_type: "decision",
      agent_id: "codex",
      metadata: { source_role: "assistant" },
    }),
    row({
      id: "assistant-status",
      title: "Qdrant projection status",
      content: "assistant: 已验证 memory:qdrant-reconcile 输出 missing/stale/payload_drift/orphan 均为 0，Qdrant drift 为 0。",
      memory_type: "fact",
      agent_id: "codex",
      metadata: { source_role: "assistant", evidence_refs: ["memory:qdrant-reconcile -- --json"] },
    }),
  ]);

  assert.equal(plan.summary.total, 3);
  assert.equal(plan.summary.would_reject_test_noise, 1);
  assert.equal(plan.summary.would_event_log_only, 1);
  assert.equal(plan.summary.would_keep_pending, 0);
  assert.equal(plan.summary.would_approve_default, 1);

  const rejected = plan.groups.would_reject_test_noise[0];
  assert.equal(rejected.id, "assistant-process");
  assert.equal(rejected.assistant_memory_kind, "process_noise");
  assert.equal(rejected.evidence_level, "none");

  const proposed = plan.groups.would_event_log_only[0];
  assert.equal(proposed.id, "assistant-plan");
  assert.equal(proposed.recall_policy, "never");
  assert.equal(proposed.lifecycle_intent, "rejected");
  assert.equal(proposed.assistant_memory_kind, "proposed_plan");
  assert.match(proposed.reasons.join(","), /document_artifact_routed_to_knowledge_base/u);

  const status = plan.groups.would_approve_default[0];
  assert.equal(status.id, "assistant-status");
  assert.equal(status.assistant_memory_kind, "status_snapshot");
  assert.equal(status.evidence_level, "tool_observed");
});

test("current canary pending sample rules separate real memory, issues, tests, and document artifacts", () => {
  const plan = planAutonomousPendingClosure([
    row({
      id: "language-pref",
      title: "用户语言偏好",
      content: "用户161136要求使用中文回复",
      memory_type: "preference",
      agent_id: "openclaw-main",
    }),
    row({
      id: "mcp-wsl",
      title: "MCP连接WSL memory-xx",
      content: "用户通过MCP连接到WSL下的memory-xx",
      memory_type: "fact",
      agent_id: "openclaw",
    }),
    row({
      id: "wx-storage",
      title: "微信小程序控制台存储API",
      content: "在微信小程序开发者工具控制台中，应使用 wx.setStorageSync 而非 uni.setStorageSync 来设置存储",
      memory_type: "fact",
      agent_id: "codex",
    }),
    row({
      id: "decision-points",
      title: "方案制定前需锁定的三个决策点",
      content: "在制定解决方案前，需要先锁定三个关键决策：run/task 是保持 runtime-only 还是新增临时记忆；MCP 是用 scoped trusted-agent 还是 admin；filter_mode 是权限驱动还是环境开关。",
      memory_type: "decision",
      agent_id: "codex",
    }),
    row({
      id: "filter-mode-issue",
      title: "filter_mode all/governance 权限问题",
      content: "Memory XX API 检索与过滤测试中，filter_mode=all 和 filter_mode=governance 即使使用 admin token 也返回 403。",
      memory_type: "constraint",
      agent_id: "openclaw-main",
    }),
    row({
      id: "mcp-stdio-issue",
      title: "memory-xx MCP stdio 传输已知问题",
      content: "memory-xx MCP 的 stdio 传输在 stdin 关闭时立即退出；HTTP 传输（:5100/mcp）是正确测试方式。",
      memory_type: "fact",
      agent_id: "openclaw",
    }),
    row({
      id: "xyphos-test",
      scope_id: "test-project-xyphos",
      title: "Xyphos API version",
      content: "API version 3 is live for project Xyphos.",
      memory_type: "decision",
      source: "memory-xx-intelligence-smart-write",
      agent_id: "intelligence",
    }),
    row({
      id: "unified-test",
      scope_id: "test-user-unified-4",
      title: "unified-test-4",
      content: "Unified remember API test with full fields",
      memory_type: "unknown",
      source: "unified-api",
      agent_id: "test-agent",
    }),
    row({
      id: "api-test",
      scope_id: "current-instance",
      title: "Test 3 - with metadata",
      content: "Test 3 - with metadata",
      memory_type: "unknown",
      source: "api-test",
      agent_id: "klee",
    }),
    row({
      id: "assistant-long-plan",
      title: "assistant-proposed-plan-memory-xx-7天-canary",
      content: "assistant: <proposed_plan> # Memory XX 7 天 Canary 报告与 Claude/OpenClaw 数据监控计划\n## Summary\n目标是在不扩大生产权限的前提下，把当前 memory-xx 推进到真实生产反馈闭环。\n## Test Plan\n运行 landing scan 和 canary report。",
      memory_type: "constraint",
      agent_id: "codex",
      metadata: { source_role: "assistant" },
    }),
  ]);

  assert.equal(plan.summary.total, 10);
  assert.equal(plan.summary.would_approve_default, 4);
  assert.equal(plan.summary.would_approve_explicit_issue, 2);
  assert.equal(plan.summary.would_reject_test_noise, 3);
  assert.equal(plan.summary.would_event_log_only, 1);
  assert.equal(plan.summary.would_keep_pending, 0);

  assert.deepEqual(plan.groups.would_approve_default.map((item) => item.id).sort(), [
    "decision-points",
    "language-pref",
    "mcp-wsl",
    "wx-storage",
  ]);
  assert.deepEqual(plan.groups.would_approve_explicit_issue.map((item) => item.id).sort(), [
    "filter-mode-issue",
    "mcp-stdio-issue",
  ]);
  assert.deepEqual(plan.groups.would_reject_test_noise.map((item) => item.id).sort(), [
    "api-test",
    "unified-test",
    "xyphos-test",
  ]);
  const documentArtifact = plan.groups.would_event_log_only[0];
  assert.equal(documentArtifact.id, "assistant-long-plan");
  assert.match(documentArtifact.reasons.join(","), /document_artifact_routed_to_knowledge_base/u);
});

test("current residual canary pending samples close into memory, issue, or event evidence", () => {
  const plan = planAutonomousPendingClosure([
    row({
      id: "mcp-pass",
      title: "memory-xx MCP 协议测试全部通过",
      content: "memory-xx MCP 协议测试全部通过：17/17 PASS，包括协议测试5项、资源测试2项、错误处理3项；工具调用因 token 权限返回 403，但协议层处理正确。",
      memory_type: "fact",
      agent_id: "openclaw",
    }),
    row({
      id: "malformed-status",
      title: "malformed JSON 状态码回归修复决策",
      content: "复用 parseJsonBody() 的 POST JSON handler 中 invalid_json_body 必须返回 400，body_read_timeout 返回 408，body_too_large 返回 413，其他异常保持 500。",
      memory_type: "constraint",
      agent_id: "codex",
    }),
    row({
      id: "malformed-endpoints",
      title: "malformed JSON 测试覆盖端点清单",
      content: "malformed JSON 测试需覆盖 /api/memory/xx/skills/execute、/api/memory/xx/intelligence/extract、/api/memory/xx/intelligence/smart-write、/api/memory/xx/mcp/smart-write。",
      memory_type: "constraint",
      agent_id: "codex",
    }),
    row({
      id: "embedding-manifest-fix",
      title: "embedding manifest 不一致修复步骤",
      content: "active embedding manifest 计数/健康校验与 Postgres/Qdrant 实际状态不一致时，控制面板显示'已阻断'。修复命令：memory:auto-repair、memory:embedding-manifest refresh、validate。",
      memory_type: "procedure",
      agent_id: "codex",
    }),
    row({
      id: "qdrant-archived-policy",
      title: "archived 记录不应出现在 Qdrant active collection",
      content: "archived 记录不应出现在 Qdrant active collection 中，健康校验按 active Qdrant 只放可召回记录判断，archived 记录导致 Qdrant 点数多于 Postgres 当前可召回数。",
      memory_type: "constraint",
      agent_id: "codex",
    }),
    row({
      id: "plan-mode-limitation",
      title: "Memory XX 治理修复计划执行状态与限制",
      content: "Memory XX Pending Canary 与 Assistant 记忆治理修复计划已启动执行，但当前处于 Plan Mode，不能改文件或执行 apply 类修复，需先锁定执行顺序、检查点和切换条件。",
      memory_type: "constraint",
      agent_id: "codex",
    }),
    row({
      id: "knowledge-archive-pref",
      title: "完成文件归档策略",
      content: "用户认为完成的计划文件和报告应写入向量知识库，本地不再保存。用户认为local目录下计划文件和报告文件过多且杂乱，需要解决。",
      memory_type: "constraint",
      agent_id: "codex",
    }),
    row({
      id: "knowledge-split",
      title: "知识库分类方案",
      content: "用户建议在PG中开辟新内容作为知识库，分为用户知识库和项目知识库。",
      memory_type: "constraint",
      agent_id: "codex",
    }),
    row({
      id: "inter-session",
      title: "fact:user-inter-session-message-sourcesession-agent-m",
      content: "user: [Inter-session message] sourceSession=agent:main:subagent:23d57790 sourceChannel=webchat sourceTool=subagent_announce isUser=false",
      memory_type: "fact",
      agent_id: "openclaw-main",
    }),
    row({
      id: "raw-context",
      title: "constraint:user-environment-context-current-date-2026-06-02",
      content: "user: <environment_context> <current_date>2026-06-02</current_date> </environment_context> user: 小程序使用的时候出现以上报错 assistant: 我继续看。",
      memory_type: "constraint",
      agent_id: "codex",
    }),
    row({
      id: "continue-message",
      title: "fact:user-message-id-om-x100b6edd264c2cb4c3c24efde13f",
      content: "user: [message_id: om_x100b6edd264c2cb4c3c24efde13fd42] 用户161136: 继续 assistant: 好，我先全面了解 memory-xx 当前状态。",
      memory_type: "fact",
      agent_id: "openclaw-main",
    }),
    row({
      id: "assistant-review-process",
      title: "fact:user-看一下有没有因为这些变更而又引起别的问题",
      content: "user: 看一下有没有因为这些变更而又引起别的问题？ assistant: 我会用代码审查 + 验证的方式看这批改动有没有引入新问题；当前是 Plan Mode，我只做非破坏性检查，不会改文件。",
      memory_type: "fact",
      agent_id: "codex",
    }),
  ]);

  assert.equal(plan.summary.total, 12);
  assert.equal(plan.summary.would_keep_pending, 0);
  assert.deepEqual(plan.groups.would_approve_default.map((item) => item.id).sort(), [
    "embedding-manifest-fix",
    "knowledge-archive-pref",
    "knowledge-split",
    "malformed-endpoints",
    "malformed-status",
    "mcp-pass",
    "plan-mode-limitation",
    "qdrant-archived-policy",
  ]);
  assert.deepEqual(plan.groups.would_reject_test_noise.map((item) => item.id).sort(), [
    "assistant-review-process",
    "continue-message",
    "inter-session",
    "raw-context",
  ]);
});
