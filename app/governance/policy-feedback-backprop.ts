import type { ExtractionRecallEvalReport } from "./extraction-recall-eval";
import type { RecallQualityFeedbackReport } from "./recall-quality-feedback";

export type PolicyFeedbackBackpropTarget =
  | "extraction_policy"
  | "recall_policy"
  | "repair_retrieval";

export type PolicyFeedbackBackpropSource =
  | "recall_quality"
  | "extraction_recall_eval";

export type PolicyFeedbackBackpropAction =
  | "tighten_extraction_or_recall_policy"
  | "review_temporal_filter"
  | "add_repair_training_sample"
  | "open_repair_queue";

export interface PolicyFeedbackBackpropCandidate {
  readonly candidate_type: "policy_feedback_backprop";
  readonly candidate_id: string;
  readonly target: PolicyFeedbackBackpropTarget;
  readonly sources: readonly PolicyFeedbackBackpropSource[];
  readonly suggested_action: PolicyFeedbackBackpropAction;
  readonly policy_delta?: {
    readonly memory_class?: string;
    readonly cognitive_type?: string;
    readonly query_type?: string;
    readonly policy_action?: string;
    readonly recall_policy?: string;
    readonly source?: string;
  };
  readonly evidence: {
    readonly feedback_count: number;
    readonly negative_count?: number;
    readonly false_positive_count?: number;
    readonly false_null_count?: number;
    readonly negative_rate?: number;
    readonly mismatch_kind?: string;
    readonly report_only: true;
  };
  readonly apply_allowed: false;
  readonly blockers: readonly ["report_only", "requires_human_review"];
}

export interface PolicyFeedbackBackpropReport {
  readonly ok: true;
  readonly generated_at: string;
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly summary: {
    readonly total_candidates: number;
    readonly by_target: Partial<Record<PolicyFeedbackBackpropTarget, number>>;
    readonly by_source: Partial<Record<PolicyFeedbackBackpropSource, number>>;
  };
  readonly candidates: readonly PolicyFeedbackBackpropCandidate[];
}

export interface BuildPolicyFeedbackBackpropReportInput {
  readonly generatedAt?: string;
  readonly recallQuality: RecallQualityFeedbackReport;
  readonly extractionRecallEval: ExtractionRecallEvalReport;
}

function stablePart(value: string): string {
  return value.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "").toLowerCase();
}

function candidateId(parts: readonly string[]): string {
  return stablePart(["policy-feedback-backprop", ...parts].join(":"));
}

function extractionCandidateIdParts(
  target: PolicyFeedbackBackpropTarget,
  cohort: {
    readonly query_type: string;
    readonly memory_class: string;
    readonly cognitive_type: string;
    readonly policy_action: string;
    readonly recall_policy: string;
  },
): readonly string[] {
  if (target === "recall_policy") {
    return [target, cohort.query_type, cohort.memory_class, cohort.cognitive_type];
  }
  return [target, cohort.query_type, cohort.memory_class, cohort.cognitive_type, cohort.policy_action, cohort.recall_policy];
}

function increment<TKey extends string>(target: Partial<Record<TKey, number>>, key: TKey): void {
  target[key] = (target[key] ?? 0) + 1;
}

function targetForMismatch(kind: string): PolicyFeedbackBackpropTarget {
  if (kind === "false_null_repair_pressure") return "repair_retrieval";
  if (kind === "episodic_default_recall_leakage") return "recall_policy";
  if (kind.includes("default_recall") || kind.includes("recalled")) return "extraction_policy";
  return "recall_policy";
}

function recallPolicyDeltaFor(kind: string): "explicit_only" | "never" | undefined {
  if (kind === "audit_default_recall_leakage" || kind === "rejected_or_event_only_recalled") return "never";
  if (kind === "episodic_default_recall_leakage") return "explicit_only";
  return undefined;
}

function addOrMerge(
  target: Map<string, PolicyFeedbackBackpropCandidate>,
  candidate: PolicyFeedbackBackpropCandidate,
): void {
  const existing = target.get(candidate.candidate_id);
  if (!existing) {
    target.set(candidate.candidate_id, candidate);
    return;
  }
  target.set(candidate.candidate_id, {
    ...existing,
    sources: [...new Set([...existing.sources, ...candidate.sources])],
    suggested_action: preferredAction(existing.suggested_action, candidate.suggested_action),
    evidence: {
      ...existing.evidence,
      feedback_count: Math.max(existing.evidence.feedback_count, candidate.evidence.feedback_count),
      negative_count: Math.max(existing.evidence.negative_count ?? 0, candidate.evidence.negative_count ?? 0) || undefined,
      false_positive_count: Math.max(existing.evidence.false_positive_count ?? 0, candidate.evidence.false_positive_count ?? 0) || undefined,
      false_null_count: Math.max(existing.evidence.false_null_count ?? 0, candidate.evidence.false_null_count ?? 0) || undefined,
      negative_rate: Math.max(existing.evidence.negative_rate ?? 0, candidate.evidence.negative_rate ?? 0) || undefined,
      mismatch_kind: existing.evidence.mismatch_kind ?? candidate.evidence.mismatch_kind,
      report_only: true,
    },
  });
}

