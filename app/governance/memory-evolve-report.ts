import type { MemoryEvolveRuntimeModuleId } from "./memory-evolve-runtime-controls";

export type MemoryEvolveSectionStatus = "clean" | "needs_review" | "report_only";

export interface MemoryEvolveSection {
  readonly status: MemoryEvolveSectionStatus;
  readonly action_candidates: number;
  readonly summary: Record<string, unknown>;
  readonly candidates?: readonly unknown[];
  readonly review_queue?: unknown;
}

export interface MemoryEvolveReport {
  readonly ok: true;
  readonly mode: "dry_run" | "guarded_apply";
  readonly report_only: boolean;
  readonly generated_at: string;
  readonly apply_allowed: boolean;
  readonly blockers: readonly string[];
  readonly summary: {
    readonly sections: number;
    readonly total_action_candidates: number;
    readonly pending_total: number;
    readonly pending_autonomous_actions: number;
    readonly pending_keep_pending: number;
    readonly pending_evidence_items: number;
    readonly pending_evidence_actionable_without_human_review: number;
    readonly pending_evidence_requires_human_review: number;
    readonly pending_safe_close_candidates: number;
    readonly pending_safe_close_excluded_for_human_review: number;
    readonly stale_fact_candidates: number;
    readonly temporal_validity_debt_candidates: number;
    readonly temporal_validity_debt_production_candidates: number;
    readonly temporal_validity_debt_test_only_candidates: number;
    readonly temporal_transition_candidates: number;
    readonly memory_link_candidates: number;
    readonly graph_orphan_candidates: number;
    readonly graph_orphan_production_candidates: number;
    readonly graph_orphan_test_only_candidates: number;
    readonly graph_relation_repair_candidates: number;
    readonly graph_relation_repair_production_candidates: number;
    readonly graph_relation_repair_test_only_candidates: number;
    readonly graph_successor_discovery_candidates: number;
    readonly topic_alias_candidates: number;
    readonly topic_normalization_candidates: number;
    readonly topic_normalization_review_queue_candidates: number;
    readonly adaptive_calibration_cohorts: number;
    readonly adaptive_calibration_production_cohorts: number;
    readonly adaptive_calibration_production_actionable_cohorts: number;
    readonly adaptive_calibration_explicit_lookup_cohorts: number;
    readonly context_hygiene_candidates: number;
    readonly consolidation_candidates: number;
    readonly extraction_recall_mismatch_cohorts: number;
    readonly extraction_recall_candidates: number;
    readonly recall_feedback_candidates: number;
    readonly policy_feedback_backprop_candidates: number;
    readonly observation_reflection_candidates: number;
    readonly observation_review_queue_candidates: number;
    readonly procedural_promotion_candidates: number;
    readonly memory_os_readiness_candidates: number;
    readonly memory_os_overall_readiness_percent: number;
    readonly memory_os_lowest_readiness_domain: string;
    readonly memory_os_top_blockers: string;
    readonly memory_os_storage_top_blockers: string;
    readonly memory_os_storage_repair_top_actions: string;
    readonly memory_os_storage_repair_review_blockers: string;
    readonly memory_os_storage_successor_discovery_match_types: string;
    readonly memory_os_storage_successor_topic_aliases: string;
    readonly report_only: boolean;
  };
  readonly sections: {
    readonly pending_closure: MemoryEvolveSection;
    readonly pending_approval_evidence: MemoryEvolveSection;
    readonly pending_safe_close: MemoryEvolveSection;
    readonly stale_facts: MemoryEvolveSection;
    readonly temporal_validity_debt: MemoryEvolveSection;
    readonly temporal_transition_candidates: MemoryEvolveSection;
    readonly memory_link_candidates: MemoryEvolveSection;
    readonly graph_orphans: MemoryEvolveSection;
    readonly graph_relation_repair: MemoryEvolveSection;
    readonly graph_successor_discovery: MemoryEvolveSection;
    readonly topic_alias_candidates: MemoryEvolveSection;
    readonly topic_normalization: MemoryEvolveSection;
    readonly adaptive_retrieval: MemoryEvolveSection;
    readonly context_hygiene: MemoryEvolveSection;
    readonly consolidation: MemoryEvolveSection;
    readonly extraction_recall_eval: MemoryEvolveSection;
    readonly recall_quality_feedback: MemoryEvolveSection;
    readonly policy_feedback_backprop: MemoryEvolveSection;
    readonly observation_reflection: MemoryEvolveSection;
    readonly procedural_promotion: MemoryEvolveSection;
    readonly memory_os_readiness: MemoryEvolveSection;
  };
}

