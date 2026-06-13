import type {
  MemoryRecordRow,
  RecallFeedbackEventRow,
  RecallTraceRow,
} from "../db/schema/tables";

export type ExtractionRecallEvalSuggestedAction =
  | "none"
  | "tighten_extraction_or_recall_policy"
  | "add_repair_training_sample";

export type ExtractionRecallMismatchKind =
  | "none"
  | "episodic_default_recall_leakage"
  | "audit_default_recall_leakage"
  | "rejected_or_event_only_recalled"
  | "negative_feedback_pressure"
  | "false_null_repair_pressure";

export interface ExtractionRecallEvalCohort {
  readonly query_type: string;
  readonly memory_class: string;
  readonly cognitive_type: string;
  readonly policy_action: string;
  readonly recall_policy: string;
  readonly source: string;
  readonly feedback_count: number;
  readonly positive_count: number;
  readonly negative_count: number;
  readonly false_positive_count: number;
  readonly negative_rate: number;
  readonly mismatch_kind: ExtractionRecallMismatchKind;
  readonly suggested_action: ExtractionRecallEvalSuggestedAction;
}

export interface ExtractionRecallFalseNullCohort {
  readonly query_type: string;
  readonly feedback_count: number;
  readonly false_null_count: number;
  readonly mismatch_kind: "false_null_repair_pressure";
  readonly suggested_action: "add_repair_training_sample";
}

export interface ExtractionRecallEvalReport {
  readonly summary: {
    readonly traces: number;
    readonly feedback_events: number;
    readonly suspicious_feedback_events: number;
    readonly cohorts: number;
    readonly false_null_cohorts: number;
    readonly mismatch_cohorts: number;
  };
  readonly cohorts: readonly ExtractionRecallEvalCohort[];
  readonly false_null_cohorts: readonly ExtractionRecallFalseNullCohort[];
}

export type ExtractionRecallEvalCandidateType = "policy_corpus" | "repair_queue";

export interface ExtractionRecallEvalPolicyCandidate {
  readonly candidate_type: ExtractionRecallEvalCandidateType;
  readonly sample_id: string;
  readonly source_text: string;
  readonly expected_policy_action: Exclude<ExtractionRecallEvalSuggestedAction, "none">;
  readonly metadata: {
    readonly run_id: string;
    readonly query_type: string;
    readonly memory_class?: string;
    readonly cognitive_type?: string;
    readonly policy_action?: string;
    readonly recall_policy?: string;
    readonly source?: string;
    readonly feedback_count: number;
    readonly negative_count?: number;
    readonly false_positive_count?: number;
    readonly false_null_count?: number;
    readonly negative_rate?: number;
    readonly mismatch_kind: ExtractionRecallMismatchKind;
  };
}

export interface BuildExtractionRecallEvalReportInput {
  readonly traces: readonly RecallTraceRow[];
  readonly feedbackEvents: readonly RecallFeedbackEventRow[];
  readonly memories: readonly MemoryRecordRow[];
  readonly minFeedback?: number;
}

export interface BuildExtractionRecallEvalPolicyCandidatesInput {
  readonly report: ExtractionRecallEvalReport;
  readonly runId: string;
}

interface MemoryDecision {
  readonly memory_class: string;
  readonly cognitive_type: string;
  readonly policy_action: string;
  readonly recall_policy: string;
  readonly source: string;
}

interface MutableCohort extends MemoryDecision {
  query_type: string;
  feedback_count: number;
  positive_count: number;
  negative_count: number;
  false_positive_count: number;
}

interface MutableFalseNullCohort {
  query_type: string;
  feedback_count: number;
  false_null_count: number;
}

