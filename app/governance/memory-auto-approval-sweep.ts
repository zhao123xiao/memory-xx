import type { ExtractedMemoryClass } from "../intelligence/types";
import { inferCognitiveType, type CognitiveType } from "../shared/cognitive-type";
import type { JsonObject } from "../shared/types";
import type {
  MemoryLifecycleIntent,
  MemoryPolicyAction,
  MemoryRecallPolicy,
  MemoryStorageTarget,
} from "./memory-policy-engine";
import {
  classifyAssistantMemorySignal,
  type AssistantMemoryKind,
  type EvidenceLevel,
  type SourceRole,
} from "./assistant-memory-policy";

export type AutonomousAction =
  | "approve_default"
  | "approve_explicit_issue"
  | "reject_closed"
  | "reject_sensitive"
  | "reject_test_noise"
  | "reject_unknown_source"
  | "event_log_only"
  | "keep_pending";

export interface PendingAutonomousClosureRow {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly title: string | null;
  readonly content: string;
  readonly memory_type: string | null;
  readonly metadata: JsonObject;
  readonly created_by: string | null;
}

export interface PendingAutonomousClosureItem {
  readonly id: string;
  readonly autonomous_action: AutonomousAction;
  readonly memory_class: ExtractedMemoryClass;
  readonly cognitive_type: CognitiveType;
  readonly storage_target: MemoryStorageTarget;
  readonly recall_policy: MemoryRecallPolicy;
  readonly lifecycle_intent: MemoryLifecycleIntent;
  readonly policy_action: MemoryPolicyAction;
  readonly source_role?: SourceRole;
  readonly assistant_memory_kind?: AssistantMemoryKind;
  readonly evidence_level?: EvidenceLevel;
  readonly reasons: readonly string[];
}

export interface AutonomousPendingClosurePlan {
  readonly groups: {
    readonly would_approve_default: PendingAutonomousClosureItem[];
    readonly would_approve_explicit_issue: PendingAutonomousClosureItem[];
    readonly would_reject_closed: PendingAutonomousClosureItem[];
    readonly would_reject_sensitive: PendingAutonomousClosureItem[];
    readonly would_reject_test_noise: PendingAutonomousClosureItem[];
    readonly would_reject_unknown_source: PendingAutonomousClosureItem[];
    readonly would_event_log_only: PendingAutonomousClosureItem[];
    readonly would_keep_pending: PendingAutonomousClosureItem[];
  };
  readonly summary: {
    readonly total: number;
    readonly would_approve_default: number;
    readonly would_approve_explicit_issue: number;
    readonly would_reject_closed: number;
    readonly would_reject_sensitive: number;
    readonly would_reject_test_noise: number;
    readonly would_reject_unknown_source: number;
    readonly would_event_log_only: number;
    readonly would_keep_pending: number;
  };
}

export interface AutonomousClosureEvidenceOptions {
  readonly runId: string;
  readonly appliedAt: string;
}

export interface AutonomousClosureGovernanceActionInput {
  readonly runId: string;
  readonly row: PendingAutonomousClosureRow;
  readonly item: PendingAutonomousClosureItem;
  readonly beforeState: JsonObject;
  readonly afterState: JsonObject;
}

