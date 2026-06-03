export interface ProductionCanaryFeedbackWindow {
  readonly total_real_decisions: number;
  readonly auto_approved_default: number;
  readonly auto_approved_explicit_issue: number;
  readonly auto_rejected_unknown: number;
  readonly auto_rejected_test_noise: number;
  readonly auto_rejected_sensitive: number;
  readonly rollback_count: number;
  readonly false_positive_count: number;
  readonly false_negative_count: number;
  readonly default_leakage: number;
  readonly explicit_only_default_recall_leakage: number;
  readonly test_noise_default_recall_leakage: number;
  readonly unknown_sensitive_or_test_noise_auto_approve: number;
  readonly unmarked_real_decisions_excluded: number;
}

export interface ProductionCanaryRuntimeSnapshot {
  readonly pending_current: number;
  readonly qdrant_drift: number;
}

export interface CandidateOnlyExitReadinessInput {
  readonly candidateOnlyEnabled: boolean;
  readonly productionGuardOk: boolean;
  readonly consecutiveP1PassDays: number;
  readonly minRealFeedbackSamples?: number;
  readonly maxRollbackRate?: number;
  readonly window7d: ProductionCanaryFeedbackWindow;
  readonly runtime: ProductionCanaryRuntimeSnapshot;
}

export interface CandidateOnlyExitReadiness {
  readonly ready: boolean;
  readonly candidate_only_exit_ready: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly metrics: {
    readonly total_real_decisions_7d: number;
    readonly approved_count_7d: number;
    readonly rollback_rate_7d: number;
    readonly consecutive_p1_pass_days: number;
    readonly min_real_feedback_samples: number;
    readonly max_rollback_rate: number;
  };
}

export interface ProductionCanaryUpdateDryRunSummary {
  readonly scope: string;
  readonly candidate_count: number;
  readonly action_counts: Record<string, number>;
  readonly wrong_scope_count: number;
  readonly default_recall_leakage: number;
}

export interface ProductionCanaryFeedbackReportInput {
  readonly runId: string;
  readonly generatedAt?: string;
  readonly candidateOnlyEnabled: boolean;
  readonly productionGuardOk: boolean;
  readonly consecutiveP1PassDays: number;
  readonly minRealFeedbackSamples?: number;
  readonly maxRollbackRate?: number;
  readonly windows: {
    readonly last_24h: ProductionCanaryFeedbackWindow;
    readonly last_7d: ProductionCanaryFeedbackWindow;
  };
  readonly runtime: ProductionCanaryRuntimeSnapshot;
  readonly updateDryRun?: ProductionCanaryUpdateDryRunSummary | null;
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function emptyProductionCanaryFeedbackWindow(): ProductionCanaryFeedbackWindow {
  return {
    total_real_decisions: 0,
    auto_approved_default: 0,
    auto_approved_explicit_issue: 0,
    auto_rejected_unknown: 0,
    auto_rejected_test_noise: 0,
    auto_rejected_sensitive: 0,
    rollback_count: 0,
    false_positive_count: 0,
    false_negative_count: 0,
    default_leakage: 0,
    explicit_only_default_recall_leakage: 0,
    test_noise_default_recall_leakage: 0,
    unknown_sensitive_or_test_noise_auto_approve: 0,
    unmarked_real_decisions_excluded: 0,
  };
}

export function buildCandidateOnlyExitReadiness(input: CandidateOnlyExitReadinessInput): CandidateOnlyExitReadiness {
  const minRealFeedbackSamples = input.minRealFeedbackSamples ?? 20;
  const maxRollbackRate = input.maxRollbackRate ?? 0.03;
  const approvedCount = nonNegative(input.window7d.auto_approved_default) + nonNegative(input.window7d.auto_approved_explicit_issue);
  const rollbackRate = approvedCount > 0 ? nonNegative(input.window7d.rollback_count) / approvedCount : 0;
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!input.productionGuardOk) blockers.push("production_guard_failed");
  if (nonNegative(input.window7d.unmarked_real_decisions_excluded) > 0) {
    blockers.push(`production_canary_feedback_not_instrumented:${nonNegative(input.window7d.unmarked_real_decisions_excluded)}`);
  }
  if (nonNegative(input.window7d.total_real_decisions) < minRealFeedbackSamples) {
    blockers.push(`insufficient_real_feedback:${nonNegative(input.window7d.total_real_decisions)}/${minRealFeedbackSamples}`);
  }
  if (input.consecutiveP1PassDays < 7) blockers.push(`p1_gate_not_stable:${input.consecutiveP1PassDays}/7`);
  if (nonNegative(input.runtime.pending_current) !== 0) blockers.push(`pending_backlog_nonzero:${nonNegative(input.runtime.pending_current)}`);
  if (nonNegative(input.runtime.qdrant_drift) !== 0) blockers.push(`qdrant_drift_nonzero:${nonNegative(input.runtime.qdrant_drift)}`);
  const leakage = nonNegative(input.window7d.default_leakage)
    + nonNegative(input.window7d.explicit_only_default_recall_leakage)
    + nonNegative(input.window7d.test_noise_default_recall_leakage);
  if (leakage !== 0) blockers.push(`leakage_nonzero:${leakage}`);
  if (nonNegative(input.window7d.unknown_sensitive_or_test_noise_auto_approve) !== 0) {
    blockers.push(`unknown_sensitive_or_test_noise_auto_approve:${nonNegative(input.window7d.unknown_sensitive_or_test_noise_auto_approve)}`);
  }
  if (rollbackRate > maxRollbackRate) blockers.push(`rollback_rate_high:${rollbackRate.toFixed(4)}/${maxRollbackRate}`);
  if (!input.candidateOnlyEnabled) warnings.push("candidate_only_already_disabled");
  if (nonNegative(input.window7d.false_negative_count) > 0) warnings.push(`false_negative_feedback_observed:${nonNegative(input.window7d.false_negative_count)}`);

