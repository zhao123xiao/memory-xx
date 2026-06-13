export type MemoryOsCapabilityDomain =
  | "storage"
  | "update"
  | "retrieval"
  | "governance"
  | "maintenance";

export interface MemoryOsReadinessSectionInput {
  readonly pendingSafeCloseCandidates?: number;
  readonly pendingRequiresHumanReview?: number;
  readonly temporalValidityDebtCandidates?: number;
  readonly temporalTransitionCandidates?: number;
  readonly memoryLinkCandidates?: number;
  readonly graphOrphanCandidates?: number;
  readonly graphOrphanProductionCandidates?: number;
  readonly graphRelationRepairCandidates?: number;
  readonly graphRelationRepairProductionCandidates?: number;
  readonly graphRelationRepairTopActions?: readonly {
    readonly action: string;
    readonly count: number;
  }[];
  readonly graphRelationRepairProductionTopActions?: readonly {
    readonly action: string;
    readonly count: number;
  }[];
  readonly topicNormalizationReviewQueueCandidates?: number;
  readonly graphOrphanTopReasons?: readonly {
    readonly reason: string;
    readonly count: number;
    readonly suggested_action: string;
  }[];
  readonly graphOrphanProductionTopReasons?: readonly {
    readonly reason: string;
    readonly count: number;
    readonly suggested_action: string;
  }[];
  readonly adaptiveCalibrationCohorts?: number;
  readonly contextHygieneCandidates?: number;
  readonly consolidationCandidates?: number;
  readonly extractionRecallCandidates?: number;
  readonly recallFeedbackCandidates?: number;
  readonly policyFeedbackBackpropCandidates?: number;
  readonly observationReflectionCandidates?: number;
  readonly observationReviewQueueCandidates?: number;
  readonly proceduralPromotionCandidates?: number;
}

export interface MemoryOsReadinessDomainBlocker {
  readonly source: string;
  readonly reason: string;
  readonly action_candidates: number;
  readonly recommended_next_step: string;
}

export interface MemoryOsReadinessDomain {
  readonly domain: MemoryOsCapabilityDomain;
  readonly action_candidates: number;
  readonly status: "clean" | "needs_attention";
  readonly readiness_percent: number;
  readonly evidence_keys: readonly string[];
  readonly top_blockers: readonly MemoryOsReadinessDomainBlocker[];
  readonly recommended_next_step: string;
}

export interface MemoryOsReadinessBlocker {
  readonly domain: MemoryOsCapabilityDomain;
  readonly action_candidates: number;
  readonly readiness_percent: number;
  readonly recommended_next_step: string;
}