export interface BuildMemoryEvolveReportInput {
  readonly generatedAt?: string;
  readonly enabledModules?: Partial<Record<MemoryEvolveRuntimeModuleId, boolean>>;
  readonly pendingClosure?: {
    readonly summary?: Partial<{
      readonly total: number;
      readonly would_approve_default: number;
      readonly would_approve_explicit_issue: number;
      readonly would_reject_closed: number;
      readonly would_reject_sensitive: number;
      readonly would_reject_test_noise: number;
      readonly would_reject_unknown_source: number;
      readonly would_event_log_only: number;
      readonly would_keep_pending: number;
    }>;
  };
  readonly pendingApprovalEvidence?: {
    readonly summary?: Partial<{
      readonly total_rows: number;
      readonly total_evidence_items: number;
      readonly actionable_without_human_review: number;
      readonly requires_human_review: number;
      readonly report_only: boolean;
    }>;
    readonly candidates?: readonly unknown[];
  };
  readonly pendingSafeClose?: {
    readonly summary?: Partial<{
      readonly total_evidence_items: number;
      readonly safe_close_candidates: number;
      readonly excluded_for_human_review: number;
      readonly report_only: boolean;
      readonly apply_allowed: boolean;
    }>;
    readonly candidates?: readonly unknown[];
    readonly review_queue?: unknown;
  };
  readonly staleFacts?: {
    readonly summary?: Partial<{
      readonly total_rows: number;
      readonly total_candidates: number;
    }>;
  };
  readonly temporalValidityDebt?: {
    readonly summary?: Partial<{
      readonly total_rows: number;
      readonly total_candidates: number;
      readonly production_candidates: number;
      readonly test_only_candidates: number;
      readonly report_only: boolean;
    }>;
    readonly candidates?: readonly unknown[];
  };
  readonly temporalTransitionCandidates?: {
    readonly summary?: Partial<{
      readonly total_rows: number;
      readonly total_candidates: number;
      readonly report_only: boolean;
    }>;
  };
  readonly memoryLinkCandidates?: {
    readonly summary?: Partial<{
      readonly total_rows: number;
      readonly total_candidates: number;
      readonly report_only: boolean;
    }>;
  };
  readonly graphOrphans?: {
    readonly summary?: Partial<{
      readonly total_rows: number;
      readonly total_candidates: number;
      readonly production_candidates: number;
      readonly test_only_candidates: number;
      readonly top_reasons: readonly unknown[];
      readonly production_top_reasons: readonly unknown[];
      readonly report_only: boolean;
    }>;
    readonly candidates?: readonly unknown[];
  };
  readonly graphRelationRepair?: {
    readonly summary?: Partial<{
      readonly total_rows: number;
      readonly total_candidates: number;
      readonly production_candidates: number;
      readonly test_only_candidates: number;
      readonly top_actions: readonly unknown[];
      readonly production_top_actions: readonly unknown[];
      readonly top_review_blockers: readonly unknown[];
      readonly production_top_review_blockers: readonly unknown[];
      readonly report_only: boolean;
      readonly apply_allowed: boolean;
    }>;
    readonly candidates?: readonly unknown[];
  };
  readonly graphSuccessorDiscovery?: {
    readonly summary?: Partial<{
      readonly total_repairs: number;
      readonly total_candidates: number;
      readonly by_match_type: Record<string, number>;
      readonly top_topic_alias_suggestions: readonly unknown[];
      readonly report_only: boolean;
      readonly apply_allowed: boolean;
    }>;
    readonly candidates?: readonly unknown[];
  };
  readonly topicAliasCandidates?: {
    readonly summary?: Partial<{
      readonly total_discoveries: number;
      readonly total_candidates: number;
      readonly report_only: boolean;
      readonly apply_allowed: boolean;
    }>;
  };
  readonly topicNormalizationPlan?: {
    readonly summary?: Partial<{
      readonly total_aliases: number;
      readonly total_candidates: number;
      readonly review_queue_items: number;
      readonly report_only: boolean;
      readonly apply_allowed: boolean;
    }>;
    readonly candidates?: readonly unknown[];
    readonly review_queue?: unknown;
  };
  readonly adaptiveRetrieval?: {
    readonly summary?: Partial<{
      readonly traces: number;
      readonly feedback_events: number;
      readonly suspicious_feedback_events: number;
      readonly cohorts: number;
      readonly production_cohorts: number;
      readonly production_actionable_cohorts: number;
      readonly production_sampling_cohorts: number;
      readonly explicit_lookup_cohorts: number;
      readonly report_only: boolean;
    }>;
    readonly candidates?: readonly unknown[];
    readonly cohorts?: readonly unknown[];
  };
  readonly contextHygiene?: {
    readonly summary?: Partial<{
      readonly total_rows: number;
      readonly total_candidates: number;
    }>;
  };
  readonly consolidation?: {
    readonly summary?: Partial<{
      readonly total_candidates: number;
    }>;
  };
  readonly extractionRecallEval?: {
    readonly summary?: Partial<{
      readonly traces: number;
      readonly feedback_events: number;
      readonly suspicious_feedback_events: number;
      readonly cohorts: number;
      readonly false_null_cohorts: number;
      readonly mismatch_cohorts: number;
    }>;
    readonly candidates?: readonly unknown[];
  };
  readonly recallQualityFeedback?: {
    readonly summary?: Partial<{
      readonly traces: number;
      readonly feedback_events: number;
      readonly suspicious_feedback_events: number;
      readonly cohorts: number;
    }>;
    readonly candidates?: readonly unknown[];
  };
  readonly policyFeedbackBackprop?: {
    readonly summary?: Partial<{
      readonly total_candidates: number;
      readonly report_only: boolean;
      readonly apply_allowed: boolean;
    }>;
  };
  readonly observationReflection?: {
    readonly summary?: Partial<{
      readonly total_observations: number;
      readonly total_candidates: number;
      readonly review_queue_items: number;
      readonly retention_only_items: number;
      readonly actionable_review_items: number;
      readonly report_only: boolean;
    }>;
    readonly review_queue?: unknown;
  };
  readonly proceduralPromotion?: {
    readonly summary?: Partial<{
      readonly total_candidates: number;
      readonly report_only: boolean;
    }>;
  };
  readonly memoryOsReadiness?: {
    readonly summary?: Partial<{
      readonly capability_domains: number;
      readonly domains_with_debt: number;
      readonly total_action_candidates: number;
      readonly overall_readiness_percent: number;
      readonly lowest_readiness_domain: string;
      readonly top_blockers: readonly unknown[];
      readonly report_only: boolean;
      readonly apply_allowed: boolean;
    }>;
    readonly domains?: readonly unknown[];
  };
}

