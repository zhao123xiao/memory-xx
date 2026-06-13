export type MemoryOsDashboardSeverity = "ok" | "info" | "warning" | "critical";

export interface MemoryOsDashboardBlocker {
  readonly domain: string;
  readonly count: number;
}

export interface MemoryOsDashboardCard {
  readonly id: "readiness" | "pending_review" | "storage_graph_debt" | "temporal_update_debt";
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  readonly severity: MemoryOsDashboardSeverity;
  readonly detail: string;
}

export interface MemoryOsDashboardQueue {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  readonly severity: MemoryOsDashboardSeverity;
  readonly recommended_next_step: string;
  readonly breakdown: readonly MemoryOsCountItem[];
}

export interface MemoryOsCountItem {
  readonly label: string;
  readonly count: number;
}

export interface MemoryOsDomainReadiness {
  readonly domain: string;
  readonly action_candidates: number;
  readonly status: string;
  readonly readiness_percent: number;
  readonly recommended_next_step: string;
  readonly top_blockers: readonly {
    readonly source: string;
    readonly reason: string;
    readonly action_candidates: number;
    readonly recommended_next_step: string;
  }[];
}

export interface MemoryOsStorageFocus {
  readonly top_orphan_reasons: readonly {
    readonly reason: string;
    readonly count: number;
    readonly suggested_action: string;
  }[];
  readonly repair_actions: readonly {
    readonly action: string;
    readonly count: number;
  }[];
  readonly repair_blockers: readonly {
    readonly blocker: string;
    readonly count: number;
  }[];
  readonly successor_match_types: readonly MemoryOsCountItem[];
  readonly successor_alias_suggestions: readonly {
    readonly source_topic: string;
    readonly candidate_topic: string;
    readonly count: number;
  }[];
  readonly successor_review_lanes: readonly MemoryOsCountItem[];
  readonly orphan_review_lanes: readonly MemoryOsCountItem[];
  readonly orphan_review_queue: readonly {
    readonly candidate_id: string;
    readonly memory_id: string;
    readonly scope: string;
    readonly title: string;
    readonly memory_type: string;
    readonly reason: string;
    readonly lane: string;
    readonly suggested_action: string;
    readonly relation_id: string;
    readonly relation_type: string;
    readonly relation_memory_id: string;
    readonly relation_related_memory_id: string;
    readonly related_lifecycle_status: string;
    readonly related_is_current: boolean | null;
    readonly blockers: readonly string[];
    readonly review_lane: "graph_enrichment_review" | "relation_repair_review";
    readonly recommended_decision: "review_graph_enrichment_evidence" | "review_relation_repair_or_archive";
    readonly apply_allowed: false;
  }[];
  readonly relation_repair_review_lanes: readonly MemoryOsCountItem[];
  readonly relation_repair_review_queue: readonly {
    readonly candidate_id: string;
    readonly relation_id: string;
    readonly relation_type: string;
    readonly source_memory_id: string;
    readonly current_related_memory_id: string;
    readonly suggested_related_memory_id: string;
    readonly reason: string;
    readonly lane: string;
    readonly suggested_action: string;
    readonly review_blocker: string;
    readonly source_exists: boolean;
    readonly target_exists: boolean;
    readonly successor_count: number;
    readonly blockers: readonly string[];
    readonly review_lane: "ready_to_retarget" | "successor_discovery_required" | "archive_or_restore_review";
    readonly recommended_decision: "retarget_after_human_review" | "find_successor_before_retarget" | "archive_relation_or_restore_target";
    readonly apply_allowed: false;
  }[];
  readonly successor_review_queue: readonly {
    readonly candidate_id: string;
    readonly relation_id: string;
    readonly relation_type: string;
    readonly source_memory_id: string;
    readonly old_target_memory_id: string;
    readonly candidate_successor_memory_id: string;
    readonly suggested_repair_action: string;
    readonly match_type: string;
    readonly confidence: number;
    readonly scope: string;
    readonly topic: string;
    readonly shared_terms: readonly string[];
    readonly blockers: readonly string[];
    readonly review_lane: "retarget_review" | "topic_normalization_review" | "low_confidence_review";
    readonly recommended_decision: "accept_successor_after_human_review" | "review_topic_alias_before_retarget" | "request_more_evidence";
  }[];
  readonly topic_normalization_priority_counts: readonly MemoryOsCountItem[];
  readonly topic_normalization_review_queue: readonly {
    readonly priority: string;
    readonly normalization_candidate_id: string;
    readonly alias_candidate_id: string;
    readonly source_topic: string;
    readonly canonical_topic: string;
    readonly affected_memory_ids: readonly string[];
    readonly affected_memory_count: number;
    readonly supporting_discoveries: number;
    readonly avg_confidence: number;
    readonly required_before_apply: readonly string[];
    readonly recommended_action: string;
    readonly recommended_decision: "review_alias_scope_and_affected_samples";
    readonly apply_allowed: false;
  }[];
}

export interface MemoryOsGovernanceFocus {
  readonly lanes: readonly MemoryOsCountItem[];
  readonly signals: readonly MemoryOsCountItem[];
  readonly safe_close_blockers: readonly string[];
  readonly pending_review_queue: readonly {
    readonly id: string;
    readonly recommended_lane: string;
    readonly memory_class: string;
    readonly cognitive_type: string;
    readonly signals: readonly string[];
    readonly evidence_summary: string;
    readonly storage_target: string;
    readonly target_recall_policy: string;
    readonly default_recall_allowed: boolean;
    readonly required_before_apply: readonly string[];
    readonly privacy_blocked: boolean;
    readonly privacy_reasons: readonly string[];
    readonly recommended_decision: "review_then_approve_or_reject" | "keep_pending_until_more_evidence" | "review_quarantine_or_reject";
  }[];
  readonly safe_close_queue: readonly {
    readonly id: string;
    readonly operation: string;
    readonly autonomous_action: string;
    readonly memory_class: string;
    readonly cognitive_type: string;
    readonly target_recall_policy: string;
    readonly storage_target: string;
    readonly default_recall_allowed: boolean;
    readonly reasons: readonly string[];
    readonly signals: readonly string[];
    readonly rollback_action: string;
    readonly recommended_decision: "close_as_event_log_only_after_batch_review" | "reject_or_quarantine_after_batch_review";
    readonly apply_allowed: false;
  }[];
  readonly human_review_exclusions: readonly {
    readonly id: string;
    readonly recommended_lane: string;
    readonly reasons: readonly string[];
    readonly required_before_apply: readonly string[];
  }[];
}