function preferredAction(
  left: PolicyFeedbackBackpropAction,
  right: PolicyFeedbackBackpropAction,
): PolicyFeedbackBackpropAction {
  const rank: Record<PolicyFeedbackBackpropAction, number> = {
    review_temporal_filter: 4,
    add_repair_training_sample: 3,
    open_repair_queue: 2,
    tighten_extraction_or_recall_policy: 1,
  };
  return rank[right] > rank[left] ? right : left;
}

export function buildPolicyFeedbackBackpropReport(
  input: BuildPolicyFeedbackBackpropReportInput,
): PolicyFeedbackBackpropReport {
  const candidates = new Map<string, PolicyFeedbackBackpropCandidate>();

  for (const cohort of input.extractionRecallEval.cohorts) {
    if (cohort.suggested_action === "none" || cohort.mismatch_kind === "none") continue;
    const target = targetForMismatch(cohort.mismatch_kind);
    addOrMerge(candidates, {
      candidate_type: "policy_feedback_backprop",
      candidate_id: candidateId(extractionCandidateIdParts(target, cohort)),
      target,
      sources: ["extraction_recall_eval"],
      suggested_action: "tighten_extraction_or_recall_policy",
      policy_delta: {
        query_type: cohort.query_type,
        memory_class: cohort.memory_class,
        cognitive_type: cohort.cognitive_type,
        policy_action: cohort.policy_action,
        recall_policy: recallPolicyDeltaFor(cohort.mismatch_kind) ?? cohort.recall_policy,
        source: cohort.source,
      },
      evidence: {
        feedback_count: cohort.feedback_count,
        negative_count: cohort.negative_count,
        false_positive_count: cohort.false_positive_count,
        negative_rate: cohort.negative_rate,
        mismatch_kind: cohort.mismatch_kind,
        report_only: true,
      },
      apply_allowed: false,
      blockers: ["report_only", "requires_human_review"],
    });
  }

  for (const cohort of input.extractionRecallEval.false_null_cohorts) {
    addOrMerge(candidates, {
      candidate_type: "policy_feedback_backprop",
      candidate_id: candidateId(["repair_retrieval", cohort.query_type, "false-null"]),
      target: "repair_retrieval",
      sources: ["extraction_recall_eval"],
      suggested_action: "add_repair_training_sample",
      policy_delta: {
        query_type: cohort.query_type,
      },
      evidence: {
        feedback_count: cohort.feedback_count,
        false_null_count: cohort.false_null_count,
        mismatch_kind: cohort.mismatch_kind,
        report_only: true,
      },
      apply_allowed: false,
      blockers: ["report_only", "requires_human_review"],
    });
  }

  for (const cohort of input.recallQuality.cohorts) {
    if (cohort.suggested_action === "none") continue;
    const target: PolicyFeedbackBackpropTarget = cohort.suggested_action === "open_repair_queue"
      ? "repair_retrieval"
      : cohort.suggested_action === "review_temporal_filter"
        ? "recall_policy"
        : "extraction_policy";
    const action: PolicyFeedbackBackpropAction = cohort.suggested_action === "open_repair_queue"
      ? "open_repair_queue"
      : cohort.suggested_action === "review_temporal_filter"
        ? "review_temporal_filter"
        : "tighten_extraction_or_recall_policy";
    addOrMerge(candidates, {
      candidate_type: "policy_feedback_backprop",
      candidate_id: candidateId(target === "repair_retrieval"
        ? [target, cohort.query_type, "false-null"]
        : [target, cohort.query_type, cohort.memory_class, cohort.cognitive_type]),
      target,
      sources: ["recall_quality"],
      suggested_action: action,
      policy_delta: {
        query_type: cohort.query_type,
        memory_class: cohort.memory_class,
        cognitive_type: cohort.cognitive_type,
        ...(target === "recall_policy" ? { recall_policy: "explicit_only" } : {}),
      },
      evidence: {
        feedback_count: cohort.feedback_count,
        negative_count: cohort.negative_count,
        false_positive_count: cohort.false_positive_count,
        false_null_count: cohort.false_null_count,
        negative_rate: cohort.negative_rate,
        report_only: true,
      },
      apply_allowed: false,
      blockers: ["report_only", "requires_human_review"],
    });
  }

  const sorted = [...candidates.values()].sort((left, right) =>
    left.target.localeCompare(right.target) ||
    left.candidate_id.localeCompare(right.candidate_id)
  );
  const byTarget: Partial<Record<PolicyFeedbackBackpropTarget, number>> = {};
  const bySource: Partial<Record<PolicyFeedbackBackpropSource, number>> = {};
  for (const candidate of sorted) {
    increment(byTarget, candidate.target);
    for (const source of candidate.sources) increment(bySource, source);
  }

  return {
    ok: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    report_only: true,
    apply_allowed: false,
    summary: {
      total_candidates: sorted.length,
      by_target: byTarget,
      by_source: bySource,
    },
    candidates: sorted,
  };
}