type PendingClosureActionKey =
  | "would_approve_default"
  | "would_approve_explicit_issue"
  | "would_reject_closed"
  | "would_reject_sensitive"
  | "would_reject_test_noise"
  | "would_reject_unknown_source"
  | "would_event_log_only";

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function section(
  summary: Record<string, unknown>,
  actionCandidates: number,
  reportOnly = false,
  candidates?: readonly unknown[],
  reviewQueue?: unknown,
): MemoryEvolveSection {
  const result: MemoryEvolveSection = {
    status: reportOnly ? "report_only" : actionCandidates > 0 ? "needs_review" : "clean",
    action_candidates: actionCandidates,
    summary,
  };
  return {
    ...result,
    ...(candidates ? { candidates } : {}),
    ...(reviewQueue ? { review_queue: reviewQueue } : {}),
  };
}

function evolveModuleEnabled(
  input: BuildMemoryEvolveReportInput,
  moduleId: MemoryEvolveRuntimeModuleId,
): boolean {
  return input.enabledModules?.[moduleId] === true;
}

function evolveModuleSummary(
  summary: Record<string, unknown>,
  enabled: boolean,
  actionCandidates: number,
): Record<string, unknown> {
  if (!enabled) return summary;
  return {
    ...summary,
    enabled: true,
    report_only: false,
    apply_allowed: false,
    apply_mode: actionCandidates > 0 ? "review_required_no_executor" : "armed_no_candidates",
  };
}

function enabledEvolveModuleIds(input: BuildMemoryEvolveReportInput): readonly MemoryEvolveRuntimeModuleId[] {
  return ([
    "context_hygiene",
    "consolidation",
    "extraction_recall_eval",
    "policy_feedback_backprop",
    "procedural_promotion",
  ] as const).filter((moduleId) => evolveModuleEnabled(input, moduleId));
}

function guardedApplyBlockers(sections: Record<string, MemoryEvolveSection>): readonly string[] {
  const blockers: string[] = [];
  for (const sectionName of [
    "context_hygiene",
    "consolidation",
    "extraction_recall_eval",
    "policy_feedback_backprop",
    "procedural_promotion",
  ]) {
    const applyMode = sections[sectionName]?.summary.apply_mode;
    if (applyMode === "review_required_no_executor") {
      blockers.push(`${sectionName}_review_required_no_executor`);
    }
  }
  if (sections.pending_approval_evidence.action_candidates > 0) {
    blockers.push("pending_evidence_requires_human_review");
  }
  if (sections.pending_safe_close.action_candidates > 0) {
    blockers.push("pending_safe_close_requires_human_review");
  }
  if (sections.observation_reflection.action_candidates > 0) {
    blockers.push("observation_reflection_requires_human_review");
  }
  if (sections.temporal_validity_debt.action_candidates > 0) {
    blockers.push("temporal_validity_debt_requires_human_review");
  }
  if (sections.temporal_transition_candidates.action_candidates > 0) {
    blockers.push("temporal_transition_requires_human_review");
  }
  if (sections.memory_link_candidates.action_candidates > 0) {
    blockers.push("memory_link_requires_human_review");
  }
  if (sections.graph_orphans.action_candidates > 0) {
    blockers.push("graph_orphans_requires_human_review");
  }
  if (sections.graph_relation_repair.action_candidates > 0) {
    blockers.push("graph_relation_repair_requires_human_review");
  }
  if (sections.adaptive_retrieval.action_candidates > 0) {
    blockers.push("adaptive_retrieval_guarded_plan_required");
  }
  return blockers;
}

function graphOrphanTopBlockersFromSummary(summary: Record<string, unknown>): string {
  const topReasons = Array.isArray(summary.top_reasons) ? summary.top_reasons : [];
  return topReasons
    .map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return "";
      const record = item as Record<string, unknown>;
      const reason = typeof record.reason === "string" ? record.reason : "";
      const count = numberValue(record.count);
      return reason ? `graph_orphan.${reason}:${count}` : "";
    })
    .filter(Boolean)
    .join(",");
}

function storageTopBlockersFromReadinessDomains(domains: readonly unknown[] | undefined): string {
  const storage = (domains ?? []).find((item) =>
    typeof item === "object" &&
    item !== null &&
    !Array.isArray(item) &&
    (item as Record<string, unknown>).domain === "storage"
  );
  if (typeof storage !== "object" || storage === null || Array.isArray(storage)) return "";
  const topBlockers = (storage as Record<string, unknown>).top_blockers;
  if (!Array.isArray(topBlockers)) return "";
  return topBlockers
    .map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return "";
      const record = item as Record<string, unknown>;
      const source = typeof record.source === "string" ? record.source : "";
      const reason = typeof record.reason === "string" ? record.reason : "";
      const count = numberValue(record.action_candidates);
      return source && reason ? `${source}.${reason}:${count}` : "";
    })
    .filter(Boolean)
    .join(",");
}