export interface AutonomousClosureGovernanceAction {
  readonly actionType: "memory_auto_approval_sweep";
  readonly memoryId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly selector: JsonObject;
  readonly evidence: JsonObject;
  readonly beforeState: JsonObject;
  readonly afterState: JsonObject;
  readonly status: "applied";
  readonly createdBy: "memory-xx-auto-approval-sweep";
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function rowText(row: PendingAutonomousClosureRow): string {
  const metadataSource = typeof row.metadata.source === "string" ? row.metadata.source : "";
  const agentId = typeof row.metadata.agent_id === "string" ? row.metadata.agent_id : "";
  return [row.scope_type, row.scope_id, row.title ?? "", row.content, row.memory_type ?? "", metadataSource, agentId]
    .join("\n");
}

function source(row: PendingAutonomousClosureRow): string {
  return typeof row.metadata.source === "string" && row.metadata.source.trim() !== ""
    ? row.metadata.source.trim()
    : "unknown";
}

function memoryClassFromType(memoryType: string | null): ExtractedMemoryClass {
  if (memoryType === "preference") return "preference";
  if (memoryType === "constraint") return "constraint";
  if (memoryType === "decision") return "decision";
  if (memoryType === "procedure" || memoryType === "procedural") return "procedure";
  return "long_term_fact";
}

function makeItem(
  row: PendingAutonomousClosureRow,
  autonomousAction: AutonomousAction,
  fields: {
    readonly memoryClass: ExtractedMemoryClass;
    readonly storageTarget: MemoryStorageTarget;
    readonly recallPolicy: MemoryRecallPolicy;
    readonly lifecycleIntent: MemoryLifecycleIntent;
    readonly policyAction: MemoryPolicyAction;
    readonly sourceRole?: SourceRole;
    readonly assistantMemoryKind?: AssistantMemoryKind;
    readonly evidenceLevel?: EvidenceLevel;
    readonly reasons: readonly string[];
  },
): PendingAutonomousClosureItem {
  return {
    id: row.id,
    autonomous_action: autonomousAction,
    memory_class: fields.memoryClass,
    cognitive_type: inferCognitiveType({
      memory_type: row.memory_type,
      memory_layer: typeof row.metadata.memory_layer === "string" ? row.metadata.memory_layer : null,
      recall_policy: fields.recallPolicy,
      memory_class: fields.memoryClass,
      assistant_memory_kind: fields.assistantMemoryKind,
    }),
    storage_target: fields.storageTarget,
    recall_policy: fields.recallPolicy,
    lifecycle_intent: fields.lifecycleIntent,
    policy_action: fields.policyAction,
    ...(fields.sourceRole ? { source_role: fields.sourceRole } : {}),
    ...(fields.assistantMemoryKind ? { assistant_memory_kind: fields.assistantMemoryKind } : {}),
    ...(fields.evidenceLevel ? { evidence_level: fields.evidenceLevel } : {}),
    reasons: fields.reasons,
  };
}

function approveDefault(row: PendingAutonomousClosureRow, reason: string): PendingAutonomousClosureItem {
  return makeItem(row, "approve_default", {
    memoryClass: memoryClassFromType(row.memory_type),
    storageTarget: "postgres_memory",
    recallPolicy: "default",
    lifecycleIntent: "active",
    policyAction: "create_memory",
    reasons: [reason],
  });
}

function approveExplicitIssue(row: PendingAutonomousClosureRow, reason: string): PendingAutonomousClosureItem {
  return makeItem(row, "approve_explicit_issue", {
    memoryClass: "operational_issue",
    storageTarget: "postgres_memory",
    recallPolicy: "explicit_only",
    lifecycleIntent: "issue_open",
    policyAction: "create_memory",
    reasons: [reason, "operational_issue_isolated_from_default_recall"],
  });
}

function rejectUnknown(row: PendingAutonomousClosureRow): PendingAutonomousClosureItem {
  return makeItem(row, "reject_unknown_source", {
    memoryClass: "unknown_source_quarantine",
    storageTarget: "quarantine",
    recallPolicy: "never",
    lifecycleIntent: "rejected",
    policyAction: "reject_by_policy",
    reasons: ["unknown_source_never_auto_approved"],
  });
}

function rejectTestNoise(row: PendingAutonomousClosureRow, reason: string): PendingAutonomousClosureItem {
  return makeItem(row, "reject_test_noise", {
    memoryClass: "test_evidence",
    storageTarget: "event_log_only",
    recallPolicy: "never",
    lifecycleIntent: "rejected",
    policyAction: "reject_by_policy",
    reasons: [reason],
  });
}

function rejectClosed(row: PendingAutonomousClosureRow, reason: string): PendingAutonomousClosureItem {
  return makeItem(row, "reject_closed", {
    memoryClass: "audit_evidence",
    storageTarget: "event_log_only",
    recallPolicy: "never",
    lifecycleIntent: "rejected",
    policyAction: "reject_by_policy",
    reasons: [reason],
  });
}

function rejectSensitive(row: PendingAutonomousClosureRow, reason: string): PendingAutonomousClosureItem {
  return makeItem(row, "reject_sensitive", {
    memoryClass: "runtime_noise",
    storageTarget: "event_log_only",
    recallPolicy: "never",
    lifecycleIntent: "rejected",
    policyAction: "reject_by_policy",
    reasons: [reason],
  });
}

function eventLogOnly(
  row: PendingAutonomousClosureRow,
  fields: {
    readonly memoryClass?: ExtractedMemoryClass;
    readonly sourceRole?: SourceRole;
    readonly assistantMemoryKind?: AssistantMemoryKind;
    readonly evidenceLevel?: EvidenceLevel;
    readonly reasons: readonly string[];
  },
): PendingAutonomousClosureItem {
  return makeItem(row, "event_log_only", {
    memoryClass: fields.memoryClass ?? memoryClassFromType(row.memory_type),
    storageTarget: "event_log_only",
    recallPolicy: "never",
    lifecycleIntent: "rejected",
    policyAction: "reject_by_policy",
    sourceRole: fields.sourceRole,
    assistantMemoryKind: fields.assistantMemoryKind,
    evidenceLevel: fields.evidenceLevel,
    reasons: fields.reasons,
  });
}

function keepPending(row: PendingAutonomousClosureRow): PendingAutonomousClosureItem {
  return makeItem(row, "keep_pending", {
    memoryClass: memoryClassFromType(row.memory_type),
    storageTarget: "postgres_memory",
    recallPolicy: "explicit_only",
    lifecycleIntent: "active",
    policyAction: "create_candidate",
    reasons: ["autonomous_rule_not_confident"],
  });
}

function keepAssistantProposedPlan(row: PendingAutonomousClosureRow, signal: ReturnType<typeof classifyAssistantMemorySignal>): PendingAutonomousClosureItem {
  return eventLogOnly(row, {
    memoryClass: "decision",
    sourceRole: signal.source_role,
    assistantMemoryKind: signal.assistant_memory_kind,
    evidenceLevel: signal.evidence_level,
    reasons: [...signal.reasons, "document_artifact_routed_to_knowledge_base"],
  });
}

function rejectAssistantProcessNoise(row: PendingAutonomousClosureRow, signal: ReturnType<typeof classifyAssistantMemorySignal>): PendingAutonomousClosureItem {
  return makeItem(row, "reject_test_noise", {
    memoryClass: "runtime_noise",
    storageTarget: "event_log_only",
    recallPolicy: "never",
    lifecycleIntent: "rejected",
    policyAction: "reject_by_policy",
    sourceRole: signal.source_role,
    assistantMemoryKind: signal.assistant_memory_kind,
    evidenceLevel: signal.evidence_level,
    reasons: [...signal.reasons],
  });
}

function approveAssistantStatusSnapshot(row: PendingAutonomousClosureRow, signal: ReturnType<typeof classifyAssistantMemorySignal>): PendingAutonomousClosureItem {
  return makeItem(row, "approve_default", {
    memoryClass: memoryClassFromType(row.memory_type),
    storageTarget: "postgres_memory",
    recallPolicy: "default",
    lifecycleIntent: "active",
    policyAction: "create_memory",
    sourceRole: signal.source_role,
    assistantMemoryKind: signal.assistant_memory_kind,
    evidenceLevel: signal.evidence_level,
    reasons: [...signal.reasons],
  });
}

function isConfigDumpOrInternalPath(text: string): boolean {
  return /([A-Z]:\\|\\\\wsl\.localhost|\/mnt\/[a-z]\/|\/home\/[^/\s]+\/|\.codex|mcp_servers|model_provider\s*=|model_reasoning_effort\s*=|api[_-]?key|token\s*=|env dump|配置文件)/iu.test(text) &&
    /(model_provider\s*=|mcp_servers|配置文件|<windows-drive>\\codex-home|\.codex|api[_-]?key|token\s*=)/iu.test(text);
}

function isStableDefaultFact(text: string): string | null {
  if (/preferred model|uses model dreamfield\/DeepSeek-V4-Flash|用户.*模型.*dreamfield\/DeepSeek-V4-Flash/iu.test(text)) {
    return "stable_preferred_model";
  }
  if (/子agent模型|子agent.*dreamfield\/DeepSeek-V4-Flash|并发上限/iu.test(text)) {
    return "stable_project_constraint";
  }
  if (/WSL.*Windows|Windows.*WSL|codex运行环境|前端工具显示在Windows/iu.test(text)) {
    return "stable_runtime_environment_constraint";
  }
  if (/用户\d*要求使用中文回复|用户.*使用中文回复|中文回复/iu.test(text)) {
    return "stable_user_language_preference";
  }
  if (/通过MCP连接到WSL下的memory-xx|MCP连接WSL memory-xx|连接到WSL.*memory-xx/iu.test(text)) {
    return "stable_project_access_fact";
  }
  if (/微信小程序开发者工具控制台.*wx\.setStorageSync|应使用\s*wx\.setStorageSync\s*而非\s*uni\.setStorageSync/iu.test(text)) {
    return "stable_project_debug_fact";
  }
  if (/制定解决方案前.*锁定三个关键决策|run\/task.*MCP.*filter_mode/iu.test(text)) {
    return "stable_project_decision";
  }
  if (/MCP 协议测试全部通过|17\/17\s+PASS.*协议层处理正确/iu.test(text)) {
    return "stable_project_test_result";
  }
  if (/malformed JSON 状态码回归修复决策|invalid_json_body.*400.*body_read_timeout.*408.*body_too_large.*413/iu.test(text)) {
    return "stable_project_regression_fix_decision";
  }
  if (/malformed JSON 测试需覆盖|\/api\/memory\/v2\/skills\/execute.*\/api\/memory\/v2\/intelligence\/extract/iu.test(text)) {
    return "stable_project_test_procedure";
  }
  if (/active embedding manifest.*Postgres\/Qdrant.*不一致|embedding manifest 不一致修复步骤|memory:auto-repair.*memory:embedding-manifest/iu.test(text)) {
    return "stable_project_embedding_manifest_runbook";
  }
  if (/archived 记录不应出现在 Qdrant active collection|active Qdrant 只放可召回记录/iu.test(text)) {
    return "stable_project_qdrant_projection_policy";
  }
  if (/Plan Mode.*不能改文件.*执行 apply|当前处于 Plan Mode.*不能改文件/iu.test(text)) {
    return "stable_agent_mode_constraint";
  }
  if (/完成的计划文件和报告应写入向量知识库|计划文件和报告文件过多且杂乱|本地不再保存/iu.test(text)) {
    return "stable_user_knowledge_archive_preference";
  }
  if (/PG中开辟.*知识库.*用户知识库.*项目知识库|分为用户知识库和项目知识库/iu.test(text)) {
    return "stable_project_knowledge_layer_decision";
  }
  if (/pending apply 执行后.*pending 从\s*56\s*降至\s*30|candidate_only=true 保持.*Qdrant reconcile 正常/iu.test(text)) {
    return "stable_project_pending_sweep_audit_fact";
  }
  if (/控制面板告警来自.*embedding-manifest validate|manifest\/Qdrant 不一致的具体记录来源/iu.test(text)) {
    return "stable_project_diagnostic_fact";
  }
  return null;
}

function isOperationalIssue(text: string): boolean {
  return /(用户报告.*(无法|不能|失败|报错|重新安装|下载插件|skills)|模型连接失败|stream disconnected|配置空间|无法下载插件|无法下载.*skills|filter_mode=.*403|governance.*403|stdio.*stdin.*关闭|HTTP 传输.*正确测试方式)/iu.test(text);
}

function isConversationIngestProcessNoise(row: PendingAutonomousClosureRow, text: string): boolean {
  return /^real-user-[a-f0-9]+$/iu.test(row.scope_id) &&
    /conversation ingest 生成待审批候选|生成待审批候选，不会自动批准|候选生成.*审批流程/iu.test(text);
}

function isCanaryOrWorkerNoise(row: PendingAutonomousClosureRow, text: string): boolean {
  return /^memory-xx-auto-approval-e2e-/iu.test(row.scope_id) ||
    /^conversation-worker-/iu.test(row.scope_id) ||
    /auto approval canary marker|automatic approval canary|conversation worker .*JSONL spool|通过 worker 生成 pending candidate/iu.test(text);
}

function isGeneralTestNoise(text: string): boolean {
  const compact = normalizeText(text);
  return /^perf-\d+$/iu.test(compact) ||
    /(^|[\s\n])perf-\d+($|[\s\n])|MCP测试|审计测试|完整审计测试要求|功能测试|压测|canary marker|验收|e2e|Unified remember API test|Test \d+ - with metadata/iu.test(text);
}

function isTestScopeOrApiNoise(row: PendingAutonomousClosureRow, text: string): boolean {
  return /^test[-_:]/iu.test(row.scope_id) ||
    /^test-/iu.test(row.scope_id) ||
    /(^|[-_:])test[-_:]/iu.test(row.scope_id) ||
    source(row) === "api-test" ||
    (source(row) === "unified-api" && /test-agent|Unified remember API test|unified-test/iu.test(text)) ||
    (source(row) === "memory-xx-intelligence-smart-write" && /^test-project-/iu.test(row.scope_id));
}

function isInterSessionOrSubagentNoise(text: string): boolean {
  return /\[Inter-session message\]|sourceTool=subagent_announce|sourceSession=agent:main:subagent|isUser=false/iu.test(text);
}

function isRawConversationContextNoise(text: string): boolean {
  return /<environment_context>|<current_date>|<timezone>/iu.test(text) &&
    /(^|\n|\s)user:\s*.+(^|\n|\s)assistant:/isu.test(text);
}

function isConversationProcessTranscriptNoise(text: string): boolean {
  return (
    /message_id:.*用户\d*:\s*继续.*assistant:\s*(好|我先|我会|我正在)/isu.test(text) ||
    /user:\s*看一下有没有因为这些变更而又引起别的问题.*assistant:\s*我会.*(只做非破坏性检查|不会改文件|先从 diff|测试覆盖缺口)/isu.test(text) ||
    /assistant:\s*(好，)?我先全面了解.*当前状态/isu.test(text)
  );
}

function isDocumentArtifact(text: string): boolean {
  return /<proposed_plan>|# .{0,120}(计划|报告|Report|Plan)|## Summary|## Test Plan|## Acceptance Criteria|完整测试报告|测试报告|canary 报告/iu.test(text);
}

function isWeeklyPromotionDigest(row: PendingAutonomousClosureRow, text: string): boolean {
  return source(row) === "memory-xx-tools-plugin" &&
    /周度短时记忆晋升|短时记忆晋升记录|Memory Dreaming Promotion/iu.test(text);
}

function isSelfImprovementReportOnly(row: PendingAutonomousClosureRow, text: string): boolean {
  if (source(row) !== "memory:self-improvement") return false;
  const recurrence = row.metadata.recurrence_count;
  const reportOnly = row.metadata.report_only;
  return reportOnly === true ||
    /report-only:\s*true|recurrence-count:\s*1|recurrence_count["']?\s*[:=]\s*1/iu.test(text) ||
    (typeof recurrence === "number" && recurrence < 2);
}

function isOneTimeAuditGoal(text: string): boolean {
  return /最终目标：找出记忆框架目前存在的问题，将结果整理汇总为一份\.md文件|一次性审计目标/iu.test(text);
}

function classifyRow(row: PendingAutonomousClosureRow): PendingAutonomousClosureItem {
  const text = rowText(row);
  if (source(row) === "unknown") return rejectUnknown(row);
  if (isConfigDumpOrInternalPath(text)) return rejectSensitive(row, "config_dump_or_internal_path");

  const sourceRole = typeof row.metadata.source_role === "string" ? row.metadata.source_role : null;
  const evidenceRefs = Array.isArray(row.metadata.evidence_refs) ? row.metadata.evidence_refs : [];
  const assistant = classifyAssistantMemorySignal({ text, sourceRole, evidenceRefs });
  if (assistant.assistant_memory_kind === "process_noise") return rejectAssistantProcessNoise(row, assistant);
  if (assistant.assistant_memory_kind === "proposed_plan") return keepAssistantProposedPlan(row, assistant);
  if ((assistant.assistant_memory_kind === "status_snapshot" || assistant.assistant_memory_kind === "test_report") &&
      (assistant.evidence_level === "tool_observed" || assistant.evidence_level === "test_verified")) {
    return approveAssistantStatusSnapshot(row, assistant);
  }

  if (isInterSessionOrSubagentNoise(text)) return rejectTestNoise(row, "inter_session_or_subagent_announce_not_memory");
  if (isRawConversationContextNoise(text)) return rejectTestNoise(row, "raw_environment_context_transcript_not_memory");
  if (isConversationProcessTranscriptNoise(text)) return rejectTestNoise(row, "conversation_process_transcript_not_memory");

  const stableReason = isStableDefaultFact(text);
  if (stableReason) return approveDefault(row, stableReason);
  if (isOperationalIssue(text)) return approveExplicitIssue(row, "user_reported_operational_issue");

  if (isTestScopeOrApiNoise(row, text)) return rejectTestNoise(row, "test_scope_or_api_test_not_production_memory");
  if (isConversationIngestProcessNoise(row, text)) return rejectTestNoise(row, "conversation_ingest_process_test_sample");
  if (isCanaryOrWorkerNoise(row, text)) return rejectTestNoise(row, "auto_approval_or_worker_canary_sample");
  if (isWeeklyPromotionDigest(row, text)) return rejectClosed(row, "weekly_short_memory_promotion_digest_not_long_term_memory");
  if (isSelfImprovementReportOnly(row, text)) return rejectClosed(row, "self_improvement_report_only_recurrence_below_threshold");
  if (isOneTimeAuditGoal(text)) return rejectClosed(row, "one_time_audit_goal_not_long_term_memory");
  if (isGeneralTestNoise(text)) return rejectTestNoise(row, "test_or_audit_noise");
  if (isDocumentArtifact(text)) return eventLogOnly(row, {
    memoryClass: "audit_evidence",
    reasons: ["document_artifact_routed_to_knowledge_base"],
  });

  return keepPending(row);
}

export function planAutonomousPendingClosure(rows: readonly PendingAutonomousClosureRow[]): AutonomousPendingClosurePlan {
  const groups: AutonomousPendingClosurePlan["groups"] = {
    would_approve_default: [],
    would_approve_explicit_issue: [],
    would_reject_closed: [],
    would_reject_sensitive: [],
    would_reject_test_noise: [],
    would_reject_unknown_source: [],
    would_event_log_only: [],
    would_keep_pending: [],
  };

  for (const row of rows) {
    const item = classifyRow(row);
    if (item.autonomous_action === "approve_default") groups.would_approve_default.push(item);
    else if (item.autonomous_action === "approve_explicit_issue") groups.would_approve_explicit_issue.push(item);
    else if (item.autonomous_action === "reject_closed") groups.would_reject_closed.push(item);
    else if (item.autonomous_action === "reject_sensitive") groups.would_reject_sensitive.push(item);
    else if (item.autonomous_action === "reject_test_noise") groups.would_reject_test_noise.push(item);
    else if (item.autonomous_action === "reject_unknown_source") groups.would_reject_unknown_source.push(item);
    else if (item.autonomous_action === "event_log_only") groups.would_event_log_only.push(item);
    else groups.would_keep_pending.push(item);
  }

  return {
    groups,
    summary: {
      total: rows.length,
      would_approve_default: groups.would_approve_default.length,
      would_approve_explicit_issue: groups.would_approve_explicit_issue.length,
      would_reject_closed: groups.would_reject_closed.length,
      would_reject_sensitive: groups.would_reject_sensitive.length,
      would_reject_test_noise: groups.would_reject_test_noise.length,
      would_reject_unknown_source: groups.would_reject_unknown_source.length,
      would_event_log_only: groups.would_event_log_only.length,
      would_keep_pending: groups.would_keep_pending.length,
    },
  };
}

export function buildAutonomousClosureMetadata(
  metadata: JsonObject,
  item: PendingAutonomousClosureItem,
  options?: AutonomousClosureEvidenceOptions,
): JsonObject {
  const appliedAt = options?.appliedAt ?? new Date().toISOString();
  const runId = options?.runId ?? `auto-approval-sweep-${appliedAt}`;
  return {
    ...metadata,
    memory_class: item.memory_class,
    recall_policy: item.recall_policy,
    policy_action: item.policy_action,
    storage_target: item.storage_target,
    lifecycle_intent: item.lifecycle_intent,
    autonomous_action: item.autonomous_action,
    memory_policy: {
      ...(metadata.memory_policy && typeof metadata.memory_policy === "object" && !Array.isArray(metadata.memory_policy)
        ? metadata.memory_policy
        : {}),
      memory_class: item.memory_class,
      storage_target: item.storage_target,
      recall_policy: item.recall_policy,
      lifecycle_intent: item.lifecycle_intent,
      policy_action: item.policy_action,
      autonomous_action: item.autonomous_action,
      ...(item.source_role ? { source_role: item.source_role } : {}),
      ...(item.assistant_memory_kind ? { assistant_memory_kind: item.assistant_memory_kind } : {}),
      ...(item.evidence_level ? { evidence_level: item.evidence_level } : {}),
      reasons: [...item.reasons],
    },
    memory_auto_approval_sweep: {
      applied_at: appliedAt,
      run_id: runId,
      autonomous_action: item.autonomous_action,
      memory_class: item.memory_class,
      recall_policy: item.recall_policy,
      ...(item.source_role ? { source_role: item.source_role } : {}),
      ...(item.assistant_memory_kind ? { assistant_memory_kind: item.assistant_memory_kind } : {}),
      ...(item.evidence_level ? { evidence_level: item.evidence_level } : {}),
      reasons: [...item.reasons],
    },
  };
}

export function isAutonomousClosureAlreadyApplied(metadata: JsonObject, item: PendingAutonomousClosureItem): boolean {
  const sweep = metadata.memory_auto_approval_sweep;
  if (sweep && typeof sweep === "object" && !Array.isArray(sweep)) {
    const record = sweep as Record<string, unknown>;
    return record.autonomous_action === item.autonomous_action &&
      record.memory_class === item.memory_class &&
      record.recall_policy === item.recall_policy;
  }
  return metadata.autonomous_action === item.autonomous_action &&
    metadata.memory_class === item.memory_class &&
    metadata.recall_policy === item.recall_policy;
}

export function buildAutonomousClosureGovernanceAction(input: AutonomousClosureGovernanceActionInput): AutonomousClosureGovernanceAction {
  return {
    actionType: "memory_auto_approval_sweep",
    memoryId: input.row.id,
    scopeType: input.row.scope_type,
    scopeId: input.row.scope_id,
    selector: {
      source: source(input.row),
      agent_id: typeof input.row.metadata.agent_id === "string" ? input.row.metadata.agent_id : null,
      created_by: input.row.created_by,
      memory_type: input.row.memory_type,
    },
    evidence: {
      auto_approval_sweep_run_id: input.runId,
      autonomous_action: input.item.autonomous_action,
      memory_class: input.item.memory_class,
      storage_target: input.item.storage_target,
      recall_policy: input.item.recall_policy,
      lifecycle_intent: input.item.lifecycle_intent,
      policy_action: input.item.policy_action,
      reasons: [...input.item.reasons],
    },
    beforeState: input.beforeState,
    afterState: input.afterState,
    status: "applied",
    createdBy: "memory-xx-auto-approval-sweep",
  };
}
