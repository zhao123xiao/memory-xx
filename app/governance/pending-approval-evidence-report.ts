import { inferCognitiveType, type CognitiveType } from "../shared/cognitive-type";
import type { JsonObject } from "../shared/types";
import { scanMemoryPrivacy } from "./privacy-scan";
import {
  planAutonomousPendingClosure,
  type AutonomousAction,
  type PendingAutonomousClosureItem,
  type PendingAutonomousClosureRow,
} from "./memory-auto-approval-sweep";

export type PendingApprovalRecommendedLane =
  | "approve_candidate"
  | "explicit_issue_candidate"
  | "event_log_only"
  | "quarantine_or_reject"
  | "keep_pending";

export type PendingApprovalEvidenceSignal =
  | "stable_operational_fact"
  | "topic_drift"
  | "progress_snapshot"
  | "unknown_source"
  | "sensitive_or_private"
  | "test_or_canary_noise"
  | "document_artifact"
  | "assistant_process_noise"
  | "external_domain_fact"
  | "operational_issue"
  | "low_confidence";

export interface PendingApprovalEvidenceRow extends PendingAutonomousClosureRow {}

export interface PendingApprovalEvidenceItem {
  readonly id: string;
  readonly scope: string;
  readonly title: string | null;
  readonly content_preview: string;
  readonly source: string;
  readonly created_by: string | null;
  readonly autonomous_action: AutonomousAction;
  readonly recommended_lane: PendingApprovalRecommendedLane;
  readonly memory_class: string;
  readonly cognitive_type: CognitiveType;
  readonly signals: readonly PendingApprovalEvidenceSignal[];
  readonly reasons: readonly string[];
  readonly evidence_summary: string;
  readonly recall_contract: {
    readonly storage_target: string;
    readonly target_recall_policy: string;
    readonly default_recall_allowed: boolean;
  };
  readonly governance: {
    readonly apply_allowed: false;
    readonly report_only: true;
    readonly required_before_apply: readonly string[];
  };
  readonly privacy: {
    readonly blocked: boolean;
    readonly reasons: readonly string[];
  };
}

export interface PendingApprovalEvidenceReport {
  readonly ok: true;
  readonly generated_at: string;
  readonly report_only: true;
  readonly summary: {
    readonly total_rows: number;
    readonly total_evidence_items: number;
    readonly actionable_without_human_review: number;
    readonly requires_human_review: number;
    readonly by_recommended_lane: Record<PendingApprovalRecommendedLane, number>;
    readonly by_signal: Partial<Record<PendingApprovalEvidenceSignal, number>>;
  };
  readonly evidence: readonly PendingApprovalEvidenceItem[];
}

export type PendingSafeCloseOperation = "event_log_only" | "reject_or_quarantine";

export interface PendingSafeCloseCandidate {
  readonly id: string;
  readonly operation: PendingSafeCloseOperation;
  readonly autonomous_action: AutonomousAction;
  readonly memory_class: string;
  readonly cognitive_type: CognitiveType;
  readonly target_recall_policy: string;
  readonly storage_target: string;
  readonly default_recall_allowed: boolean;
  readonly reasons: readonly string[];
  readonly signals: readonly PendingApprovalEvidenceSignal[];
  readonly apply_allowed: false;
  readonly rollback_plan: {
    readonly action: "restore_candidate_state";
    readonly restore_lifecycle_status: "candidate";
    readonly restore_review_state: "pending";
  };
}

export interface PendingSafeCloseExcludedCandidate {
  readonly id: string;
  readonly recommended_lane: PendingApprovalRecommendedLane;
  readonly reasons: readonly string[];
  readonly required_before_apply: readonly string[];
}

export interface PendingSafeClosePlan {
  readonly ok: true;
  readonly run_id: string;
  readonly generated_at: string;
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly blockers: readonly string[];
  readonly summary: {
    readonly total_evidence_items: number;
    readonly safe_close_candidates: number;
    readonly excluded_for_human_review: number;
    readonly by_operation: Record<PendingSafeCloseOperation, number>;
  };
  readonly safe_close_candidates: readonly PendingSafeCloseCandidate[];
  readonly excluded_for_human_review: readonly PendingSafeCloseExcludedCandidate[];
}