export interface MemoryOsUpdateFocus {
  readonly temporal_reason_counts: readonly MemoryOsCountItem[];
  readonly temporal_action_counts: readonly MemoryOsCountItem[];
  readonly temporal_review_queue: readonly {
    readonly memory_id: string;
    readonly scope: string;
    readonly title: string;
    readonly content_preview: string;
    readonly memory_type: string;
    readonly memory_class: string;
    readonly cognitive_type: string;
    readonly recall_policy: string;
    readonly fact_status: string;
    readonly reasons: readonly string[];
    readonly suggested_action: string;
    readonly suggested_recall_policy: string;
    readonly suggested_fact_status: string;
    readonly blockers: readonly string[];
    readonly observed_at: string;
    readonly review_at: string;
    readonly expires_at: string;
    readonly updated_at: string;
    readonly recommended_decision: "isolate_snapshot_from_default_recall" | "review_validity_window_and_fact_status";
  }[];
}

export interface MemoryOsRetrievalFocus {
  readonly calibration_action_counts: readonly MemoryOsCountItem[];
  readonly calibration_review_lanes: readonly MemoryOsCountItem[];
  readonly calibration_review_queue: readonly {
    readonly scope_key: string;
    readonly query_type: string;
    readonly trace_count: number;
    readonly empty_recall_rate: number;
    readonly feedback_count: number;
    readonly negative_feedback_rate: number;
    readonly false_positive_count: number;
    readonly avg_top1_distance: number | null;
    readonly avg_top1_top2_gap: number | null;
    readonly avg_top1_rerank_score: number | null;
    readonly suggested_action: string;
    readonly proposed_threshold_delta: string;
    readonly reason: string;
    readonly sample_size_ok: boolean;
    readonly false_positive_guard_ok: boolean;
    readonly eligible_for_apply: boolean;
    readonly blockers: readonly string[];
    readonly review_lane: "tighten_threshold_review" | "loosen_threshold_review" | "collect_more_samples" | "hold";
    readonly recommended_decision:
      | "review_false_positive_pressure_before_tightening"
      | "review_empty_recall_pressure_before_loosening"
      | "collect_more_traces_before_calibration"
      | "hold_current_thresholds";
    readonly apply_allowed: false;
  }[];
}

export interface MemoryOsDashboardAction {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly enabled: false;
  readonly mode: "report_only";
  readonly reason: string;
}

export interface MemoryOsCommandCenterItem {
  readonly rank: number;
  readonly domain: "storage" | "governance" | "update" | "retrieval";
  readonly label: string;
  readonly count: number;
  readonly severity: MemoryOsDashboardSeverity;
  readonly target_queue: string;
  readonly target_anchor: string;
  readonly why_now: string;
  readonly recommended_next_step: string;
  readonly mode: "report_only";
}

export interface MemoryOsDebtBurndownPhase {
  readonly order: number;
  readonly domain: "storage" | "governance" | "update" | "retrieval";
  readonly label: string;
  readonly queue: string;
  readonly count: number;
  readonly batch_size: number;
  readonly estimated_batches: number;
  readonly target_anchor: string;
  readonly verification_gate: string;
  readonly exit_condition: string;
  readonly safety_guardrail: string;
  readonly mode: "report_only";
}

export interface MemoryOsReadinessExplainerDomain {
  readonly domain: string;
  readonly readiness_percent: number;
  readonly status: string;
  readonly risk_level: MemoryOsDashboardSeverity;
  readonly action_candidates: number;
  readonly primary_blocker: string;
  readonly evidence_keys: readonly string[];
  readonly recovery_gate: string;
  readonly target_anchor: string;
  readonly mode: "report_only";
}

export interface MemoryOsDashboardModel {
  readonly ok: true;
  readonly generated_at: string;
  readonly mode: string;
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly command_center: {
    readonly prioritized_work: readonly MemoryOsCommandCenterItem[];
  };
  readonly debt_burndown: {
    readonly summary: {
      readonly total_action_candidates: number;
      readonly estimated_batches: number;
      readonly mode: "report_only";
      readonly apply_allowed: false;
    };
    readonly phases: readonly MemoryOsDebtBurndownPhase[];
  };
  readonly readiness: {
    readonly percent: number;
    readonly lowest_domain: string;
    readonly top_blockers: readonly MemoryOsDashboardBlocker[];
  };
  readonly readiness_explainer: {
    readonly domains: readonly MemoryOsReadinessExplainerDomain[];
  };
  readonly cards: readonly MemoryOsDashboardCard[];
  readonly queues: {
    readonly safe_close: MemoryOsDashboardQueue;
    readonly human_review: MemoryOsDashboardQueue;
    readonly keep_pending: MemoryOsDashboardQueue;
    readonly graph_repair: MemoryOsDashboardQueue;
    readonly topic_normalization: MemoryOsDashboardQueue;
  };
  readonly domain_readiness: readonly MemoryOsDomainReadiness[];
  readonly storage_focus: MemoryOsStorageFocus;
  readonly update_focus: MemoryOsUpdateFocus;
  readonly retrieval_focus: MemoryOsRetrievalFocus;
  readonly governance_focus: MemoryOsGovernanceFocus;
  readonly storage_top_blockers: readonly string[];
  readonly next_actions: readonly MemoryOsDashboardAction[];
  readonly raw_summary: Record<string, unknown>;
}

export interface BuildMemoryOsDashboardModelInput {
  readonly generated_at?: string;
  readonly mode?: string;
  readonly report_only?: boolean;
  readonly apply_allowed?: boolean;
  readonly summary?: Record<string, unknown>;
  readonly sections?: Record<string, unknown>;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function severityForDebt(count: number): MemoryOsDashboardSeverity {
  if (count >= 100) return "critical";
  if (count > 0) return "warning";
  return "ok";
}

function readinessSeverity(percent: number): MemoryOsDashboardSeverity {
  if (percent < 50) return "critical";
  if (percent < 80) return "warning";
  return "ok";
}

function pendingSeverity(count: number): MemoryOsDashboardSeverity {
  if (count > 0) return "warning";
  return "ok";
}

function parseBlockers(value: unknown): MemoryOsDashboardBlocker[] {
  return stringValue(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [domain, rawCount] = part.split(":");
      return {
        domain: domain?.trim() || "unknown",
        count: numberValue(Number(rawCount)),
      };
    })
    .filter((item) => item.domain && item.count > 0);
}

function splitCsv(value: unknown): string[] {
  return stringValue(value).split(",").map((part) => part.trim()).filter(Boolean);
}

function sectionSummary(sections: Record<string, unknown>, sectionName: string): Record<string, unknown> {
  return objectValue(objectValue(sections[sectionName]).summary);
}