  const ready = blockers.length === 0;
  return {
    ready,
    candidate_only_exit_ready: ready,
    blockers,
    warnings,
    metrics: {
      total_real_decisions_7d: nonNegative(input.window7d.total_real_decisions),
      approved_count_7d: approvedCount,
      rollback_rate_7d: rollbackRate,
      consecutive_p1_pass_days: input.consecutiveP1PassDays,
      min_real_feedback_samples: minRealFeedbackSamples,
      max_rollback_rate: maxRollbackRate,
    },
  };
}

export function buildProductionCanaryFeedbackReport(input: ProductionCanaryFeedbackReportInput) {
  const readiness = buildCandidateOnlyExitReadiness({
    candidateOnlyEnabled: input.candidateOnlyEnabled,
    productionGuardOk: input.productionGuardOk,
    consecutiveP1PassDays: input.consecutiveP1PassDays,
    minRealFeedbackSamples: input.minRealFeedbackSamples,
    maxRollbackRate: input.maxRollbackRate,
    window7d: input.windows.last_7d,
    runtime: input.runtime,
  });
  const updateDryRun = input.updateDryRun ?? {
    scope: "project:memory-xx",
    candidate_count: 0,
    action_counts: {},
    wrong_scope_count: 0,
    default_recall_leakage: 0,
  };
  const updateTrialOk = updateDryRun.scope === "project:memory-xx"
    && updateDryRun.wrong_scope_count === 0
    && updateDryRun.default_recall_leakage === 0;
  return {
    ok: readiness.ready && updateTrialOk,
    run_id: input.runId,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    windows: input.windows,
    runtime: input.runtime,
    candidate_only_exit_readiness: readiness,
    update_supersede_trial: {
      mode: "dry_run_only" as const,
      real_apply_enabled: false,
      ok: updateTrialOk,
      blockers: [
        ...(updateDryRun.scope === "project:memory-xx" ? [] : [`wrong_scope:${updateDryRun.scope}`]),
        ...(updateDryRun.wrong_scope_count === 0 ? [] : [`wrong_scope_count:${updateDryRun.wrong_scope_count}`]),
        ...(updateDryRun.default_recall_leakage === 0 ? [] : [`default_recall_leakage:${updateDryRun.default_recall_leakage}`]),
      ],
      ...updateDryRun,
    },
  };
}
