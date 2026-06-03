import type { JsonObject } from "../shared/types";
import type { ExtractedMemoryClass } from "../intelligence/types";
import {
  classifyAssistantMemorySignal,
  type AssistantMemoryKind,
  type EvidenceLevel,
  type SourceRole,
} from "./assistant-memory-policy";

export type MemoryStorageTarget = "postgres_memory" | "redis_ttl" | "event_log_only" | "quarantine";
export type MemoryRecallPolicy = "default" | "explicit_only" | "audit_only" | "test_only" | "never";
export type MemoryLifecycleIntent = "active" | "proposed" | "issue_open" | "issue_resolved" | "temporary" | "rejected" | "quarantine";
export type MemoryPolicyAction =
  | "create_memory"
  | "create_candidate"
  | "quarantine_candidate"
  | "buffer"
  | "skip"
  | "reject_by_policy"
  | "ephemeral_only";

export interface MemoryPolicyCandidate {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly memoryType: string | null | undefined;
  readonly operation: string;
  readonly confidence: number;
  readonly qualityScore: number;
  readonly title?: string | null;
  readonly content: string;
  readonly metadata?: JsonObject | null;
  readonly memoryClass?: string | null;
}

export interface MemoryPolicyInput {
  readonly source: string;
  readonly sourceText?: string;
  readonly candidate: MemoryPolicyCandidate;
  readonly baseDecision: "approve" | "pending" | "reject" | "buffer";
  readonly blockedReasons: readonly string[];
}

export interface MemoryPolicyResult {
  readonly memory_class: ExtractedMemoryClass;
  readonly storage_target: MemoryStorageTarget;
  readonly recall_policy: MemoryRecallPolicy;
  readonly lifecycle_intent: MemoryLifecycleIntent;
  readonly policy_action: MemoryPolicyAction;
  readonly ttl_seconds?: number;
  readonly source_role?: SourceRole;
  readonly assistant_memory_kind?: AssistantMemoryKind;
  readonly evidence_level?: EvidenceLevel;
  readonly reasons: readonly string[];
}

const SAFE_SOURCES = new Set([
  "conversation_ingest",
  "smart_write",
  "memory-xx-intelligence-smart-write",
  "memory-xx-mcp-smart-write",
  "memory:self-improvement",
  "memory-xx-tools-plugin",
  "codex-jsonl-spool",
  "codex-session-tail",
  "claude-code-session-tail",
  "openclaw-session-tail",
]);

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function haystack(input: MemoryPolicyInput): string {
  return [
    input.sourceText ?? "",
    input.candidate.title ?? "",
    input.candidate.content,
    typeof input.candidate.metadata?.source === "string" ? input.candidate.metadata.source : "",
    typeof input.candidate.metadata?.source_intent === "string" ? input.candidate.metadata.source_intent : "",
  ].join("\n");
}

function sourceLooksUnknown(input: MemoryPolicyInput): boolean {
  const metadataSource = typeof input.candidate.metadata?.source === "string" ? input.candidate.metadata.source : "";
  return input.source === "unknown" || metadataSource === "unknown" || !SAFE_SOURCES.has(input.source);
}

function sourceValue(input: MemoryPolicyInput): string {
  const metadataSource = typeof input.candidate.metadata?.source === "string" ? input.candidate.metadata.source : "";
  return metadataSource || input.source;
}

function explicitMemoryClass(input: MemoryPolicyInput): ExtractedMemoryClass | null {
  const value = input.candidate.memoryClass ?? input.candidate.metadata?.memory_class;
  return typeof value === "string" && isMemoryClass(value) ? value : null;
}

function isMemoryClass(value: string): value is ExtractedMemoryClass {
  return [
    "long_term_fact",
    "preference",
    "constraint",
    "decision",
    "procedure",
    "operational_issue",
    "test_evidence",
    "audit_evidence",
    "runtime_noise",
    "ephemeral_task",
    "explicit_no_memory",
    "unknown_source_quarantine",
  ].includes(value);
}

function hasExplicitNoMemory(text: string): boolean {
  return /(不需要|不要|别|无需|禁止).{0,12}(记住|記住|记忆|記憶|写入长期记忆|長期記憶|长期保存|保存)|do not remember|don't remember|dont remember|no need to remember|temporary only|临时.{0,12}(不要|不需要|无需).{0,12}(记住|记忆|保存|写入)/iu.test(text);
}

function isRuntimeNoise(text: string): boolean {
  const compact = normalizeText(text).toLowerCase();
  if (/^(user:\s*)?(继续|收到|好的|好|ok|okay|嗯|是|继续吧)$/iu.test(compact)) return true;
  if (/(^|\n)\s*(user:\s*)?继续(?:\s+llm-[a-z0-9-]+)?\s*($|\n)/iu.test(text)) return true;
  return /(监听标记|hook\s*验收标识|自动抽取验收标识|对话监听标记|conversation listener marker)/iu.test(text);
}