function graphRelationRepairTopActionsFromSummary(summary: Record<string, unknown>): string {
  const topActions = Array.isArray(summary.top_actions) ? summary.top_actions : [];
  return topActions
    .map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return "";
      const record = item as Record<string, unknown>;
      const action = typeof record.action === "string" ? record.action : "";
      const count = numberValue(record.count);
      return action ? `${action}:${count}` : "";
    })
    .filter(Boolean)
    .join(",");
}

function graphRelationRepairReviewBlockersFromSummary(summary: Record<string, unknown>): string {
  const topReviewBlockers = Array.isArray(summary.top_review_blockers) ? summary.top_review_blockers : [];
  return topReviewBlockers
    .map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return "";
      const record = item as Record<string, unknown>;
      const blocker = typeof record.blocker === "string" ? record.blocker : "";
      const count = numberValue(record.count);
      return blocker ? `${blocker}:${count}` : "";
    })
    .filter(Boolean)
    .join(",");
}

function successorDiscoveryMatchTypesFromSummary(summary: Record<string, unknown>): string {
  const byMatchType = typeof summary.by_match_type === "object" &&
    summary.by_match_type !== null &&
    !Array.isArray(summary.by_match_type)
    ? summary.by_match_type as Record<string, unknown>
    : {};
  return Object.entries(byMatchType)
    .map(([matchType, count]) => [matchType, numberValue(count)] as const)
    .filter(([, count]) => count > 0)
    .sort(([leftType, leftCount], [rightType, rightCount]) =>
      rightCount - leftCount ||
      leftType.localeCompare(rightType)
    )
    .map(([matchType, count]) => `${matchType}:${count}`)
    .join(",");
}

function successorDiscoveryTopicAliasesFromSummary(summary: Record<string, unknown>): string {
  const aliases = Array.isArray(summary.top_topic_alias_suggestions)
    ? summary.top_topic_alias_suggestions
    : [];
  return aliases
    .map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return "";
      const record = item as Record<string, unknown>;
      const sourceTopic = typeof record.source_topic === "string" ? record.source_topic : "";
      const candidateTopic = typeof record.candidate_topic === "string" ? record.candidate_topic : "";
      const count = numberValue(record.count);
      const pair = `${sourceTopic}->${candidateTopic}`;
      const renderedPair = pair.length > 80 ? `${pair.slice(0, 77)}...` : pair;
      return sourceTopic && candidateTopic && count > 0 ? `${renderedPair}:${count}` : "";
    })
    .filter(Boolean)
    .join(",");
}

export function rejectMemoryEvolveApply(argv: readonly string[]): void {
  if (argv.includes("--apply")) {
    throw new Error("memory:evolve apply is disabled; run --dry-run or use explicit plan-specific apply commands");
  }
}

