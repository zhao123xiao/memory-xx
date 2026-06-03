export type SourceRole = "user" | "assistant" | "tool" | "mixed" | "unknown";
export type AssistantMemoryKind =
  | "process_noise"
  | "proposed_plan"
  | "status_snapshot"
  | "completion_summary"
  | "test_report"
  | "none";
export type EvidenceLevel = "none" | "assistant_claim" | "tool_observed" | "test_verified" | "user_confirmed";

export interface AssistantMemorySignalInput {
  readonly text: string;
  readonly sourceRole?: string | null;
  readonly evidenceRefs?: readonly unknown[] | null;
}

export interface AssistantMemorySignal {
  readonly source_role: SourceRole;
  readonly assistant_memory_kind: AssistantMemoryKind;
  readonly evidence_level: EvidenceLevel;
  readonly reasons: readonly string[];
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function normalizeSourceRole(value: string | null | undefined, text: string): SourceRole {
  const role = value?.trim().toLowerCase();
  if (role === "user" || role === "assistant" || role === "tool" || role === "mixed") return role;
  const normalized = normalizeText(text);
  const hasAssistant = /(^|\n)\s*assistant\s*:/iu.test(text) || /^assistant\s*:/iu.test(normalized);
  const hasUser = /(^|\n)\s*user\s*:/iu.test(text) || /^user\s*:/iu.test(normalized);
  if (hasAssistant && hasUser) return "mixed";
  if (hasAssistant) return "assistant";
  if (hasUser) return "user";
  return "unknown";
}

function hasEvidenceRef(input: AssistantMemorySignalInput): boolean {
  return Array.isArray(input.evidenceRefs) && input.evidenceRefs.some((item) => typeof item === "string" && item.trim().length > 0);
}

function evidenceLevel(text: string, input: AssistantMemorySignalInput): EvidenceLevel {
  if (hasEvidenceRef(input) || /(npm run|node --import|memory:|qdrant-reconcile|pending -- --json|status -- --json|typecheck|测试通过|验证通过|PASS|0 drift|drift 为 0)/iu.test(text)) {
    return /测试通过|PASS|npm test|typecheck|test:gates|test:quality/iu.test(text) ? "test_verified" : "tool_observed";
  }
  if (/用户确认|user confirmed|已确认/iu.test(text)) return "user_confirmed";
  return "assistant_claim";
}

export function classifyAssistantMemorySignal(input: AssistantMemorySignalInput): AssistantMemorySignal {
  const text = input.text;
  const normalized = normalizeText(text);
  const sourceRole = normalizeSourceRole(input.sourceRole, text);
  if (sourceRole !== "assistant" && sourceRole !== "mixed") {
    return { source_role: sourceRole, assistant_memory_kind: "none", evidence_level: "none", reasons: [] };
  }

  if (/(^|\n)\s*assistant\s*:\s*(我会|我先|我正在|我将|接下来我|先做|继续|好的|收到|let me|i will|i'll|checking|reading)/iu.test(text) &&
      !/(已验证|已完成|测试通过|Qdrant drift|runtime_ok|candidate_current|输出|PASS)/iu.test(text)) {
    return {
      source_role: sourceRole,
      assistant_memory_kind: "process_noise",
      evidence_level: "none",
      reasons: ["assistant_process_noise_not_project_state"],
    };
  }

  if (/<proposed_plan>/iu.test(text) || (/(^|\n)\s*# .{0,80}(计划|plan)/iu.test(text) && /(Summary|Key Changes|Test Plan|Acceptance Criteria|Assumptions|Implementation Checklist)/iu.test(text))) {
    return {
      source_role: sourceRole,
      assistant_memory_kind: "proposed_plan",
      evidence_level: "assistant_claim",
      reasons: ["assistant_proposed_plan_not_completed_fact"],
    };
  }

  const level = evidenceLevel(text, input);
  if (level === "tool_observed" || level === "test_verified" || /已验证|Qdrant drift|runtime_ok|candidate_current|pending=0|输出 .*为 0/iu.test(text)) {
    return {
      source_role: sourceRole,
      assistant_memory_kind: /测试报告|测试通过|PASS|npm test/iu.test(text) ? "test_report" : "status_snapshot",
      evidence_level: level,
      reasons: ["assistant_status_snapshot_with_evidence"],
    };
  }

  if (/已完成|修复完成|已经生成完毕|完成总结|summary complete|implementation complete/iu.test(normalized)) {
    return {
      source_role: sourceRole,
      assistant_memory_kind: "completion_summary",
      evidence_level: "assistant_claim",
      reasons: ["assistant_completion_summary_requires_lifecycle_tracking"],
    };
  }

  return {
    source_role: sourceRole,
    assistant_memory_kind: "none",
    evidence_level: sourceRole === "assistant" || sourceRole === "mixed" ? "assistant_claim" : "none",
    reasons: [],
  };
}