function countItems(value: unknown): MemoryOsCountItem[] {
  return Object.entries(objectValue(value))
    .map(([label, count]) => ({ label, count: numberValue(count) }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function incrementCount(target: Map<string, number>, key: string): void {
  target.set(key, (target.get(key) ?? 0) + 1);
}

function successorReviewLane(matchType: string, confidence: number): {
  readonly review_lane: "retarget_review" | "topic_normalization_review" | "low_confidence_review";
  readonly recommended_decision: "accept_successor_after_human_review" | "review_topic_alias_before_retarget" | "request_more_evidence";
} {
  if (confidence < 0.75) {
    return {
      review_lane: "low_confidence_review",
      recommended_decision: "request_more_evidence",
    };
  }
  if (matchType === "exact_topic") {
    return {
      review_lane: "retarget_review",
      recommended_decision: "accept_successor_after_human_review",
    };
  }
  return {
    review_lane: "topic_normalization_review",
    recommended_decision: "review_topic_alias_before_retarget",
  };
}

function successorLaneRank(value: string): number {
  if (value === "retarget_review") return 0;
  if (value === "topic_normalization_review") return 1;
  return 2;
}

function orphanReviewLane(action: string): {
  readonly review_lane: "graph_enrichment_review" | "relation_repair_review";
  readonly recommended_decision: "review_graph_enrichment_evidence" | "review_relation_repair_or_archive";
} {
  if (action === "review_graph_enrichment") {
    return {
      review_lane: "graph_enrichment_review",
      recommended_decision: "review_graph_enrichment_evidence",
    };
  }
  return {
    review_lane: "relation_repair_review",
    recommended_decision: "review_relation_repair_or_archive",
  };
}

function orphanLaneRank(value: string): number {
  if (value === "graph_enrichment_review") return 0;
  return 1;
}

function relationRepairReviewLane(action: string, blocker: string): {
  readonly review_lane: "ready_to_retarget" | "successor_discovery_required" | "archive_or_restore_review";
  readonly recommended_decision: "retarget_after_human_review" | "find_successor_before_retarget" | "archive_relation_or_restore_target";
} {
  if (action === "retarget_relation_to_successor" && blocker === "none") {
    return {
      review_lane: "ready_to_retarget",
      recommended_decision: "retarget_after_human_review",
    };
  }
  if (action === "review_successor_before_retarget") {
    return {
      review_lane: "successor_discovery_required",
      recommended_decision: "find_successor_before_retarget",
    };
  }
  return {
    review_lane: "archive_or_restore_review",
    recommended_decision: "archive_relation_or_restore_target",
  };
}

function relationRepairLaneRank(value: string): number {
  if (value === "ready_to_retarget") return 0;
  if (value === "successor_discovery_required") return 1;
  return 2;
}

function pendingReviewDecision(lane: string): "review_then_approve_or_reject" | "keep_pending_until_more_evidence" | "review_quarantine_or_reject" {
  if (lane === "keep_pending") return "keep_pending_until_more_evidence";
  if (lane === "quarantine_or_reject") return "review_quarantine_or_reject";
  return "review_then_approve_or_reject";
}

function pendingLaneRank(value: string): number {
  if (value === "approve_candidate") return 0;
  if (value === "explicit_issue_candidate") return 1;
  if (value === "keep_pending") return 2;
  if (value === "quarantine_or_reject") return 3;
  return 4;
}

function safeCloseDecision(operation: string): "close_as_event_log_only_after_batch_review" | "reject_or_quarantine_after_batch_review" {
  return operation === "event_log_only"
    ? "close_as_event_log_only_after_batch_review"
    : "reject_or_quarantine_after_batch_review";
}

function safeCloseOperationRank(value: string): number {
  if (value === "event_log_only") return 0;
  if (value === "reject_or_quarantine") return 1;
  return 2;
}

function temporalReviewDecision(action: string): "isolate_snapshot_from_default_recall" | "review_validity_window_and_fact_status" {
  return action === "isolate_temporal_snapshot"
    ? "isolate_snapshot_from_default_recall"
    : "review_validity_window_and_fact_status";
}

function temporalActionRank(value: string): number {
  if (value === "isolate_temporal_snapshot") return 0;
  if (value === "review_temporal_metadata") return 1;
  return 2;
}

function nullableNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function calibrationReviewLane(action: string): {
  readonly review_lane: "tighten_threshold_review" | "loosen_threshold_review" | "collect_more_samples" | "hold";
  readonly recommended_decision:
    | "review_false_positive_pressure_before_tightening"
    | "review_empty_recall_pressure_before_loosening"
    | "collect_more_traces_before_calibration"
    | "hold_current_thresholds";
} {
  if (action === "tighten_threshold") {
    return {
      review_lane: "tighten_threshold_review",
      recommended_decision: "review_false_positive_pressure_before_tightening",
    };
  }
  if (action === "loosen_threshold") {
    return {
      review_lane: "loosen_threshold_review",
      recommended_decision: "review_empty_recall_pressure_before_loosening",
    };
  }
  if (action === "collect_more_samples") {
    return {
      review_lane: "collect_more_samples",
      recommended_decision: "collect_more_traces_before_calibration",
    };
  }
  return {
    review_lane: "hold",
    recommended_decision: "hold_current_thresholds",
  };
}

function calibrationLaneRank(value: string): number {
  if (value === "tighten_threshold_review") return 0;
  if (value === "loosen_threshold_review") return 1;
  if (value === "collect_more_samples") return 2;
  return 3;
}

function queue(
  id: string,
  label: string,
  count: number,
  recommendedNextStep: string,
  breakdown: readonly MemoryOsCountItem[] = [],
): MemoryOsDashboardQueue {
  return {
    id,
    label,
    count,
    severity: severityForDebt(count),
    recommended_next_step: recommendedNextStep,
    breakdown,
  };
}

function action(
  id: string,
  label: string,
  command: string,
  reason: string,
): MemoryOsDashboardAction {
  return {
    id,
    label,
    command,
    enabled: false,
    mode: "report_only",
    reason,
  };
}

function commandCenterItem(input: Omit<MemoryOsCommandCenterItem, "rank" | "mode" | "severity">): Omit<MemoryOsCommandCenterItem, "rank"> {
  return {
    ...input,
    severity: severityForDebt(input.count),
    mode: "report_only",
  };
}

function buildPrioritizedWork(input: {
  readonly lowestDomain: string;
  readonly relationRepair: number;
  readonly graphOrphans: number;
  readonly pendingTotal: number;
  readonly safeClose: number;
  readonly humanReview: number;
  readonly temporalDebt: number;
  readonly adaptiveCalibration: number;
}): MemoryOsCommandCenterItem[] {
  const relationRepairWhy = input.lowestDomain === "storage"
    ? "Storage is the lowest readiness domain and relation repair blocks graph recall reliability."
    : "Relation repair blocks graph recall reliability and should be resolved before graph-based context is trusted.";
  const items = [
    input.relationRepair > 0 ? commandCenterItem({
      domain: "storage",
      label: "Resolve relation repair blockers",
      count: input.relationRepair,
      target_queue: "relation_repair_review",
      target_anchor: "memory-os-relation-repair-review",
      why_now: relationRepairWhy,
      recommended_next_step: "Review successor discovery evidence before retargeting stale relation targets.",
    }) : null,
    input.graphOrphans > 0 ? commandCenterItem({
      domain: "storage",
      label: "Review graph orphan evidence",
      count: input.graphOrphans,
      target_queue: "graph_orphan_review",
      target_anchor: "memory-os-graph-orphan-review",
      why_now: "Graph orphan debt is keeping entity, episode, and relation evidence from becoming a dependable recall layer.",
      recommended_next_step: "Split enrichment-only cases from relation-repair cases, then review the highest-volume lane first.",
    }) : null,
    input.pendingTotal > 0 ? commandCenterItem({
      domain: "governance",
      label: "Triage pending approval debt",
      count: input.pendingTotal,
      target_queue: "pending_review",
      target_anchor: "memory-os-pending-review",
      why_now: `${input.safeClose} candidates look safe-close eligible, while ${input.humanReview} still need human review before approval or rejection.`,
      recommended_next_step: "Start with human review exclusions, then batch-review safe-close candidates with rollback evidence visible.",
    }) : null,
    input.temporalDebt > 0 ? commandCenterItem({
      domain: "update",
      label: "Review temporal validity debt",
      count: input.temporalDebt,
      target_queue: "temporal_review",
      target_anchor: "memory-os-temporal-review",
      why_now: "Progress snapshots and current-state facts can pollute default recall if their validity window is not reviewed.",
      recommended_next_step: "Isolate progress snapshots from default recall and set review_at or historical fact status where needed.",
    }) : null,
    input.adaptiveCalibration > 0 ? commandCenterItem({
      domain: "retrieval",
      label: "Collect calibration evidence",
      count: input.adaptiveCalibration,
      target_queue: "calibration_review",
      target_anchor: "memory-os-calibration-review",
      why_now: "Per-scope retrieval thresholds need enough traces before automatic calibration can be trusted.",
      recommended_next_step: "Collect more traces for under-sampled cohorts and only review threshold movement when guardrails pass.",
    }) : null,
  ].filter((item): item is Omit<MemoryOsCommandCenterItem, "rank"> => item !== null);

  return items.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

function burndownPhase(input: Omit<MemoryOsDebtBurndownPhase, "order" | "estimated_batches" | "mode">): Omit<MemoryOsDebtBurndownPhase, "order"> {
  return {
    ...input,
    estimated_batches: Math.ceil(input.count / input.batch_size),
    mode: "report_only",
  };
}

function buildDebtBurndown(input: {
  readonly totalActionCandidates: number;
  readonly relationRepair: number;
  readonly graphOrphans: number;
  readonly pendingTotal: number;
  readonly temporalDebt: number;
  readonly adaptiveCalibration: number;
}): MemoryOsDashboardModel["debt_burndown"] {
  const phases = [
    input.relationRepair > 0 ? burndownPhase({
      domain: "storage",
      label: "Relation repair successor review",
      queue: "relation_repair_review",
      count: input.relationRepair,
      batch_size: 25,
      target_anchor: "memory-os-relation-repair-review",
      verification_gate: "Every retarget candidate must have successor evidence or remain in successor_discovery_required.",
      exit_condition: "graph_relation_repair_candidates is 0 or all remaining items require new source evidence.",
      safety_guardrail: "Do not rewrite relation targets from this panel; keep apply_allowed=false.",
    }) : null,
    input.graphOrphans > 0 ? burndownPhase({
      domain: "storage",
      label: "Graph orphan lane review",
      queue: "graph_orphan_review",
      count: input.graphOrphans,
      batch_size: 25,
      target_anchor: "memory-os-graph-orphan-review",
      verification_gate: "Lane split must separate enrichment-only debt from relation repair/archive decisions.",
      exit_condition: "graph_orphan_candidates trends down without increasing relation repair blockers.",
      safety_guardrail: "Prefer evidence review and classification before graph mutation.",
    }) : null,
    input.pendingTotal > 0 ? burndownPhase({
      domain: "governance",
      label: "Pending human triage",
      queue: "pending_review",
      count: input.pendingTotal,
      batch_size: 20,
      target_anchor: "memory-os-pending-review",
      verification_gate: "Human-review exclusions must be checked before safe-close batches.",
      exit_condition: "pending_total reaches 0 or only intentional keep_pending candidates remain.",
      safety_guardrail: "Keep privacy, scope policy, and temporal validity gates visible before approval.",
    }) : null,
    input.temporalDebt > 0 ? burndownPhase({
      domain: "update",
      label: "Temporal snapshot isolation review",
      queue: "temporal_review",
      count: input.temporalDebt,
      batch_size: 20,
      target_anchor: "memory-os-temporal-review",
      verification_gate: "Each snapshot must have recall_policy and fact_status reviewed together.",
      exit_condition: "temporal_validity_debt_candidates reaches 0 for default-recall current snapshots.",
      safety_guardrail: "Never silently demote a memory without a visible review reason.",
    }) : null,
    input.adaptiveCalibration > 0 ? burndownPhase({
      domain: "retrieval",
      label: "Retrieval calibration sample collection",
      queue: "calibration_review",
      count: input.adaptiveCalibration,
      batch_size: 10,
      target_anchor: "memory-os-calibration-review",
      verification_gate: "Threshold movement needs enough traces and false-positive guardrails.",
      exit_condition: "All calibration cohorts are hold or eligible_for_apply with review evidence.",
      safety_guardrail: "Do not share one global threshold across sparse and dense scopes.",
    }) : null,
  ].filter((phase): phase is Omit<MemoryOsDebtBurndownPhase, "order"> => phase !== null);

  const ordered = phases.map((phase, index) => ({
    ...phase,
    order: index + 1,
  }));

  return {
    summary: {
      total_action_candidates: input.totalActionCandidates || ordered.reduce((sum, phase) => sum + phase.count, 0),
      estimated_batches: ordered.reduce((sum, phase) => sum + phase.estimated_batches, 0),
      mode: "report_only",
      apply_allowed: false,
    },
    phases: ordered,
  };
}

function readinessTargetAnchor(domain: string, primaryBlocker: string): string {
  if (primaryBlocker.startsWith("graph_relation_repair.")) return "memory-os-relation-repair-review";
  if (primaryBlocker.startsWith("graph_orphan.")) return "memory-os-graph-orphan-review";
  if (primaryBlocker.startsWith("topic_normalization")) return "memory-os-topic-normalization-review";
  if (domain === "governance") return "memory-os-pending-review";
  if (domain === "update") return "memory-os-temporal-review";
  if (domain === "retrieval") return "memory-os-calibration-review";
  return "memory-os-actions";
}

function buildReadinessExplainer(
  domains: readonly (MemoryOsDomainReadiness & { readonly evidence_keys?: readonly string[] })[],
): MemoryOsDashboardModel["readiness_explainer"] {
  return {
    domains: domains.map((domain) => {
      const primary = domain.top_blockers[0];
      const primaryBlocker = primary
        ? `${primary.source}.${primary.reason}:${primary.action_candidates}`
        : "none";
      return {
        domain: domain.domain,
        readiness_percent: domain.readiness_percent,
        status: domain.status,
        risk_level: readinessSeverity(domain.readiness_percent),
        action_candidates: domain.action_candidates,
        primary_blocker: primaryBlocker,
        evidence_keys: domain.evidence_keys ?? [],
        recovery_gate: domain.action_candidates > 0
          ? `Review and close ${domain.action_candidates} action_candidates before increasing ${domain.domain} readiness.`
          : "No action_candidates remain for this domain.",
        target_anchor: readinessTargetAnchor(domain.domain, primaryBlocker),
        mode: "report_only",
      };
    }),
  };
}

export function buildMemoryOsDashboardModel(input: BuildMemoryOsDashboardModelInput): MemoryOsDashboardModel {
  const summary = input.summary ?? {};
  const sections = input.sections ?? {};
  const pendingEvidence = sectionSummary(sections, "pending_approval_evidence");
  const pendingSafeClose = sectionSummary(sections, "pending_safe_close");
  const graphOrphanSummary = sectionSummary(sections, "graph_orphans");
  const graphRepairSummary = sectionSummary(sections, "graph_relation_repair");
  const graphSuccessorSummary = sectionSummary(sections, "graph_successor_discovery");
  const temporalValiditySummary = sectionSummary(sections, "temporal_validity_debt");
  const adaptiveSummary = sectionSummary(sections, "adaptive_retrieval");
  const readinessSummary = sectionSummary(sections, "memory_os_readiness");
  const readiness = numberValue(summary.memory_os_overall_readiness_percent);
  const pendingTotal = numberValue(summary.pending_total);
  const totalActionCandidates = numberValue(summary.total_action_candidates);
  const safeClose = numberValue(summary.pending_safe_close_candidates);
  const humanReview = numberValue(summary.pending_safe_close_excluded_for_human_review);
  const keepPending = numberValue(summary.pending_keep_pending);
  const graphOrphans = numberValue(summary.graph_orphan_candidates);
  const graphOrphansProduction = numberValue(summary.graph_orphan_production_candidates);
  const graphRepair = numberValue(summary.graph_relation_repair_candidates);
  const graphRepairProduction = numberValue(summary.graph_relation_repair_production_candidates);
  const topicNormalization = numberValue(summary.topic_normalization_review_queue_candidates);
  const adaptiveCalibration = numberValue(summary.adaptive_calibration_cohorts);
  const temporalDebt =
    numberValue(summary.temporal_validity_debt_candidates) +
    numberValue(summary.temporal_transition_candidates);
  const storageGraphOrphans = graphOrphansProduction > 0 || "graph_orphan_production_candidates" in summary
    ? graphOrphansProduction
    : graphOrphans;
  const storageGraphRepair = graphRepairProduction > 0 || "graph_relation_repair_production_candidates" in summary
    ? graphRepairProduction
    : graphRepair;
  const storageDebt = storageGraphOrphans + topicNormalization;
  const orphanLaneCounts = new Map<string, number>();
  const relationRepairLaneCounts = new Map<string, number>();
  const successorLaneCounts = new Map<string, number>();
  const topicNormalizationPriorityCounts = new Map<string, number>();
  const calibrationLaneCounts = new Map<string, number>();
  const pendingEvidenceSection = objectValue(sections.pending_approval_evidence);
  const pendingSafeCloseSection = objectValue(sections.pending_safe_close);
  const temporalValiditySection = objectValue(sections.temporal_validity_debt);
  const adaptiveRetrievalSection = objectValue(sections.adaptive_retrieval);
  const orphanReviewQueue = arrayValue(objectValue(sections.graph_orphans).candidates).map((raw) => {
    const item = objectValue(raw);
    const evidence = objectValue(item.evidence);
    const lane = orphanReviewLane(stringValue(item.suggested_action));
    incrementCount(orphanLaneCounts, lane.review_lane);
    return {
      candidate_id: stringValue(item.candidate_id),
      memory_id: stringValue(item.memory_id),
      scope: stringValue(item.scope) || "unknown",
      title: stringValue(item.title),
      memory_type: stringValue(item.memory_type) || "unknown",
      reason: stringValue(item.reason) || "unknown",
      lane: stringValue(item.lane) || "production",
      suggested_action: stringValue(item.suggested_action) || "unknown",
      relation_id: stringValue(evidence.relation_id),
      relation_type: stringValue(evidence.relation_type),
      relation_memory_id: stringValue(evidence.relation_memory_id),
      relation_related_memory_id: stringValue(evidence.relation_related_memory_id),
      related_lifecycle_status: stringValue(evidence.related_lifecycle_status),
      related_is_current: typeof evidence.related_is_current === "boolean" ? evidence.related_is_current : null,
      blockers: arrayValue(item.blockers).map((blocker) => stringValue(blocker)).filter(Boolean),
      ...lane,
      apply_allowed: false as const,
    };
  }).filter((item) => item.candidate_id).sort((left, right) =>
    orphanLaneRank(left.review_lane) - orphanLaneRank(right.review_lane) ||
    left.reason.localeCompare(right.reason) ||
    left.memory_id.localeCompare(right.memory_id)
  );
  const relationRepairReviewQueue = arrayValue(objectValue(sections.graph_relation_repair).candidates).map((raw) => {
    const item = objectValue(raw);
    const evidence = objectValue(item.evidence);
    const action = stringValue(item.suggested_action) || "unknown";
    const blocker = stringValue(item.review_blocker) || "unknown";
    const lane = relationRepairReviewLane(action, blocker);
    incrementCount(relationRepairLaneCounts, lane.review_lane);
    return {
      candidate_id: stringValue(item.candidate_id),
      relation_id: stringValue(item.relation_id),
      relation_type: stringValue(item.relation_type),
      source_memory_id: stringValue(item.source_memory_id),
      current_related_memory_id: stringValue(item.current_related_memory_id),
      suggested_related_memory_id: stringValue(item.suggested_related_memory_id),
      reason: stringValue(item.reason) || "unknown",
      lane: stringValue(item.lane) || "production",
      suggested_action: action,
      review_blocker: blocker,
      source_exists: evidence.source_exists === true,
      target_exists: evidence.target_exists === true,
      successor_count: numberValue(evidence.successor_count),
      blockers: arrayValue(item.blockers).map((blockerValue) => stringValue(blockerValue)).filter(Boolean),
      ...lane,
      apply_allowed: false as const,
    };
  }).filter((item) => item.candidate_id).sort((left, right) =>
    relationRepairLaneRank(left.review_lane) - relationRepairLaneRank(right.review_lane) ||
    left.relation_id.localeCompare(right.relation_id)
  );
  const pendingReviewQueue = arrayValue(pendingEvidenceSection.candidates).map((raw) => {
    const item = objectValue(raw);
    const recallContract = objectValue(item.recall_contract);
    const governance = objectValue(item.governance);
    const privacy = objectValue(item.privacy);
    const lane = stringValue(item.recommended_lane) || "unknown";
    return {
      id: stringValue(item.id),
      recommended_lane: lane,
      memory_class: stringValue(item.memory_class) || "unknown",
      cognitive_type: stringValue(item.cognitive_type) || "unknown",
      signals: arrayValue(item.signals).map((signal) => stringValue(signal)).filter(Boolean),
      evidence_summary: stringValue(item.evidence_summary),
      storage_target: stringValue(recallContract.storage_target) || "unknown",
      target_recall_policy: stringValue(recallContract.target_recall_policy) || "unknown",
      default_recall_allowed: recallContract.default_recall_allowed === true,
      required_before_apply: arrayValue(governance.required_before_apply).map((step) => stringValue(step)).filter(Boolean),
      privacy_blocked: privacy.blocked === true,
      privacy_reasons: arrayValue(privacy.reasons).map((reason) => stringValue(reason)).filter(Boolean),
      recommended_decision: pendingReviewDecision(lane),
    };
  }).filter((item) => item.id).sort((left, right) =>
    pendingLaneRank(left.recommended_lane) - pendingLaneRank(right.recommended_lane) ||
    left.id.localeCompare(right.id)
  );
  const safeCloseQueue = arrayValue(pendingSafeCloseSection.candidates).map((raw) => {
    const item = objectValue(raw);
    const rollbackPlan = objectValue(item.rollback_plan);
    const operation = stringValue(item.operation) || "unknown";
    return {
      id: stringValue(item.id),
      operation,
      autonomous_action: stringValue(item.autonomous_action) || "unknown",
      memory_class: stringValue(item.memory_class) || "unknown",
      cognitive_type: stringValue(item.cognitive_type) || "unknown",
      target_recall_policy: stringValue(item.target_recall_policy) || "unknown",
      storage_target: stringValue(item.storage_target) || "unknown",
      default_recall_allowed: item.default_recall_allowed === true,
      reasons: arrayValue(item.reasons).map((reason) => stringValue(reason)).filter(Boolean),
      signals: arrayValue(item.signals).map((signal) => stringValue(signal)).filter(Boolean),
      rollback_action: stringValue(rollbackPlan.action) || "restore_candidate_state",
      recommended_decision: safeCloseDecision(operation),
      apply_allowed: false as const,
    };
  }).filter((item) => item.id).sort((left, right) =>
    safeCloseOperationRank(left.operation) - safeCloseOperationRank(right.operation) ||
    left.id.localeCompare(right.id)
  );
  const humanReviewExclusions = arrayValue(objectValue(pendingSafeCloseSection.review_queue).excluded_for_human_review).map((raw) => {
    const item = objectValue(raw);
    return {
      id: stringValue(item.id),
      recommended_lane: stringValue(item.recommended_lane) || "unknown",
      reasons: arrayValue(item.reasons).map((reason) => stringValue(reason)).filter(Boolean),
      required_before_apply: arrayValue(item.required_before_apply).map((step) => stringValue(step)).filter(Boolean),
    };
  }).filter((item) => item.id).sort((left, right) =>
    pendingLaneRank(left.recommended_lane) - pendingLaneRank(right.recommended_lane) ||
    left.id.localeCompare(right.id)
  );
  const temporalReviewQueue = arrayValue(temporalValiditySection.candidates).map((raw) => {
    const item = objectValue(raw);
    const evidence = objectValue(item.evidence);
    const suggestedAction = stringValue(item.suggested_action) || "review_temporal_metadata";
    return {
      memory_id: stringValue(item.memory_id),
      scope: stringValue(item.scope) || "unknown",
      title: stringValue(item.title),
      content_preview: stringValue(item.content_preview),
      memory_type: stringValue(item.memory_type) || "unknown",
      memory_class: stringValue(item.memory_class) || "unknown",
      cognitive_type: stringValue(item.cognitive_type) || "unknown",
      recall_policy: stringValue(item.recall_policy) || "unknown",
      fact_status: stringValue(item.fact_status) || "unknown",
      reasons: arrayValue(item.reasons).map((reason) => stringValue(reason)).filter(Boolean),
      suggested_action: suggestedAction,
      suggested_recall_policy: stringValue(item.suggested_recall_policy) || "unknown",
      suggested_fact_status: stringValue(item.suggested_fact_status) || "unknown",
      blockers: arrayValue(item.blockers).map((blocker) => stringValue(blocker)).filter(Boolean),
      observed_at: stringValue(evidence.observed_at),
      review_at: stringValue(evidence.review_at),
      expires_at: stringValue(evidence.expires_at),
      updated_at: stringValue(evidence.updated_at),
      recommended_decision: temporalReviewDecision(suggestedAction),
    };
  }).filter((item) => item.memory_id).sort((left, right) =>
    temporalActionRank(left.suggested_action) - temporalActionRank(right.suggested_action) ||
    left.memory_id.localeCompare(right.memory_id)
  );
  const calibrationReviewQueue = arrayValue(adaptiveRetrievalSection.candidates).map((raw) => {
    const item = objectValue(raw);
    const decision = objectValue(item.threshold_decision);
    const action = stringValue(item.suggested_action) || stringValue(decision.action) || "hold";
    const lane = calibrationReviewLane(action);
    incrementCount(calibrationLaneCounts, lane.review_lane);
    return {
      scope_key: stringValue(item.scope_key) || "scope:unknown",
      query_type: stringValue(item.query_type) || "unknown",
      trace_count: numberValue(item.trace_count),
      empty_recall_rate: numberValue(item.empty_recall_rate),
      feedback_count: numberValue(item.feedback_count),
      negative_feedback_rate: numberValue(item.negative_feedback_rate),
      false_positive_count: numberValue(item.false_positive_count),
      avg_top1_distance: nullableNumberValue(item.avg_top1_distance),
      avg_top1_top2_gap: nullableNumberValue(item.avg_top1_top2_gap),
      avg_top1_rerank_score: nullableNumberValue(item.avg_top1_rerank_score),
      suggested_action: action,
      proposed_threshold_delta: stringValue(decision.proposed_threshold_delta) || "none",
      reason: stringValue(item.reason) || stringValue(decision.reason) || "unknown",
      sample_size_ok: decision.sample_size_ok === true,
      false_positive_guard_ok: decision.false_positive_guard_ok === true,
      eligible_for_apply: decision.eligible_for_apply === true,
      blockers: arrayValue(item.blockers).map((blocker) => stringValue(blocker)).filter(Boolean),
      ...lane,
      apply_allowed: false as const,
    };
  }).filter((item) => item.scope_key).sort((left, right) =>
    calibrationLaneRank(left.review_lane) - calibrationLaneRank(right.review_lane) ||
    right.trace_count - left.trace_count ||
    left.scope_key.localeCompare(right.scope_key)
  );
  const successorReviewQueue = arrayValue(objectValue(sections.graph_successor_discovery).candidates).map((raw) => {
    const item = objectValue(raw);
    const evidence = objectValue(item.evidence);
    const confidence = numberValue(item.confidence);
    const lane = successorReviewLane(stringValue(item.match_type), confidence);
    incrementCount(successorLaneCounts, lane.review_lane);
    return {
      candidate_id: stringValue(item.candidate_id),
      relation_id: stringValue(item.relation_id),
      relation_type: stringValue(item.relation_type),
      source_memory_id: stringValue(item.source_memory_id),
      old_target_memory_id: stringValue(item.old_target_memory_id),
      candidate_successor_memory_id: stringValue(item.candidate_successor_memory_id),
      suggested_repair_action: stringValue(item.suggested_repair_action),
      match_type: stringValue(item.match_type),
      confidence,
      scope: stringValue(evidence.scope),
      topic: stringValue(evidence.topic),
      shared_terms: arrayValue(evidence.shared_terms).map((term) => stringValue(term)).filter(Boolean),
      blockers: arrayValue(item.blockers).map((blocker) => stringValue(blocker)).filter(Boolean),
      ...lane,
    };
  }).sort((left, right) =>
    successorLaneRank(left.review_lane) - successorLaneRank(right.review_lane) ||
    right.confidence - left.confidence ||
    left.relation_id.localeCompare(right.relation_id)
  );
  const topicNormalizationSection = objectValue(sections.topic_normalization);
  const topicNormalizationReviewQueue = arrayValue(objectValue(topicNormalizationSection.review_queue).items).map((raw) => {
    const item = objectValue(raw);
    const evidence = objectValue(item.evidence);
    const priority = stringValue(item.priority) || "normal";
    incrementCount(topicNormalizationPriorityCounts, priority);
    return {
      priority,
      normalization_candidate_id: stringValue(item.normalization_candidate_id),
      alias_candidate_id: stringValue(item.alias_candidate_id),
      source_topic: stringValue(item.source_topic),
      canonical_topic: stringValue(item.canonical_topic),
      affected_memory_ids: arrayValue(item.affected_memory_ids).map((id) => stringValue(id)).filter(Boolean),
      affected_memory_count: numberValue(evidence.affected_memory_count),
      supporting_discoveries: numberValue(evidence.supporting_discoveries),
      avg_confidence: numberValue(evidence.avg_confidence),
      required_before_apply: arrayValue(item.required_before_apply).map((step) => stringValue(step)).filter(Boolean),
      recommended_action: stringValue(item.recommended_action),
      recommended_decision: "review_alias_scope_and_affected_samples" as const,
      apply_allowed: false as const,
    };
  }).sort((left, right) =>
    (left.priority === "high" ? 0 : 1) - (right.priority === "high" ? 0 : 1) ||
    right.supporting_discoveries - left.supporting_discoveries ||
    left.source_topic.localeCompare(right.source_topic)
  );
  const domainReadiness = arrayValue(readinessSummary.domains).map((raw) => {
    const domain = objectValue(raw);
    return {
      domain: stringValue(domain.domain) || "unknown",
      action_candidates: numberValue(domain.action_candidates),
      status: stringValue(domain.status) || "unknown",
      readiness_percent: numberValue(domain.readiness_percent),
      evidence_keys: arrayValue(domain.evidence_keys).map((key) => stringValue(key)).filter(Boolean),
      recommended_next_step: stringValue(domain.recommended_next_step),
      top_blockers: arrayValue(domain.top_blockers).map((blockerRaw) => {
        const blocker = objectValue(blockerRaw);
        return {
          source: stringValue(blocker.source) || "unknown",
          reason: stringValue(blocker.reason) || "unknown",
          action_candidates: numberValue(blocker.action_candidates),
          recommended_next_step: stringValue(blocker.recommended_next_step),
        };
      }),
    };
  });

  return {
    ok: true,
    generated_at: input.generated_at ?? new Date().toISOString(),
    mode: input.mode ?? "dry_run",
    report_only: true,
    apply_allowed: false,
    command_center: {
      prioritized_work: buildPrioritizedWork({
        lowestDomain: stringValue(summary.memory_os_lowest_readiness_domain) || "unknown",
        relationRepair: storageGraphRepair,
        graphOrphans: storageGraphOrphans,
        pendingTotal,
        safeClose,
        humanReview,
        temporalDebt,
        adaptiveCalibration,
      }),
    },
    debt_burndown: buildDebtBurndown({
      totalActionCandidates,
      relationRepair: storageGraphRepair,
      graphOrphans: storageGraphOrphans,
      pendingTotal,
      temporalDebt,
      adaptiveCalibration,
    }),
    readiness: {
      percent: readiness,
      lowest_domain: stringValue(summary.memory_os_lowest_readiness_domain) || "unknown",
      top_blockers: parseBlockers(summary.memory_os_top_blockers),
    },
    readiness_explainer: buildReadinessExplainer(domainReadiness),
    cards: [
      {
        id: "readiness",
        label: "Memory OS Readiness",
        value: readiness,
        unit: "%",
        severity: readinessSeverity(readiness),
        detail: `lowest=${stringValue(summary.memory_os_lowest_readiness_domain) || "unknown"}`,
      },
      {
        id: "pending_review",
        label: "Pending Review",
        value: pendingTotal,
        unit: "items",
        severity: pendingSeverity(pendingTotal),
        detail: `safe_close=${safeClose} human_review=${humanReview} keep_pending=${keepPending}`,
      },
      {
        id: "storage_graph_debt",
        label: "Storage Graph Debt",
        value: storageDebt,
        unit: "signals",
        severity: severityForDebt(storageDebt),
        detail: `graph_orphans=${storageGraphOrphans} relation_repair=${storageGraphRepair} topic_normalization=${topicNormalization}`,
      },
      {
        id: "temporal_update_debt",
        label: "Temporal / Update Debt",
        value: temporalDebt,
        unit: "signals",
        severity: severityForDebt(temporalDebt),
        detail: `temporal_validity=${numberValue(summary.temporal_validity_debt_candidates)} transitions=${numberValue(summary.temporal_transition_candidates)}`,
      },
    ],
    queues: {
      safe_close: queue("safe_close", "Safe Close Queue", safeClose, "Review evidence, then close low-risk pending candidates in small batches.", countItems(pendingSafeClose.by_operation)),
      human_review: queue("human_review", "Human Review Queue", humanReview, "Manually inspect scope, source, privacy, and temporal validity before approval or rejection."),
      keep_pending: queue("keep_pending", "Keep Pending", keepPending, "Leave these candidates open until more evidence is available."),
      graph_repair: queue("graph_repair", "Graph Repair Queue", storageGraphOrphans, "Resolve orphan relations, retarget successors, and archive invalid edges."),
      topic_normalization: queue("topic_normalization", "Topic Normalization Review", topicNormalization, "Review topic aliases and affected memory samples before canonical rewrites."),
    },
    domain_readiness: domainReadiness,
    storage_focus: {
      top_orphan_reasons: arrayValue(graphOrphanSummary.top_reasons).map((raw) => {
        const reason = objectValue(raw);
        return {
          reason: stringValue(reason.reason) || "unknown",
          count: numberValue(reason.count),
          suggested_action: stringValue(reason.suggested_action),
        };
      }),
      repair_actions: arrayValue(graphRepairSummary.top_actions).map((raw) => {
        const item = objectValue(raw);
        return {
          action: stringValue(item.action) || "unknown",
          count: numberValue(item.count),
        };
      }),
      repair_blockers: arrayValue(graphRepairSummary.top_review_blockers).map((raw) => {
        const item = objectValue(raw);
        return {
          blocker: stringValue(item.blocker) || "unknown",
          count: numberValue(item.count),
        };
      }),
      successor_match_types: countItems(graphSuccessorSummary.by_match_type),
      successor_alias_suggestions: arrayValue(graphSuccessorSummary.top_topic_alias_suggestions).map((raw) => {
        const item = objectValue(raw);
        return {
          source_topic: stringValue(item.source_topic),
          candidate_topic: stringValue(item.candidate_topic),
          count: numberValue(item.count),
        };
      }),
      successor_review_lanes: [...successorLaneCounts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => left.label.localeCompare(right.label)),
      orphan_review_lanes: [...orphanLaneCounts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => left.label.localeCompare(right.label)),
      orphan_review_queue: orphanReviewQueue,
      relation_repair_review_lanes: [...relationRepairLaneCounts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => left.label.localeCompare(right.label)),
      relation_repair_review_queue: relationRepairReviewQueue,
      successor_review_queue: successorReviewQueue,
      topic_normalization_priority_counts: [...topicNormalizationPriorityCounts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => left.label.localeCompare(right.label)),
      topic_normalization_review_queue: topicNormalizationReviewQueue,
    },
    update_focus: {
      temporal_reason_counts: countItems(temporalValiditySummary.by_reason),
      temporal_action_counts: countItems(temporalValiditySummary.by_suggested_action),
      temporal_review_queue: temporalReviewQueue,
    },
    retrieval_focus: {
      calibration_action_counts: countItems(
        Object.fromEntries(
          calibrationReviewQueue.reduce((entries, item) => {
            entries.set(item.suggested_action, (entries.get(item.suggested_action) ?? 0) + 1);
            return entries;
          }, new Map<string, number>()),
        ),
      ),
      calibration_review_lanes: [...calibrationLaneCounts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => left.label.localeCompare(right.label)),
      calibration_review_queue: calibrationReviewQueue,
    },
    governance_focus: {
      lanes: countItems(pendingEvidence.by_recommended_lane),
      signals: countItems(pendingEvidence.by_signal),
      safe_close_blockers: arrayValue(pendingSafeClose.blockers).map((item) => stringValue(item)).filter(Boolean),
      pending_review_queue: pendingReviewQueue,
      safe_close_queue: safeCloseQueue,
      human_review_exclusions: humanReviewExclusions,
    },
    storage_top_blockers: splitCsv(summary.memory_os_storage_top_blockers),
    next_actions: [
      action("review_human_pending", "Review human-required pending candidates", "TMPDIR=/tmp npm run memory:pending -- --limit=100", "Apply remains disabled until candidates are manually reviewed."),
      action("inspect_safe_close", "Inspect safe-close candidates", "TMPDIR=/tmp npm run memory:evolve -- --dry-run --limit=200 --days=7 --markdown", "Safe-close is report-only and needs an explicit batch review path."),
      action("repair_graph_debt", "Plan graph debt repair", "TMPDIR=/tmp npm run memory:evolve -- --dry-run --limit=200 --days=7 --markdown", "Graph repair candidates require successor and topic normalization review."),
      action("review_temporal_debt", "Review temporal validity debt", "TMPDIR=/tmp npm run memory:stale-fact-report", "Temporal updates need human review before fact status changes."),
    ],
    raw_summary: summary,
  };
}

function parseJsonObject(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("memory_evolve_json_not_found");
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
}

export async function buildMemoryOsDashboardFromEvolve(input: {
  readonly limit?: number;
  readonly days?: number;
} = {}): Promise<MemoryOsDashboardModel> {
  const limit = Math.max(1, Math.min(500, input.limit ?? 200));
  const days = Math.max(1, Math.min(90, input.days ?? 7));
  const result = await execFileAsync(
    "npm",
    ["run", "--silent", "memory:evolve", "--", "--dry-run", `--limit=${limit}`, `--days=${days}`, "--json"],
    {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: process.env.TMPDIR || "/tmp" },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return buildMemoryOsDashboardModel(parseJsonObject(result.stdout));
}
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
