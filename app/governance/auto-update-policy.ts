import type { JsonObject } from "../shared/types";
import {
  isRuntimeAutoUpdateApplyScopeEnabled,
  isTestAutoUpdateApplyScope,
  readAutoApprovalRuntimeControlsSync,
  readAutoApprovalRuntimeControlsStateSync,
} from "./auto-approval-runtime-controls";
import {
  hasExplicitGlobalMemoryIntent,
  hasExplicitGlobalMemoryIntentFromMetadata,
} from "./global-memory-intent";
import { scanMemoryPrivacy } from "./privacy-scan";

export type AutoUpdateDecision = "supersede_dry_run" | "merge_dry_run" | "archive_expired_dry_run" | "refresh_dry_run" | "pending";
export type AutoUpdateType =
  | "explicit_replacement"
  | "temporal_expiry"
  | "same_fact_refresh"
  | "preference_change"
  | "merge_candidate"
  | "conflict_unclear";

export interface AutoUpdateCandidateInput {
  readonly candidateId?: string | null;
  readonly existingMemoryId?: string | null;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly memoryType: string | null;
  readonly operation: string;
  readonly conflictAction?: string | null;
  readonly conflictReason?: string | null;
  readonly content: string;
  readonly existingContent?: string | null;
  readonly confidence: number;
  readonly qualityScore: number;
  readonly agentId: string;
  readonly source: string;
  readonly metadata?: JsonObject | null;
  readonly recentAppliedCount?: number;
}

export interface AutoUpdatePolicyResult {
  readonly decision: AutoUpdateDecision;
  readonly dry_run: true;
  readonly apply_allowed: boolean;
  readonly apply_blocked_reason: string | null;
  readonly old_memory_id: string | null;
  readonly candidate_id: string | null;
  readonly detected_update_type: AutoUpdateType;
  readonly replacement_confidence: number;
  readonly explicit_update_signal: boolean;
  readonly old_content: string | null;
  readonly new_content: string;
  readonly diff_summary: string;
  readonly why_safe_or_unsafe: string;
  readonly reasons: readonly string[];
  readonly blocked_reasons: readonly string[];
  readonly action_plan: JsonObject;
  readonly rollback_plan: JsonObject;
  readonly risk: "low" | "medium" | "high";
}

const BASE_APPLY_ALLOWED_TYPES = new Set<AutoUpdateType>(["explicit_replacement", "temporal_expiry", "same_fact_refresh"]);

function hasExplicitReplacement(text: string): boolean {
  return /(?:改成|替换为|现在改为|以后用|不再.*而是|instead of|replace(?:d)? by|changed? to|supersede)/iu.test(text);
}

function expired(metadata: JsonObject | null | undefined): boolean {
  const raw = metadata?.expires_at ?? metadata?.expiresAt;
  return typeof raw === "string" && Date.parse(raw) <= Date.now();
}

function sameFactRefresh(input: AutoUpdateCandidateInput): boolean {
  const value = `${input.conflictReason ?? ""}\n${input.content}`.toLowerCase();
  return /(?:refresh|same fact|confirmed|still true|仍然有效|重新确认|事实刷新)/iu.test(value);
}

function diffSummary(input: AutoUpdateCandidateInput): string {
  const oldText = (input.existingContent ?? "").trim();
  const newText = input.content.trim();
  if (!oldText) return `new=${newText.slice(0, 160)}`;
  if (oldText === newText) return "old and new content are identical";
  return `old=${oldText.slice(0, 120)} -> new=${newText.slice(0, 120)}`;
}

export function isAutoUpdateApplyScopeEnabled(scopeType: string, scopeId: string): boolean {
  return isRuntimeAutoUpdateApplyScopeEnabled(scopeType, scopeId);
}

function updateTypeApplyEnabled(type: AutoUpdateType): boolean {
  const controls = readAutoApprovalRuntimeControlsSync();
  if (type === "explicit_replacement") return controls.update_apply.explicit_replacement;
  if (type === "same_fact_refresh") return controls.update_apply.same_fact_refresh;
  if (type === "temporal_expiry") return controls.update_apply.temporal_expiry;
  if (type === "merge_candidate") return controls.update_apply.merge_apply;
  if (type === "preference_change") return controls.update_apply.preference_change_apply;
  return false;
}

function updateTypeCanApply(input: AutoUpdateCandidateInput, type: AutoUpdateType): boolean {
  if (BASE_APPLY_ALLOWED_TYPES.has(type)) return updateTypeApplyEnabled(type);
  if (type === "preference_change") {
    return input.scopeType === "user" &&
      (input.scopeId === "current-user" || input.scopeId === "current-instance-owner") &&
      input.memoryType === "preference" &&
      updateTypeApplyEnabled(type);
  }
  return false;
}

function replacementConfidence(input: AutoUpdateCandidateInput, explicit: boolean, type: AutoUpdateType): number {
  const base = Math.min(input.qualityScore, input.confidence);
  const boost = explicit ? 0.03 : type === "same_fact_refresh" ? 0.01 : 0;
  return Math.max(0, Math.min(1, Math.round((base + boost) * 1000) / 1000));
}