export function buildMemoryEvolveReport(input: BuildMemoryEvolveReportInput = {}): MemoryEvolveReport {
  const pendingSummary = { ...(input.pendingClosure?.summary ?? {}) };
  const pendingTotal = numberValue(pendingSummary.total);
  const pendingKeepPending = numberValue(pendingSummary.would_keep_pending);
  const pendingAutonomousActionKeys: readonly PendingClosureActionKey[] = [
    "would_approve_default",
    "would_approve_explicit_issue",
    "would_reject_closed",
    "would_reject_sensitive",
    "would_reject_test_noise",
    "would_reject_unknown_source",
    "would_event_log_only",
  ];
  const pendingAutonomousActions = pendingAutonomousActionKeys
    .reduce((sum, key) => sum + numberValue(pendingSummary[key]), 0);

  const pendingEvidenceSummary = { ...(input.pendingApprovalEvidence?.summary ?? {}) };
  const pendingEvidenceItems = numberValue(pendingEvidenceSummary.total_evidence_items);
  const pendingEvidenceActionable = numberValue(pendingEvidenceSummary.actionable_without_human_review);
  const pendingEvidenceRequiresHumanReview = numberValue(pendingEvidenceSummary.requires_human_review);
  const pendingEvidenceActionCandidates = pendingEvidenceActionable + pendingEvidenceRequiresHumanReview;

  const pendingSafeCloseSummary = { ...(input.pendingSafeClose?.summary ?? {}) };
  const pendingSafeCloseCandidates = numberValue(pendingSafeCloseSummary.safe_close_candidates);
  const pendingSafeCloseExcluded = numberValue(pendingSafeCloseSummary.excluded_for_human_review);

  const staleSummary = { ...(input.staleFacts?.summary ?? {}) };
  const staleFactCandidates = numberValue(staleSummary.total_candidates);

  const temporalValiditySummary = { ...(input.temporalValidityDebt?.summary ?? {}) };
  const temporalValidityDebtCandidates = numberValue(temporalValiditySummary.total_candidates);
  const temporalValidityDebtProductionCandidates = numberValue(temporalValiditySummary.production_candidates);
  const temporalValidityDebtTestOnlyCandidates = numberValue(temporalValiditySummary.test_only_candidates);
  const temporalValidityDebtActionCandidates =
    "production_candidates" in temporalValiditySummary
      ? temporalValidityDebtProductionCandidates
      : temporalValidityDebtCandidates;

  const temporalTransitionSummary = { ...(input.temporalTransitionCandidates?.summary ?? {}) };
  const temporalTransitionCandidates = numberValue(temporalTransitionSummary.total_candidates);

  const memoryLinkSummary = { ...(input.memoryLinkCandidates?.summary ?? {}) };
  const memoryLinkCandidates = numberValue(memoryLinkSummary.total_candidates);

  const graphOrphanSummary = { ...(input.graphOrphans?.summary ?? {}) };
  const graphOrphanCandidates = numberValue(graphOrphanSummary.total_candidates);
  const graphOrphanProductionCandidates = numberValue(graphOrphanSummary.production_candidates);
  const graphOrphanTestOnlyCandidates = numberValue(graphOrphanSummary.test_only_candidates);
  const graphOrphanActionCandidates =
    "production_candidates" in graphOrphanSummary
      ? graphOrphanProductionCandidates
      : graphOrphanCandidates;
  const graphRelationRepairSummary = { ...(input.graphRelationRepair?.summary ?? {}) };
  const graphRelationRepairCandidates = numberValue(graphRelationRepairSummary.total_candidates);
  const graphRelationRepairProductionCandidates = numberValue(graphRelationRepairSummary.production_candidates);
  const graphRelationRepairTestOnlyCandidates = numberValue(graphRelationRepairSummary.test_only_candidates);
  const graphRelationRepairActionCandidates =
    "production_candidates" in graphRelationRepairSummary
      ? graphRelationRepairProductionCandidates
      : graphRelationRepairCandidates;
  const graphSuccessorDiscoverySummary = { ...(input.graphSuccessorDiscovery?.summary ?? {}) };
  const graphSuccessorDiscoveryCandidates = numberValue(graphSuccessorDiscoverySummary.total_candidates);
  const topicAliasSummary = { ...(input.topicAliasCandidates?.summary ?? {}) };
  const topicAliasCandidates = numberValue(topicAliasSummary.total_candidates);
  const topicNormalizationSummary = { ...(input.topicNormalizationPlan?.summary ?? {}) };
  const topicNormalizationCandidates = numberValue(topicNormalizationSummary.total_candidates);
  const topicNormalizationReviewQueueCandidates = numberValue(topicNormalizationSummary.review_queue_items);

  const adaptiveSummary = { ...(input.adaptiveRetrieval?.summary ?? {}) };
  const adaptiveCalibrationCohorts = numberValue(adaptiveSummary.cohorts);
  const adaptiveCalibrationProductionCohorts = numberValue(adaptiveSummary.production_cohorts);
  const adaptiveCalibrationProductionActionableCohorts = numberValue(
    adaptiveSummary.production_actionable_cohorts ?? adaptiveSummary.production_cohorts,
  );
  const adaptiveCalibrationActionCandidates =
    "production_actionable_cohorts" in adaptiveSummary
      ? adaptiveCalibrationProductionActionableCohorts
      : adaptiveCalibrationCohorts;
  const adaptiveCalibrationExplicitLookupCohorts = numberValue(adaptiveSummary.explicit_lookup_cohorts);

  const contextHygieneSummary = { ...(input.contextHygiene?.summary ?? {}) };
  const contextHygieneCandidates = numberValue(contextHygieneSummary.total_candidates);
  const contextHygieneEnabled = evolveModuleEnabled(input, "context_hygiene");
  const contextHygieneSectionSummary = evolveModuleSummary(
    contextHygieneSummary,
    contextHygieneEnabled,
    contextHygieneCandidates,
  );

  const consolidationSummary = { ...(input.consolidation?.summary ?? {}) };
  const consolidationCandidates = numberValue(consolidationSummary.total_candidates);
  const consolidationEnabled = evolveModuleEnabled(input, "consolidation");
  const consolidationSectionSummary = evolveModuleSummary(
    consolidationSummary,
    consolidationEnabled,
    consolidationCandidates,
  );

  const extractionSummary = { ...(input.extractionRecallEval?.summary ?? {}) };
  const extractionRecallMismatchCohorts = numberValue(extractionSummary.mismatch_cohorts);
  const extractionRecallCandidates = input.extractionRecallEval?.candidates?.length ?? 0;
  const extractionRecallEvalEnabled = evolveModuleEnabled(input, "extraction_recall_eval");
  const extractionSectionSummary = evolveModuleSummary(
    extractionSummary,
    extractionRecallEvalEnabled,
    extractionRecallMismatchCohorts,
  );

  const recallFeedbackSummary = { ...(input.recallQualityFeedback?.summary ?? {}) };
  const recallFeedbackCandidates = input.recallQualityFeedback?.candidates?.length ?? 0;

  const policyFeedbackBackpropSummary = { ...(input.policyFeedbackBackprop?.summary ?? {}) };
  const policyFeedbackBackpropCandidates = numberValue(policyFeedbackBackpropSummary.total_candidates);
  const policyFeedbackBackpropEnabled = evolveModuleEnabled(input, "policy_feedback_backprop");
  const policyFeedbackBackpropSectionSummary = evolveModuleSummary(
    policyFeedbackBackpropSummary,
    policyFeedbackBackpropEnabled,
    policyFeedbackBackpropCandidates,
  );

  const reflectionSummary = { ...(input.observationReflection?.summary ?? {}) };
  const observationReflectionCandidates = numberValue(reflectionSummary.total_candidates);
  const observationReviewQueueCandidates = numberValue(reflectionSummary.review_queue_items);
  const observationActionableReviewQueueCandidates =
    "actionable_review_items" in reflectionSummary
      ? numberValue(reflectionSummary.actionable_review_items)
      : observationReviewQueueCandidates;

  const promotionSummary = { ...(input.proceduralPromotion?.summary ?? {}) };
  const proceduralPromotionCandidates = numberValue(promotionSummary.total_candidates);
  const proceduralPromotionEnabled = evolveModuleEnabled(input, "procedural_promotion");
  const proceduralPromotionSectionSummary = evolveModuleSummary(
    promotionSummary,
    proceduralPromotionEnabled,
    proceduralPromotionCandidates,
  );

  const memoryOsReadinessSummary: Record<string, unknown> = { ...(input.memoryOsReadiness?.summary ?? {}) };
  if (input.memoryOsReadiness?.domains) {
    memoryOsReadinessSummary.domains = input.memoryOsReadiness.domains;
  }
  const memoryOsReadinessCandidates = numberValue(memoryOsReadinessSummary.total_action_candidates);
  const memoryOsOverallReadinessPercent = numberValue(memoryOsReadinessSummary.overall_readiness_percent);
  const memoryOsLowestReadinessDomain =
    typeof memoryOsReadinessSummary.lowest_readiness_domain === "string"
      ? memoryOsReadinessSummary.lowest_readiness_domain
      : "";
  const memoryOsTopBlockers = Array.isArray(memoryOsReadinessSummary.top_blockers)
    ? memoryOsReadinessSummary.top_blockers
        .map((item) => {
          if (typeof item !== "object" || item === null || Array.isArray(item)) return "";
          const record = item as Record<string, unknown>;
          const domain = typeof record.domain === "string" ? record.domain : "";
          const actionCandidates = numberValue(record.action_candidates);
          return domain ? `${domain}:${actionCandidates}` : "";
        })
        .filter(Boolean)
        .join(",")
    : "";
  const memoryOsStorageTopBlockers =
    storageTopBlockersFromReadinessDomains(input.memoryOsReadiness?.domains) ||
    graphOrphanTopBlockersFromSummary({
      ...graphOrphanSummary,
      top_reasons: graphOrphanSummary.production_top_reasons ?? graphOrphanSummary.top_reasons,
    });
  const memoryOsStorageRepairTopActions =
    graphRelationRepairTopActionsFromSummary({
      ...graphRelationRepairSummary,
      top_actions: graphRelationRepairSummary.production_top_actions ?? graphRelationRepairSummary.top_actions,
    });
  const memoryOsStorageRepairReviewBlockers =
    graphRelationRepairReviewBlockersFromSummary({
      ...graphRelationRepairSummary,
      top_review_blockers: graphRelationRepairSummary.production_top_review_blockers ?? graphRelationRepairSummary.top_review_blockers,
    });
  const memoryOsStorageSuccessorDiscoveryMatchTypes =
    successorDiscoveryMatchTypesFromSummary(graphSuccessorDiscoverySummary);
  const memoryOsStorageSuccessorTopicAliases =
    successorDiscoveryTopicAliasesFromSummary(graphSuccessorDiscoverySummary);

  const sections = {
    pending_closure: section(pendingSummary, pendingAutonomousActions),
    pending_approval_evidence: section(
      pendingEvidenceSummary,
      pendingEvidenceActionCandidates,
      true,
      input.pendingApprovalEvidence?.candidates,
    ),
    pending_safe_close: section(
      pendingSafeCloseSummary,
      pendingSafeCloseCandidates,
      true,
      input.pendingSafeClose?.candidates,
      input.pendingSafeClose?.review_queue,
    ),
    stale_facts: section(staleSummary, staleFactCandidates),
    temporal_validity_debt: section(
      temporalValiditySummary,
      temporalValidityDebtActionCandidates,
      true,
      input.temporalValidityDebt?.candidates,
    ),
    temporal_transition_candidates: section(temporalTransitionSummary, temporalTransitionCandidates, true),
    memory_link_candidates: section(memoryLinkSummary, memoryLinkCandidates, true),
    graph_orphans: section(
      graphOrphanSummary,
      graphOrphanActionCandidates,
      true,
      input.graphOrphans?.candidates,
    ),
    graph_relation_repair: section(
      graphRelationRepairSummary,
      graphRelationRepairActionCandidates,
      true,
      input.graphRelationRepair?.candidates,
    ),
    graph_successor_discovery: section(graphSuccessorDiscoverySummary, 0, true, input.graphSuccessorDiscovery?.candidates),
    topic_alias_candidates: section(topicAliasSummary, 0, true),
    topic_normalization: section(
      topicNormalizationSummary,
      0,
      true,
      input.topicNormalizationPlan?.candidates,
      input.topicNormalizationPlan?.review_queue,
    ),
    adaptive_retrieval: section(
      adaptiveSummary,
      adaptiveCalibrationActionCandidates,
      true,
      input.adaptiveRetrieval?.candidates ?? input.adaptiveRetrieval?.cohorts,
    ),
    context_hygiene: section(contextHygieneSectionSummary, contextHygieneCandidates, !contextHygieneEnabled),
    consolidation: section(consolidationSectionSummary, consolidationCandidates, !consolidationEnabled),
    extraction_recall_eval: section(
      extractionSectionSummary,
      extractionRecallMismatchCohorts,
      !extractionRecallEvalEnabled,
    ),
    recall_quality_feedback: section(recallFeedbackSummary, recallFeedbackCandidates, true),
    policy_feedback_backprop: section(
      policyFeedbackBackpropSectionSummary,
      policyFeedbackBackpropCandidates,
      !policyFeedbackBackpropEnabled,
    ),
    observation_reflection: section(
      reflectionSummary,
      observationReflectionCandidates + observationActionableReviewQueueCandidates,
      true,
      undefined,
      input.observationReflection?.review_queue,
    ),
    procedural_promotion: section(
      proceduralPromotionSectionSummary,
      proceduralPromotionCandidates,
      !proceduralPromotionEnabled,
    ),
    memory_os_readiness: section(memoryOsReadinessSummary, memoryOsReadinessCandidates, true),
  };
  const totalActionCandidates = Object.values(sections)
    .filter((_, index) => Object.keys(sections)[index] !== "memory_os_readiness")
    .reduce((sum, item) => sum + item.action_candidates, 0);
  const guardedApplyMode = enabledEvolveModuleIds(input).length > 0;
  const blockers = guardedApplyMode ? guardedApplyBlockers(sections) : ["report_only"];
  const applyAllowed = guardedApplyMode && blockers.length === 0;

  return {
    ok: true,
    mode: guardedApplyMode ? "guarded_apply" : "dry_run",
    report_only: !guardedApplyMode,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    apply_allowed: applyAllowed,
    blockers,
    summary: {
      sections: Object.keys(sections).length,
      total_action_candidates: totalActionCandidates,
      pending_total: pendingTotal,
      pending_autonomous_actions: pendingAutonomousActions,
      pending_keep_pending: pendingKeepPending,
      pending_evidence_items: pendingEvidenceItems,
      pending_evidence_actionable_without_human_review: pendingEvidenceActionable,
      pending_evidence_requires_human_review: pendingEvidenceRequiresHumanReview,
      pending_safe_close_candidates: pendingSafeCloseCandidates,
      pending_safe_close_excluded_for_human_review: pendingSafeCloseExcluded,
      stale_fact_candidates: staleFactCandidates,
      temporal_validity_debt_candidates: temporalValidityDebtCandidates,
      temporal_validity_debt_production_candidates: temporalValidityDebtProductionCandidates,
      temporal_validity_debt_test_only_candidates: temporalValidityDebtTestOnlyCandidates,
      temporal_transition_candidates: temporalTransitionCandidates,
      memory_link_candidates: memoryLinkCandidates,
      graph_orphan_candidates: graphOrphanCandidates,
      graph_orphan_production_candidates: graphOrphanProductionCandidates,
      graph_orphan_test_only_candidates: graphOrphanTestOnlyCandidates,
      graph_relation_repair_candidates: graphRelationRepairCandidates,
      graph_relation_repair_production_candidates: graphRelationRepairProductionCandidates,
      graph_relation_repair_test_only_candidates: graphRelationRepairTestOnlyCandidates,
      graph_successor_discovery_candidates: graphSuccessorDiscoveryCandidates,
      topic_alias_candidates: topicAliasCandidates,
      topic_normalization_candidates: topicNormalizationCandidates,
      topic_normalization_review_queue_candidates: topicNormalizationReviewQueueCandidates,
      adaptive_calibration_cohorts: adaptiveCalibrationCohorts,
      adaptive_calibration_production_cohorts: adaptiveCalibrationProductionCohorts,
      adaptive_calibration_production_actionable_cohorts: adaptiveCalibrationProductionActionableCohorts,
      adaptive_calibration_explicit_lookup_cohorts: adaptiveCalibrationExplicitLookupCohorts,
      context_hygiene_candidates: contextHygieneCandidates,
      consolidation_candidates: consolidationCandidates,
      extraction_recall_mismatch_cohorts: extractionRecallMismatchCohorts,
      extraction_recall_candidates: extractionRecallCandidates,
      recall_feedback_candidates: recallFeedbackCandidates,
      policy_feedback_backprop_candidates: policyFeedbackBackpropCandidates,
      observation_reflection_candidates: observationReflectionCandidates,
      observation_review_queue_candidates: observationActionableReviewQueueCandidates,
      procedural_promotion_candidates: proceduralPromotionCandidates,
      memory_os_readiness_candidates: memoryOsReadinessCandidates,
      memory_os_overall_readiness_percent: memoryOsOverallReadinessPercent,
      memory_os_lowest_readiness_domain: memoryOsLowestReadinessDomain,
      memory_os_top_blockers: memoryOsTopBlockers,
      memory_os_storage_top_blockers: memoryOsStorageTopBlockers,
      memory_os_storage_repair_top_actions: memoryOsStorageRepairTopActions,
      memory_os_storage_repair_review_blockers: memoryOsStorageRepairReviewBlockers,
      memory_os_storage_successor_discovery_match_types: memoryOsStorageSuccessorDiscoveryMatchTypes,
      memory_os_storage_successor_topic_aliases: memoryOsStorageSuccessorTopicAliases,
      report_only: !guardedApplyMode,
    },
    sections,
  };
}