function isWeeklyPromotionDigest(input: MemoryPolicyInput, text: string): boolean {
  return sourceValue(input) === "memory-xx-tools-plugin" &&
    /周度短时记忆晋升|短时记忆晋升记录|Memory Dreaming Promotion/iu.test(text);
}

function isImplementationPlanPrompt(text: string): boolean {
  return /PLEASE IMPLEMENT THIS PLAN:/iu.test(text) ||
    /<proposed_plan>/iu.test(text) ||
    (/(^|\n)\s*# .{0,80}(计划|plan)/iu.test(text) &&
      /(Summary|Key Changes|Test Plan|Acceptance Criteria|Assumptions|Implementation Tasks|验收口径|当前可用性判断)/iu.test(text));
}

function isEphemeralTask(text: string): boolean {
  return /(分钟后|小时后|明天|今晚|稍后|临时提醒|remind me|in \d+\s*(minutes?|hours?))/iu.test(text) &&
    !/(请记住|记住|长期|以后|必须|应该|决定)/iu.test(text);
}

function isOperationalIssue(text: string): boolean {
  return /(真实性问题|真实.*问题|缺陷|bug|故障|失败|报错|断裂|漂移|污染|停滞|修复|已解决|未解决|regression|failure|failed|error|drift|pollution|stalled|resolved|fixed)/iu.test(text);
}

function isTestEvidence(text: string): boolean {
  const compact = normalizeText(text);
  if (/^perf-\d+$/iu.test(compact)) return true;
  if (/(^|[\s\n])perf-\d+($|[\s\n])/iu.test(text)) return true;
  return /(benchmark|smoke|压测|测试|驗證|验证|验收|acceptance|fixture|mock|样本|sample|test evidence)/iu.test(text);
}

function isAuditEvidence(text: string): boolean {
  return /(审计|審計|audit).{0,16}(证据|證據|样本|材料|报告|報告|复核|覆核|结果|結果|evidence|report|trace)|(复核|覆核).{0,16}(证据|材料|报告|结果)|review evidence|gate report|quality report/iu.test(text);
}

function classFromMemoryType(memoryType: string | null | undefined): ExtractedMemoryClass {
  if (memoryType === "preference") return "preference";
  if (memoryType === "constraint") return "constraint";
  if (memoryType === "decision") return "decision";
  if (memoryType === "procedure" || memoryType === "procedural") return "procedure";
  return "long_term_fact";
}