function applyGate(input: AutoUpdateCandidateInput, type: AutoUpdateType, blocked: readonly string[]): { allowed: boolean; reason: string | null; why: string } {
  const controlsState = readAutoApprovalRuntimeControlsStateSync();
  if (!controlsState.ok) {
    return {
      allowed: false,
      reason: "runtime_controls_invalid",
      why: `auto-approval runtime controls are invalid: ${controlsState.error ?? "unknown error"}`,
    };
  }
  const hourlyLimit = Math.max(1, controlsState.controls.update_apply.max_hourly_per_scope || 1);
  if ((input.recentAppliedCount ?? 0) >= hourlyLimit) {
    return {
      allowed: false,
      reason: "hourly_scope_apply_limit_exceeded",
      why: `scope ${input.scopeType}:${input.scopeId} reached auto-update apply hourly limit recent=${input.recentAppliedCount ?? 0} limit=${hourlyLimit}`,
    };
  }
  const scopeApplyEnabled = isAutoUpdateApplyScopeEnabled(input.scopeType, input.scopeId);
  if (!scopeApplyEnabled) {
    const isRealProjectTrialCandidate = input.scopeType === "project" && input.scopeId === "memory-xx";
    const isRealUserTrialCandidate = input.scopeType === "user" && (input.scopeId === "current-user" || input.scopeId === "current-instance-owner");
    const isGlobalKeywordCandidate = input.scopeType === "global" && input.scopeId === "global";
    return {
      allowed: false,
      reason: "auto_update_apply_real_scope_disabled",
      why: isTestAutoUpdateApplyScope(input.scopeType, input.scopeId)
        ? "test-scope update apply is disabled by runtime control"
        : isRealProjectTrialCandidate
          ? "real project update apply is disabled by runtime control"
          : isRealUserTrialCandidate
            ? "real user update apply is disabled by runtime control"
            : isGlobalKeywordCandidate
              ? "global update apply is disabled by runtime control and still requires explicit global memory intent"
              : "real-scope update apply is hard blocked outside guarded project/user/global trials",
    };
  }
  if (!updateTypeCanApply(input, type)) {
    return {
      allowed: false,
      reason: "auto_update_type_apply_disabled",
      why: `${type} is not enabled by the update-apply runtime controls`,
    };
  }
  if (blocked.length > 0) {
    return {
      allowed: false,
      reason: blocked[0] ?? "auto_update_policy_blocked",
      why: `blocked by ${blocked.join(",")}`,
    };
  }
  return {
    allowed: true,
    reason: null,
    why: isTestAutoUpdateApplyScope(input.scopeType, input.scopeId)
      ? "isolated test scope, allowed update type, quality gates, and privacy gates passed"
      : input.scopeType === "user"
        ? `guarded user:${input.scopeId} update apply, allowed update type, quality gates, and privacy gates passed`
        : input.scopeType === "global"
          ? "guarded global keyword-intent update apply, allowed update type, quality gates, and privacy gates passed"
          : "guarded project:memory-xx update apply, allowed update type, quality gates, and privacy gates passed",
  };
}

function result(input: AutoUpdateCandidateInput, params: {
  readonly decision: AutoUpdateDecision;
  readonly type: AutoUpdateType;
  readonly explicit: boolean;
  readonly reasons: readonly string[];
  readonly blocked: readonly string[];
  readonly actionPlan: JsonObject;
  readonly rollbackPlan: JsonObject;
  readonly risk: "low" | "medium" | "high";
}): AutoUpdatePolicyResult {
  const gate = applyGate(input, params.type, params.blocked);
  return {
    decision: params.decision,
    dry_run: true,
    apply_allowed: gate.allowed,
    apply_blocked_reason: gate.reason,
    old_memory_id: input.existingMemoryId ?? null,
    candidate_id: input.candidateId ?? null,
    detected_update_type: params.type,
    replacement_confidence: replacementConfidence(input, params.explicit, params.type),
    explicit_update_signal: params.explicit,
    old_content: input.existingContent ?? null,
    new_content: input.content,
    diff_summary: diffSummary(input),
    why_safe_or_unsafe: gate.why,
    reasons: params.reasons,
    blocked_reasons: params.blocked,
    action_plan: {
      ...params.actionPlan,
      old_memory_id: input.existingMemoryId ?? null,
      candidate_id: input.candidateId ?? null,
      detected_update_type: params.type,
      apply_allowed: gate.allowed,
      apply_blocked_reason: gate.reason,
      qdrant_projection: {
        old_memory_id: input.existingMemoryId ?? null,
        new_memory_id: input.candidateId ?? null,
        expected_effect: gate.allowed ? "old_point_removed_or_tombstoned_new_point_upserted" : "no_projection_change",
      },
      cache_invalidation: {
        required: gate.allowed,
        scope_type: input.scopeType,
        scope_id: input.scopeId,
      },
    },
    rollback_plan: {
      ...params.rollbackPlan,
      old_memory_id: input.existingMemoryId ?? null,
      new_memory_id: input.candidateId ?? null,
      verify_pg: true,
      verify_qdrant: true,
      verify_cache: true,
      verify_unified_recall: true,
      verify_mcp_recall: true,
    },
    risk: params.risk,
  };
}