export interface BuildPendingApprovalEvidenceReportInput {
  readonly rows: readonly PendingApprovalEvidenceRow[];
  readonly generatedAt?: string;
  readonly sampleLimit?: number;
}

export interface BuildPendingSafeClosePlanInput {
  readonly report: PendingApprovalEvidenceReport;
  readonly runId: string;
  readonly generatedAt?: string;
}

function textOf(row: PendingApprovalEvidenceRow): string {
  const source = typeof row.metadata.source === "string" ? row.metadata.source : "";
  const agentId = typeof row.metadata.agent_id === "string" ? row.metadata.agent_id : "";
  return [row.scope_type, row.scope_id, row.title ?? "", row.content, row.memory_type ?? "", source, agentId]
    .join("\n");
}

function source(row: PendingApprovalEvidenceRow): string {
  return typeof row.metadata.source === "string" && row.metadata.source.trim()
    ? row.metadata.source.trim()
    : "unknown";
}

function laneFor(item: PendingAutonomousClosureItem): PendingApprovalRecommendedLane {
  if (item.autonomous_action === "approve_default") return "approve_candidate";
  if (item.autonomous_action === "approve_explicit_issue") return "explicit_issue_candidate";
  if (item.autonomous_action === "event_log_only") return "event_log_only";
  if (item.autonomous_action === "keep_pending") return "keep_pending";
  return "quarantine_or_reject";
}