function metadataString(input: MemoryPolicyInput, key: string): string | null {
  const value = input.candidate.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function metadataArray(input: MemoryPolicyInput, key: string): readonly unknown[] {
  const value = input.candidate.metadata?.[key];
  return Array.isArray(value) ? value : [];
}

function classifyMemory(input: MemoryPolicyInput): {
  memoryClass: ExtractedMemoryClass;
  reasons: string[];
  assistant?: {
    source_role: SourceRole;
    assistant_memory_kind: AssistantMemoryKind;
    evidence_level: EvidenceLevel;
  };
} {
  const explicit = explicitMemoryClass(input);
  const text = haystack(input);
  const operationalIssue = isOperationalIssue(text);
  const assistant = classifyAssistantMemorySignal({
    text,
    sourceRole: metadataString(input, "source_role"),
    evidenceRefs: metadataArray(input, "evidence_refs"),
  });
  if (hasExplicitNoMemory(text) && !operationalIssue) return { memoryClass: "explicit_no_memory", reasons: ["explicit_no_memory_signal"] };
  if (isRuntimeNoise(text)) return { memoryClass: "runtime_noise", reasons: ["runtime_noise_signal"] };
  if (sourceLooksUnknown(input)) return { memoryClass: "unknown_source_quarantine", reasons: ["unknown_or_untrusted_source"] };
  if (isWeeklyPromotionDigest(input, text)) return { memoryClass: "runtime_noise", reasons: ["weekly_short_memory_promotion_digest_not_long_term_memory"] };
  if (assistant.assistant_memory_kind === "process_noise") {
    return {
      memoryClass: "runtime_noise",
      reasons: [...assistant.reasons],
      assistant,
    };
  }
  if (assistant.assistant_memory_kind === "proposed_plan") {
    return {
      memoryClass: "decision",
      reasons: [...assistant.reasons],
      assistant,
    };
  }
  if (assistant.assistant_memory_kind === "status_snapshot" || assistant.assistant_memory_kind === "completion_summary" || assistant.assistant_memory_kind === "test_report") {
    return {
      memoryClass: classFromMemoryType(input.candidate.memoryType),
      reasons: [...assistant.reasons],
      assistant,
    };
  }
  if (isImplementationPlanPrompt(text)) return { memoryClass: "runtime_noise", reasons: ["implementation_plan_prompt_not_long_term_memory"] };
  if (explicit) return { memoryClass: explicit, reasons: ["extractor_memory_class"] };
  if (isEphemeralTask(text)) return { memoryClass: "ephemeral_task", reasons: ["ephemeral_task_signal"] };
  if (operationalIssue) return { memoryClass: "operational_issue", reasons: ["operational_issue_signal"] };
  if (isTestEvidence(text)) return { memoryClass: "test_evidence", reasons: ["test_evidence_signal"] };
  if (isAuditEvidence(text)) return { memoryClass: "audit_evidence", reasons: ["audit_evidence_signal"] };
  return { memoryClass: classFromMemoryType(input.candidate.memoryType), reasons: ["memory_type_classification"] };
}

export function evaluateMemoryPolicy(input: MemoryPolicyInput): MemoryPolicyResult {
  const classified = classifyMemory(input);
  const memoryClass = classified.memoryClass;
  const assistantFields = classified.assistant ? {
    source_role: classified.assistant.source_role,
    assistant_memory_kind: classified.assistant.assistant_memory_kind,
    evidence_level: classified.assistant.evidence_level,
  } : {};
  if (classified.assistant?.assistant_memory_kind === "proposed_plan") {
    return {
      memory_class: memoryClass,
      storage_target: "postgres_memory",
      recall_policy: "explicit_only",
      lifecycle_intent: "proposed",
      policy_action: input.baseDecision === "buffer" ? "buffer" : "create_candidate",
      ...assistantFields,
      reasons: classified.reasons,
    };
  }
  if (memoryClass === "explicit_no_memory") {
    return {
      memory_class: memoryClass,
      storage_target: "event_log_only",
      recall_policy: "never",
      lifecycle_intent: "rejected",
      policy_action: "reject_by_policy",
      ...assistantFields,
      reasons: classified.reasons,
    };
  }
  if (memoryClass === "runtime_noise") {
    return {
      memory_class: memoryClass,
      storage_target: "event_log_only",
      recall_policy: "never",
      lifecycle_intent: "rejected",
      policy_action: "reject_by_policy",
      ...assistantFields,
      reasons: classified.reasons,
    };
  }
  if (memoryClass === "ephemeral_task") {
    return {
      memory_class: memoryClass,
      storage_target: "redis_ttl",
      recall_policy: "never",
      lifecycle_intent: "temporary",
      policy_action: "ephemeral_only",
      ttl_seconds: 1800,
      ...assistantFields,
      reasons: classified.reasons,
    };
  }
  if (memoryClass === "unknown_source_quarantine") {
    return {
      memory_class: memoryClass,
      storage_target: "quarantine",
      recall_policy: "never",
      lifecycle_intent: "quarantine",
      policy_action: "quarantine_candidate",
      ...assistantFields,
      reasons: classified.reasons,
    };
  }
  if (memoryClass === "test_evidence") {
    return {
      memory_class: memoryClass,
      storage_target: "postgres_memory",
      recall_policy: "test_only",
      lifecycle_intent: "active",
      policy_action: input.baseDecision === "buffer" ? "buffer" : "create_candidate",
      ...assistantFields,
      reasons: [...classified.reasons, "test_evidence_requires_scoped_review"],
    };
  }
  if (memoryClass === "audit_evidence") {
    return {
      memory_class: memoryClass,
      storage_target: "postgres_memory",
      recall_policy: "audit_only",
      lifecycle_intent: "active",
      policy_action: input.baseDecision === "buffer" ? "buffer" : "create_candidate",
      ...assistantFields,
      reasons: [...classified.reasons, "audit_evidence_not_default_recall"],
    };
  }
  if (memoryClass === "operational_issue") {
    return {
      memory_class: memoryClass,
      storage_target: "postgres_memory",
      recall_policy: "explicit_only",
      lifecycle_intent: /已解决|resolved|fixed/iu.test(haystack(input)) ? "issue_resolved" : "issue_open",
      policy_action: input.baseDecision === "approve" ? "create_memory" : "create_candidate",
      ...assistantFields,
      reasons: [...classified.reasons, "operational_issue_not_default_recall"],
    };
  }
  return {
    memory_class: memoryClass,
    storage_target: "postgres_memory",
    recall_policy: "default",
    lifecycle_intent: "active",
    policy_action: input.baseDecision === "approve" ? "create_memory" : input.baseDecision === "buffer" ? "buffer" : "create_candidate",
    ...assistantFields,
    reasons: classified.reasons,
  };
}