export function evaluateAutoUpdatePolicy(input: AutoUpdateCandidateInput): AutoUpdatePolicyResult {
  const reasons: string[] = [];
  const blocked: string[] = [];
  const privacy = scanMemoryPrivacy([input.content, input.existingContent ?? ""].join("\n"));
  const conflictAction = input.conflictAction ?? input.operation;
  const explicit = conflictAction === "supersede" || conflictAction === "update" || hasExplicitReplacement(input.content);
  const highQuality = input.qualityScore >= 0.94 && input.confidence >= 0.96;
  const controls = readAutoApprovalRuntimeControlsSync();
  const hourlyLimit = Math.max(1, controls.update_apply.max_hourly_per_scope || 1);

  if (privacy.blocked) blocked.push("sensitive_content_detected");
  if (privacy.findings.some((finding) => finding.kind === "pii")) blocked.push("pii_requires_human_review");
  if (!highQuality) blocked.push("quality_or_confidence_below_update_threshold");
  if ((input.recentAppliedCount ?? 0) >= hourlyLimit) blocked.push("hourly_scope_apply_limit_exceeded");
  if (!input.existingMemoryId && !expired(input.metadata)) blocked.push("existing_memory_required");
  if (input.scopeType === "global" && !hasExplicitGlobalMemoryIntent(input.content, input.existingContent) && !hasExplicitGlobalMemoryIntentFromMetadata(input.metadata)) {
    blocked.push("global_explicit_intent_required");
  }

  if (expired(input.metadata)) {
    reasons.push("expired_fact_candidate");
    return result(input, {
      decision: blocked.length === 0 || blocked.every((reason) => reason === "existing_memory_required")
        ? "archive_expired_dry_run"
        : "pending",
      type: "temporal_expiry",
      explicit: false,
      reasons,
      blocked: blocked.filter((reason) => reason !== "existing_memory_required"),
      actionPlan: {
        action: "archive_or_tombstone_expired",
        candidate_id: input.candidateId ?? null,
        existing_memory_id: input.existingMemoryId ?? null,
        writes_memory_event: true,
        invalidates_cache: true,
      },
      rollbackPlan: { action: "restore_previous_lifecycle", requires_memory_event: true },
      risk: "medium",
    });
  }

  if (explicit) {
    reasons.push("explicit_replacement_or_update");
    return result(input, {
      decision: blocked.length === 0 ? "supersede_dry_run" : "pending",
      type: input.memoryType === "preference" ? "preference_change" : "explicit_replacement",
      explicit: true,
      reasons,
      blocked,
      actionPlan: {
        action: "supersede_existing",
        candidate_id: input.candidateId ?? null,
        existing_memory_id: input.existingMemoryId ?? null,
        new_content: input.content,
        writes_memory_event: true,
        invalidates_cache: true,
      },
      rollbackPlan: { action: "restore_superseded_memory_and_tombstone_new", requires_cache_invalidation: true },
      risk: blocked.length === 0 ? "medium" : "high",
    });
  }

  if (conflictAction === "merge") {
    reasons.push("semantic_merge_candidate");
    return result(input, {
      decision: blocked.length === 0 ? "merge_dry_run" : "pending",
      type: "merge_candidate",
      explicit: false,
      reasons,
      blocked,
      actionPlan: {
        action: "merge_suggestion",
        candidate_id: input.candidateId ?? null,
        existing_memory_id: input.existingMemoryId ?? null,
        merge_mode: "human_review_required",
      },
      rollbackPlan: { action: "no_write_in_dry_run" },
      risk: "medium",
    });
  }

  if (sameFactRefresh(input)) {
    reasons.push("same_fact_refresh");
    return result(input, {
      decision: blocked.length === 0 ? "refresh_dry_run" : "pending",
      type: "same_fact_refresh",
      explicit: false,
      reasons,
      blocked,
      actionPlan: {
        action: "refresh_existing_fact",
        candidate_id: input.candidateId ?? null,
        existing_memory_id: input.existingMemoryId ?? null,
        writes_memory_event: true,
        invalidates_cache: true,
      },
      rollbackPlan: { action: "restore_previous_content_and_tombstone_refresh", requires_cache_invalidation: true },
      risk: blocked.length === 0 ? "low" : "high",
    });
  }

  blocked.push("no_update_conflict_or_expiry_signal");
  return result(input, {
    decision: "pending",
    type: "conflict_unclear",
    explicit: false,
    reasons,
    blocked,
    actionPlan: {
      action: "keep_pending",
      candidate_id: input.candidateId ?? null,
      existing_memory_id: input.existingMemoryId ?? null,
    },
    rollbackPlan: { action: "none_dry_run" },
    risk: "low",
  });
}