function hasPattern(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function preview(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function signalsFor(
  row: PendingApprovalEvidenceRow,
  item: PendingAutonomousClosureItem,
): readonly PendingApprovalEvidenceSignal[] {
  const text = textOf(row);
  const memoryText = `${row.title ?? ""}\n${row.content}`;
  const signals = new Set<PendingApprovalEvidenceSignal>();
  if (source(row) === "unknown" || item.autonomous_action === "reject_unknown_source") signals.add("unknown_source");
  if (item.autonomous_action === "reject_sensitive") signals.add("sensitive_or_private");
  if (item.autonomous_action === "reject_test_noise") signals.add("test_or_canary_noise");
  if (item.assistant_memory_kind === "process_noise") signals.add("assistant_process_noise");
  if (item.autonomous_action === "approve_explicit_issue") signals.add("operational_issue");
  if (item.autonomous_action === "approve_default") signals.add("stable_operational_fact");
  if (item.autonomous_action === "keep_pending") signals.add("low_confidence");
  if (item.reasons.some((reason) => /document_artifact/u.test(reason))) signals.add("document_artifact");
  if (item.reasons.some((reason) => /external_.*fact/u.test(reason))) signals.add("external_domain_fact");
  if (
    hasPattern(memoryText, /memory-xx|\/home\/xiaoxiao\/services\/memory-xx|MEMORY_XX_|\/api\/memory\/xx/iu) &&
    !hasPattern(memoryText, /memory-xx 是正在运行中的记忆框架/iu)
  ) {
    signals.add("topic_drift");
  }
  if (hasPattern(text, /(CI|build-and-test|Docker Build|release gate|full-stack-release-gate|in progress|还在跑|继续等|当前进度|已通过)/iu)) {
    signals.add("progress_snapshot");
  }
  return [...signals].sort();
}

function requiredBeforeApply(
  lane: PendingApprovalRecommendedLane,
  signals: readonly PendingApprovalEvidenceSignal[],
): readonly string[] {
  const required = new Set<string>(["operator_approval"]);
  if (lane === "approve_candidate" || lane === "explicit_issue_candidate") required.add("scope_policy_gate");
  if (signals.includes("topic_drift")) required.add("topic_scope_review");
  if (signals.includes("sensitive_or_private")) required.add("privacy_review");
  if (signals.includes("progress_snapshot")) required.add("temporal_validity_review");
  if (lane === "keep_pending") required.add("human_review");
  return [...required].sort();
}

function defaultRecallAllowed(item: PendingAutonomousClosureItem): boolean {
  return item.storage_target === "postgres_memory" &&
    item.recall_policy === "default" &&
    item.lifecycle_intent === "active";
}

function countByLane(items: readonly PendingApprovalEvidenceItem[]): Record<PendingApprovalRecommendedLane, number> {
  const counts: Record<PendingApprovalRecommendedLane, number> = {
    approve_candidate: 0,
    explicit_issue_candidate: 0,
    event_log_only: 0,
    quarantine_or_reject: 0,
    keep_pending: 0,
  };
  for (const item of items) counts[item.recommended_lane] += 1;
  return counts;
}

function countBySignal(items: readonly PendingApprovalEvidenceItem[]): Partial<Record<PendingApprovalEvidenceSignal, number>> {
  const counts: Partial<Record<PendingApprovalEvidenceSignal, number>> = {};
  for (const item of items) {
    for (const signal of item.signals) counts[signal] = (counts[signal] ?? 0) + 1;
  }
  return counts;
}

function flattenPlanItems(plan: ReturnType<typeof planAutonomousPendingClosure>): PendingAutonomousClosureItem[] {
  return [
    ...plan.groups.would_approve_default,
    ...plan.groups.would_approve_explicit_issue,
    ...plan.groups.would_reject_closed,
    ...plan.groups.would_reject_sensitive,
    ...plan.groups.would_reject_test_noise,
    ...plan.groups.would_reject_unknown_source,
    ...plan.groups.would_event_log_only,
    ...plan.groups.would_keep_pending,
  ];
}

function itemForRow(
  row: PendingApprovalEvidenceRow,
  item: PendingAutonomousClosureItem,
): PendingApprovalEvidenceItem {
  const signals = signalsFor(row, item);
  const lane = (signals.includes("topic_drift") || signals.includes("progress_snapshot")) &&
    item.autonomous_action === "keep_pending"
    ? "event_log_only"
    : laneFor(item);
  const privacy = scanMemoryPrivacy(`${row.title ?? ""}\n${row.content}`);
  const cognitiveType = signals.includes("progress_snapshot")
    ? "audit"
    : item.cognitive_type ?? inferCognitiveType({
      memory_type: row.memory_type,
      recall_policy: item.recall_policy,
      memory_class: item.memory_class,
    });
  return {
    id: row.id,
    scope: `${row.scope_type}:${row.scope_id}`,
    title: row.title,
    content_preview: preview(row.content),
    source: source(row),
    created_by: row.created_by,
    autonomous_action: item.autonomous_action,
    recommended_lane: lane,
    memory_class: item.memory_class,
    cognitive_type: cognitiveType,
    signals,
    reasons: [...item.reasons],
    evidence_summary: [...signals, ...item.reasons].join("; "),
    recall_contract: {
      storage_target: lane === "event_log_only" ? "event_log_only" : item.storage_target,
      target_recall_policy: lane === "event_log_only" ? "never" : item.recall_policy,
      default_recall_allowed: defaultRecallAllowed(item),
    },
    governance: {
      apply_allowed: false,
      report_only: true,
      required_before_apply: requiredBeforeApply(lane, signals),
    },
    privacy: {
      blocked: privacy.blocked,
      reasons: [...privacy.reasons],
    },
  };
}

export function buildPendingApprovalEvidenceReport(
  input: BuildPendingApprovalEvidenceReportInput,
): PendingApprovalEvidenceReport {
  const plan = planAutonomousPendingClosure(input.rows);
  const rowById = new Map(input.rows.map((row) => [row.id, row]));
  const evidence = flattenPlanItems(plan)
    .flatMap((item) => {
      const row = rowById.get(item.id);
      return row ? [itemForRow(row, item)] : [];
    })
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, input.sampleLimit ?? input.rows.length);
  const byLane = countByLane(evidence);
  const bySignal = countBySignal(evidence);
  const requiresHumanReview = evidence.filter((item) => (
    item.recommended_lane === "keep_pending" ||
    item.recommended_lane === "approve_candidate" ||
    item.recommended_lane === "explicit_issue_candidate"
  )).length;
  return {
    ok: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    report_only: true,
    summary: {
      total_rows: input.rows.length,
      total_evidence_items: evidence.length,
      actionable_without_human_review: evidence.length - requiresHumanReview,
      requires_human_review: requiresHumanReview,
      by_recommended_lane: byLane,
      by_signal: bySignal,
    },
    evidence,
  };
}

export function pendingApprovalEvidenceSummaryForEvolve(report: PendingApprovalEvidenceReport): JsonObject {
  return {
    total_rows: report.summary.total_rows,
    total_evidence_items: report.summary.total_evidence_items,
    actionable_without_human_review: report.summary.actionable_without_human_review,
    requires_human_review: report.summary.requires_human_review,
    by_recommended_lane: report.summary.by_recommended_lane,
    by_signal: report.summary.by_signal,
    report_only: true,
  };
}

function safeCloseOperation(item: PendingApprovalEvidenceItem): PendingSafeCloseOperation | null {
  if (item.recommended_lane === "event_log_only") return "event_log_only";
  if (item.recommended_lane === "quarantine_or_reject") return "reject_or_quarantine";
  return null;
}

function safeCloseCandidate(item: PendingApprovalEvidenceItem, operation: PendingSafeCloseOperation): PendingSafeCloseCandidate {
  return {
    id: item.id,
    operation,
    autonomous_action: item.autonomous_action,
    memory_class: item.memory_class,
    cognitive_type: item.cognitive_type,
    target_recall_policy: item.recall_contract.target_recall_policy,
    storage_target: item.recall_contract.storage_target,
    default_recall_allowed: item.recall_contract.default_recall_allowed,
    reasons: [...item.reasons],
    signals: [...item.signals],
    apply_allowed: false,
    rollback_plan: {
      action: "restore_candidate_state",
      restore_lifecycle_status: "candidate",
      restore_review_state: "pending",
    },
  };
}

function excludedCandidate(item: PendingApprovalEvidenceItem): PendingSafeCloseExcludedCandidate {
  return {
    id: item.id,
    recommended_lane: item.recommended_lane,
    reasons: [...item.reasons],
    required_before_apply: [...item.governance.required_before_apply],
  };
}

function countByOperation(items: readonly PendingSafeCloseCandidate[]): Record<PendingSafeCloseOperation, number> {
  return {
    event_log_only: items.filter((item) => item.operation === "event_log_only").length,
    reject_or_quarantine: items.filter((item) => item.operation === "reject_or_quarantine").length,
  };
}

export function buildPendingSafeClosePlan(input: BuildPendingSafeClosePlanInput): PendingSafeClosePlan {
  const safeCloseCandidates: PendingSafeCloseCandidate[] = [];
  const excluded: PendingSafeCloseExcludedCandidate[] = [];
  for (const item of input.report.evidence) {
    const operation = safeCloseOperation(item);
    if (operation && !item.recall_contract.default_recall_allowed) {
      safeCloseCandidates.push(safeCloseCandidate(item, operation));
    } else {
      excluded.push(excludedCandidate(item));
    }
  }
  const sortedSafeClose = safeCloseCandidates.sort((left, right) => left.id.localeCompare(right.id));
  const sortedExcluded = excluded.sort((left, right) => left.id.localeCompare(right.id));
  return {
    ok: true,
    run_id: input.runId,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    report_only: true,
    apply_allowed: false,
    blockers: ["operator_approval_required", "apply_not_implemented"],
    summary: {
      total_evidence_items: input.report.evidence.length,
      safe_close_candidates: sortedSafeClose.length,
      excluded_for_human_review: sortedExcluded.length,
      by_operation: countByOperation(sortedSafeClose),
    },
    safe_close_candidates: sortedSafeClose,
    excluded_for_human_review: sortedExcluded,
  };
}

export function pendingSafeCloseSummaryForEvolve(plan: PendingSafeClosePlan): JsonObject {
  return {
    total_evidence_items: plan.summary.total_evidence_items,
    safe_close_candidates: plan.summary.safe_close_candidates,
    excluded_for_human_review: plan.summary.excluded_for_human_review,
    by_operation: plan.summary.by_operation,
    report_only: true,
    apply_allowed: false,
    blockers: [...plan.blockers],
  };
}