const POSITIVE_FEEDBACK = new Set(["used_in_context", "adopted"]);
const NEGATIVE_FEEDBACK = new Set(["ignored", "not_relevant", "false_positive"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataString(memory: MemoryRecordRow, ...keys: readonly string[]): string | null {
  const candidates: unknown[] = [];
  for (const key of keys) candidates.push(memory.metadata[key]);
  const memoryPolicy = isRecord(memory.metadata.memory_policy) ? memory.metadata.memory_policy : null;
  const autoApproval = isRecord(memory.metadata.auto_approval_policy) ? memory.metadata.auto_approval_policy : null;
  const nestedPolicy = autoApproval && isRecord(autoApproval.memory_policy) ? autoApproval.memory_policy : null;
  const sweep = isRecord(memory.metadata.memory_auto_approval_sweep) ? memory.metadata.memory_auto_approval_sweep : null;
  for (const key of keys) {
    candidates.push(memoryPolicy?.[key]);
    candidates.push(nestedPolicy?.[key]);
    candidates.push(sweep?.[key]);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function memoryDecision(memory: MemoryRecordRow): MemoryDecision {
  return {
    memory_class: metadataString(memory, "memory_class") ?? "unknown",
    cognitive_type: metadataString(memory, "cognitive_type") ?? "unknown",
    policy_action: metadataString(memory, "policy_action") ?? "unknown",
    recall_policy: metadataString(memory, "recall_policy") ?? "default",
    source: metadataString(memory, "source") ?? memory.createdBy,
  };
}

function cohortKey(decision: MemoryDecision, queryType: string): string {
  return [
    queryType,
    decision.memory_class,
    decision.cognitive_type,
    decision.policy_action,
    decision.recall_policy,
    decision.source,
  ].join("\u0000");
}

function roundRate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function mismatchKind(cohort: MutableCohort, minFeedback: number): ExtractionRecallMismatchKind {
  if (cohort.false_positive_count > 0 && cohort.cognitive_type === "episodic" && cohort.recall_policy === "default") {
    return "episodic_default_recall_leakage";
  }
  if (cohort.false_positive_count > 0 && cohort.cognitive_type === "audit" && cohort.recall_policy === "default") {
    return "audit_default_recall_leakage";
  }
  if (cohort.false_positive_count > 0 && (cohort.policy_action === "reject_by_policy" || cohort.recall_policy === "never")) {
    return "rejected_or_event_only_recalled";
  }
  if (cohort.feedback_count >= minFeedback && cohort.negative_count > 0) return "negative_feedback_pressure";
  return "none";
}

function suggestedAction(kind: ExtractionRecallMismatchKind): ExtractionRecallEvalSuggestedAction {
  if (kind === "none") return "none";
  if (kind === "false_null_repair_pressure") return "add_repair_training_sample";
  return "tighten_extraction_or_recall_policy";
}

function policySampleId(runId: string, cohort: ExtractionRecallEvalCohort): string {
  return [
    runId,
    cohort.query_type,
    cohort.memory_class,
    cohort.cognitive_type,
    cohort.policy_action,
    cohort.recall_policy,
  ].join(":");
}

function falseNullSampleId(runId: string, cohort: ExtractionRecallFalseNullCohort): string {
  return `${runId}:${cohort.query_type}:false_null`;
}

export function buildExtractionRecallEvalReport(
  input: BuildExtractionRecallEvalReportInput
): ExtractionRecallEvalReport {
  const traceById = new Map(input.traces.map((trace) => [trace.id, trace]));
  const memoryById = new Map(input.memories.map((memory) => [memory.id, memory]));
  const cohorts = new Map<string, MutableCohort>();
  const falseNullCohorts = new Map<string, MutableFalseNullCohort>();
  const minFeedback = input.minFeedback ?? 5;
  let suspicious = 0;

  function cohortFor(decision: MemoryDecision, queryType: string): MutableCohort {
    const key = cohortKey(decision, queryType);
    const existing = cohorts.get(key);
    if (existing) return existing;
    const created: MutableCohort = {
      query_type: queryType,
      ...decision,
      feedback_count: 0,
      positive_count: 0,
      negative_count: 0,
      false_positive_count: 0,
    };
    cohorts.set(key, created);
    return created;
  }

  function falseNullCohortFor(queryType: string): MutableFalseNullCohort {
    const existing = falseNullCohorts.get(queryType);
    if (existing) return existing;
    const created: MutableFalseNullCohort = {
      query_type: queryType,
      feedback_count: 0,
      false_null_count: 0,
    };
    falseNullCohorts.set(queryType, created);
    return created;
  }

  for (const event of input.feedbackEvents) {
    if (event.suspicious) {
      suspicious += 1;
      continue;
    }
    const trace = traceById.get(event.recallTraceId);
    if (!trace) continue;
    if (event.feedbackType === "false_null") {
      const cohort = falseNullCohortFor(trace.queryType);
      cohort.feedback_count += 1;
      cohort.false_null_count += 1;
      continue;
    }
    if (!event.memoryId) continue;
    const memory = memoryById.get(event.memoryId);
    if (!memory) continue;
    const cohort = cohortFor(memoryDecision(memory), trace.queryType);
    cohort.feedback_count += 1;
    if (POSITIVE_FEEDBACK.has(event.feedbackType)) cohort.positive_count += 1;
    if (NEGATIVE_FEEDBACK.has(event.feedbackType)) cohort.negative_count += 1;
    if (event.feedbackType === "false_positive") cohort.false_positive_count += 1;
  }

  const rows = [...cohorts.values()]
    .map((cohort): ExtractionRecallEvalCohort => {
      const kind = mismatchKind(cohort, minFeedback);
      return {
        ...cohort,
        negative_rate: cohort.feedback_count > 0 ? roundRate(cohort.negative_count / cohort.feedback_count) : 0,
        mismatch_kind: kind,
        suggested_action: suggestedAction(kind),
      };
    })
    .sort((left, right) =>
      left.query_type.localeCompare(right.query_type) ||
      left.memory_class.localeCompare(right.memory_class) ||
      left.cognitive_type.localeCompare(right.cognitive_type) ||
      left.policy_action.localeCompare(right.policy_action) ||
      left.recall_policy.localeCompare(right.recall_policy)
    );

  const falseNullRows = [...falseNullCohorts.values()]
    .map((cohort): ExtractionRecallFalseNullCohort => ({
      ...cohort,
      mismatch_kind: "false_null_repair_pressure",
      suggested_action: "add_repair_training_sample",
    }))
    .sort((left, right) => left.query_type.localeCompare(right.query_type));

  return {
    summary: {
      traces: input.traces.length,
      feedback_events: input.feedbackEvents.length - suspicious,
      suspicious_feedback_events: suspicious,
      cohorts: rows.length,
      false_null_cohorts: falseNullRows.length,
      mismatch_cohorts: rows.filter((cohort) => cohort.mismatch_kind !== "none").length + falseNullRows.length,
    },
    cohorts: rows,
    false_null_cohorts: falseNullRows,
  };
}

export function buildExtractionRecallEvalPolicyCandidates(
  input: BuildExtractionRecallEvalPolicyCandidatesInput
): readonly ExtractionRecallEvalPolicyCandidate[] {
  const policyCandidates = input.report.cohorts
    .filter((cohort) => cohort.suggested_action !== "none")
    .map((cohort): ExtractionRecallEvalPolicyCandidate => ({
      candidate_type: "policy_corpus",
      sample_id: policySampleId(input.runId, cohort),
      source_text: [
        "Extraction decision produced downstream recall feedback pressure.",
        `query_type=${cohort.query_type}`,
        `memory_class=${cohort.memory_class}`,
        `cognitive_type=${cohort.cognitive_type}`,
        `policy_action=${cohort.policy_action}`,
        `recall_policy=${cohort.recall_policy}`,
        `mismatch_kind=${cohort.mismatch_kind}`,
      ].join(" "),
      expected_policy_action: "tighten_extraction_or_recall_policy",
      metadata: {
        run_id: input.runId,
        query_type: cohort.query_type,
        memory_class: cohort.memory_class,
        cognitive_type: cohort.cognitive_type,
        policy_action: cohort.policy_action,
        recall_policy: cohort.recall_policy,
        source: cohort.source,
        feedback_count: cohort.feedback_count,
        negative_count: cohort.negative_count,
        false_positive_count: cohort.false_positive_count,
        negative_rate: cohort.negative_rate,
        mismatch_kind: cohort.mismatch_kind,
      },
    }));

  const repairCandidates = input.report.false_null_cohorts
    .map((cohort): ExtractionRecallEvalPolicyCandidate => ({
      candidate_type: "repair_queue",
      sample_id: falseNullSampleId(input.runId, cohort),
      source_text: [
        "Recall false-null cohort requires extraction or retrieval repair training sample.",
        `query_type=${cohort.query_type}`,
        `false_null_count=${cohort.false_null_count}`,
      ].join(" "),
      expected_policy_action: "add_repair_training_sample",
      metadata: {
        run_id: input.runId,
        query_type: cohort.query_type,
        feedback_count: cohort.feedback_count,
        false_null_count: cohort.false_null_count,
        mismatch_kind: cohort.mismatch_kind,
      },
    }));

  return [...policyCandidates, ...repairCandidates];
}