function markdownTable(rows: readonly (readonly [string, string | number | boolean])[]): string {
  return [
    "| key | value |",
    "| --- | ---: |",
    ...rows.map(([key, value]) => `| ${key} | ${String(value)} |`),
  ].join("\n");
}

export function renderMemoryEvolveMarkdown(report: MemoryEvolveReport): string {
  const summaryRows: readonly (readonly [string, string | number | boolean])[] = [
    ["sections", report.summary.sections],
    ["total_action_candidates", report.summary.total_action_candidates],
    ["pending_total", report.summary.pending_total],
    ["pending_autonomous_actions", report.summary.pending_autonomous_actions],
    ["pending_keep_pending", report.summary.pending_keep_pending],
    ["pending_evidence_items", report.summary.pending_evidence_items],
    ["pending_evidence_actionable_without_human_review", report.summary.pending_evidence_actionable_without_human_review],
    ["pending_evidence_requires_human_review", report.summary.pending_evidence_requires_human_review],
    ["pending_safe_close_candidates", report.summary.pending_safe_close_candidates],
    ["pending_safe_close_excluded_for_human_review", report.summary.pending_safe_close_excluded_for_human_review],
    ["stale_fact_candidates", report.summary.stale_fact_candidates],
    ["temporal_validity_debt_candidates", report.summary.temporal_validity_debt_candidates],
    ["temporal_validity_debt_production_candidates", report.summary.temporal_validity_debt_production_candidates],
    ["temporal_validity_debt_test_only_candidates", report.summary.temporal_validity_debt_test_only_candidates],
    ["temporal_transition_candidates", report.summary.temporal_transition_candidates],
    ["memory_link_candidates", report.summary.memory_link_candidates],
    ["graph_orphan_candidates", report.summary.graph_orphan_candidates],
    ["graph_orphan_production_candidates", report.summary.graph_orphan_production_candidates],
    ["graph_orphan_test_only_candidates", report.summary.graph_orphan_test_only_candidates],
    ["graph_relation_repair_candidates", report.summary.graph_relation_repair_candidates],
    ["graph_relation_repair_production_candidates", report.summary.graph_relation_repair_production_candidates],
    ["graph_relation_repair_test_only_candidates", report.summary.graph_relation_repair_test_only_candidates],
    ["graph_successor_discovery_candidates", report.summary.graph_successor_discovery_candidates],
    ["topic_alias_candidates", report.summary.topic_alias_candidates],
    ["topic_normalization_candidates", report.summary.topic_normalization_candidates],
    ["topic_normalization_review_queue_candidates", report.summary.topic_normalization_review_queue_candidates],
    ["adaptive_calibration_cohorts", report.summary.adaptive_calibration_cohorts],
    ["adaptive_calibration_production_cohorts", report.summary.adaptive_calibration_production_cohorts],
    ["adaptive_calibration_production_actionable_cohorts", report.summary.adaptive_calibration_production_actionable_cohorts],
    ["adaptive_calibration_explicit_lookup_cohorts", report.summary.adaptive_calibration_explicit_lookup_cohorts],
    ["context_hygiene_candidates", report.summary.context_hygiene_candidates],
    ["consolidation_candidates", report.summary.consolidation_candidates],
    ["extraction_recall_mismatch_cohorts", report.summary.extraction_recall_mismatch_cohorts],
    ["extraction_recall_candidates", report.summary.extraction_recall_candidates],
    ["recall_feedback_candidates", report.summary.recall_feedback_candidates],
    ["policy_feedback_backprop_candidates", report.summary.policy_feedback_backprop_candidates],
    ["observation_reflection_candidates", report.summary.observation_reflection_candidates],
    ["observation_review_queue_candidates", report.summary.observation_review_queue_candidates],
    ["procedural_promotion_candidates", report.summary.procedural_promotion_candidates],
    ["memory_os_readiness_candidates", report.summary.memory_os_readiness_candidates],
    ["memory_os_overall_readiness_percent", report.summary.memory_os_overall_readiness_percent],
    ["memory_os_lowest_readiness_domain", report.summary.memory_os_lowest_readiness_domain],
    ["memory_os_top_blockers", report.summary.memory_os_top_blockers],
    ["memory_os_storage_top_blockers", report.summary.memory_os_storage_top_blockers],
    ["memory_os_storage_repair_top_actions", report.summary.memory_os_storage_repair_top_actions],
    ["memory_os_storage_repair_review_blockers", report.summary.memory_os_storage_repair_review_blockers],
    ["memory_os_storage_successor_discovery_match_types", report.summary.memory_os_storage_successor_discovery_match_types],
    ["memory_os_storage_successor_topic_aliases", report.summary.memory_os_storage_successor_topic_aliases],
  ];
  const sectionRows = Object.entries(report.sections)
    .map(([name, sectionValue]) => `| ${name} | ${sectionValue.status} | ${sectionValue.action_candidates} |`);
  return [
    "# memory:evolve dry-run report",
    "",
    `generated_at: ${report.generated_at}`,
    `mode: ${report.mode}`,
    `report_only: ${report.report_only}`,
    `apply_allowed: ${report.apply_allowed}`,
    `blockers: ${report.blockers.join(", ")}`,
    "",
    "## Summary",
    "",
    markdownTable(summaryRows),
    "",
    "## Sections",
    "",
    "| section | status | action_candidates |",
    "| --- | --- | ---: |",
    ...sectionRows,
    "",
  ].join("\n");
}