export interface MemoryOsReadinessReport {
  readonly ok: true;
  readonly generated_at: string;
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly summary: {
    readonly capability_domains: number;
    readonly domains_with_debt: number;
    readonly total_action_candidates: number;
    readonly raw_debt_signals: number;
    readonly overall_readiness_percent: number;
    readonly lowest_readiness_domain: MemoryOsCapabilityDomain;
    readonly top_blockers: readonly MemoryOsReadinessBlocker[];
    readonly report_only: true;
    readonly apply_allowed: false;
  };
  readonly domains: readonly MemoryOsReadinessDomain[];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function readinessPercent(actionCandidates: number): number {
  if (actionCandidates <= 0) return 100;
  const penalty = Math.min(80, Math.ceil(Math.log2(actionCandidates + 1) * 18));
  return Math.max(0, 100 - penalty);
}

function domain(
  domainName: MemoryOsCapabilityDomain,
  actionCandidates: number,
  evidenceKeys: readonly string[],
  recommendedNextStep: string,
  topBlockers: readonly MemoryOsReadinessDomainBlocker[] = [],
): MemoryOsReadinessDomain {
  return {
    domain: domainName,
    action_candidates: actionCandidates,
    status: actionCandidates > 0 ? "needs_attention" : "clean",
    readiness_percent: readinessPercent(actionCandidates),
    evidence_keys: evidenceKeys,
    top_blockers: topBlockers,
    recommended_next_step: recommendedNextStep,
  };
}

function graphOrphanBlockers(
  topReasons: MemoryOsReadinessSectionInput["graphOrphanTopReasons"],
): readonly MemoryOsReadinessDomainBlocker[] {
  return (topReasons ?? [])
    .filter((item) => numberValue(item.count) > 0 && item.reason.trim())
    .map((item) => ({
      source: "graph_orphan",
      reason: item.reason,
      action_candidates: numberValue(item.count),
      recommended_next_step: item.suggested_action,
    }));
}

function graphRelationRepairBlockers(
  topActions: MemoryOsReadinessSectionInput["graphRelationRepairTopActions"],
): readonly MemoryOsReadinessDomainBlocker[] {
  return (topActions ?? [])
    .filter((item) => numberValue(item.count) > 0 && item.action.trim())
    .map((item) => ({
      source: "graph_relation_repair",
      reason: item.action,
      action_candidates: numberValue(item.count),
      recommended_next_step: item.action,
    }));
}

function topicNormalizationReviewBlockers(count: number): readonly MemoryOsReadinessDomainBlocker[] {
  return count > 0
    ? [{
        source: "topic_normalization_review",
        reason: "review_topic_normalization",
        action_candidates: count,
        recommended_next_step: "review topic aliases before canonical topic rewrites",
      }]
    : [];
}

export function buildMemoryOsReadinessReport(
  input: MemoryOsReadinessSectionInput,
  generatedAt?: string,
): MemoryOsReadinessReport {
  const graphOrphanDebt = input.graphOrphanProductionCandidates === undefined
    ? numberValue(input.graphOrphanCandidates)
    : numberValue(input.graphOrphanProductionCandidates);
  const storageDebt =
    graphOrphanDebt +
    numberValue(input.memoryLinkCandidates) +
    numberValue(input.topicNormalizationReviewQueueCandidates);
  const updateDebt =
    numberValue(input.temporalValidityDebtCandidates) +
    numberValue(input.temporalTransitionCandidates) +
    numberValue(input.consolidationCandidates) +
    numberValue(input.observationReflectionCandidates) +
    numberValue(input.observationReviewQueueCandidates);
  const retrievalDebt =
    numberValue(input.adaptiveCalibrationCohorts) +
    numberValue(input.contextHygieneCandidates);
  const governanceDebt =
    numberValue(input.pendingSafeCloseCandidates) +
    numberValue(input.pendingRequiresHumanReview) +
    numberValue(input.observationReviewQueueCandidates) +
    numberValue(input.policyFeedbackBackpropCandidates) +
    numberValue(input.proceduralPromotionCandidates);
  const maintenanceDebt =
    numberValue(input.extractionRecallCandidates) +
    numberValue(input.recallFeedbackCandidates) +
    numberValue(input.policyFeedbackBackpropCandidates);

  const domains: MemoryOsReadinessDomain[] = [
    domain(
      "storage",
      storageDebt,
      [
        input.graphOrphanProductionCandidates === undefined ? "graph_orphan_candidates" : "graph_orphan_production_candidates",
        input.graphRelationRepairProductionCandidates === undefined
          ? "graph_relation_repair_candidates"
          : "graph_relation_repair_production_candidates",
        "memory_link_candidates",
        "topic_normalization_review_queue_candidates",
      ],
      "close graph structuring debt before treating graph recall as a primary context source",
      [
        ...graphOrphanBlockers(input.graphOrphanProductionTopReasons ?? input.graphOrphanTopReasons),
        ...graphRelationRepairBlockers(input.graphRelationRepairProductionTopActions ?? input.graphRelationRepairTopActions),
        ...topicNormalizationReviewBlockers(numberValue(input.topicNormalizationReviewQueueCandidates)),
      ].sort((left, right) =>
        right.action_candidates - left.action_candidates ||
        left.source.localeCompare(right.source) ||
        left.reason.localeCompare(right.reason)
      ).slice(0, 5),
    ),
    domain(
      "update",
      updateDebt,
      [
        "temporal_validity_debt_candidates",
        "temporal_transition_candidates",
        "consolidation_candidates",
        "observation_reflection_candidates",
        "observation_review_queue_candidates",
      ],
      "convert transient observations into governed semantic/procedural candidates with temporal metadata",
    ),
    domain(
      "retrieval",
      retrievalDebt,
      ["adaptive_calibration_cohorts", "context_hygiene_candidates"],
      "calibrate per-scope retrieval thresholds and keep default context free of episodic noise",
    ),
    domain(
      "governance",
      governanceDebt,
      [
        "pending_safe_close_candidates",
        "pending_evidence_requires_human_review",
        "policy_feedback_backprop_candidates",
        "procedural_promotion_candidates",
      ],
      "keep production apply gated while pending closure and cross-scope promotion remain review-bound",
    ),
    domain(
      "maintenance",
      maintenanceDebt,
      ["extraction_recall_candidates", "recall_feedback_candidates", "policy_feedback_backprop_candidates"],
      "feed recall and extraction quality evidence back into policy and extractor evaluation loops",
    ),
  ];

  const domainsWithDebt = domains.filter((item) => item.action_candidates > 0).length;
  const rawDebtSignals = domains.reduce((sum, item) => sum + item.action_candidates, 0);
  const overallReadinessPercent = Math.round(
    domains.reduce((sum, item) => sum + item.readiness_percent, 0) / Math.max(1, domains.length),
  );
  const lowestReadinessDomain = [...domains]
    .sort((left, right) =>
      left.readiness_percent - right.readiness_percent ||
      right.action_candidates - left.action_candidates ||
      left.domain.localeCompare(right.domain)
    )[0]?.domain ?? "storage";
  const topBlockers = domains
    .filter((item) => item.action_candidates > 0)
    .sort((left, right) =>
      right.action_candidates - left.action_candidates ||
      left.readiness_percent - right.readiness_percent ||
      left.domain.localeCompare(right.domain)
    )
    .slice(0, 3)
    .map((item): MemoryOsReadinessBlocker => ({
      domain: item.domain,
      action_candidates: item.action_candidates,
      readiness_percent: item.readiness_percent,
      recommended_next_step: item.recommended_next_step,
    }));
  return {
    ok: true,
    generated_at: generatedAt ?? new Date().toISOString(),
    report_only: true,
    apply_allowed: false,
    summary: {
      capability_domains: domains.length,
      domains_with_debt: domainsWithDebt,
      total_action_candidates: domainsWithDebt,
      raw_debt_signals: rawDebtSignals,
      overall_readiness_percent: overallReadinessPercent,
      lowest_readiness_domain: lowestReadinessDomain,
      top_blockers: topBlockers,
      report_only: true,
      apply_allowed: false,
    },
    domains,
  };
}
