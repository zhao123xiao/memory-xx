import type {
  MemoryRecordRow,
  RecallFeedbackEventRow,
  RecallTraceRow,
} from "../db/schema/tables";

export type RecallQualitySuggestedAction =
  | "none"
  | "review_policy_corpus"
  | "review_temporal_filter"
  | "open_repair_queue";

export interface RecallQualityFeedbackCohort {
  readonly memory_class: string;
  readonly cognitive_type: string;
  readonly query_type: string;
  readonly feedback_count: number;
  readonly positive_count: number;
  readonly negative_count: number;
  readonly false_positive_count: number;
  readonly false_null_count: number;
  readonly negative_rate: number;
  readonly suggested_action: RecallQualitySuggestedAction;
}

export interface RecallQualityFeedbackReport {
  readonly summary: {
    readonly traces: number;
    readonly feedback_events: number;
    readonly suspicious_feedback_events: number;
    readonly cohorts: number;
  };
  readonly cohorts: readonly RecallQualityFeedbackCohort[];
}

export type RecallFeedbackPolicyCandidateType =
  | "policy_corpus"
  | "temporal_filter_review"
  | "repair_queue";

export interface RecallFeedbackPolicyCandidate {
  readonly candidate_type: RecallFeedbackPolicyCandidateType;
  readonly sample_id: string;
  readonly source_text: string;
  readonly expected_policy_action: Exclude<RecallQualitySuggestedAction, "none">;
  readonly metadata: {
    readonly run_id: string;
    readonly query_type: string;
    readonly memory_class: string;
    readonly cognitive_type: string;
    readonly feedback_count: number;
    readonly positive_count: number;
    readonly negative_count: number;
    readonly false_positive_count: number;
    readonly false_null_count: number;
    readonly negative_rate: number;
  };
}

export interface BuildRecallQualityFeedbackReportInput {
  readonly traces: readonly RecallTraceRow[];
  readonly feedbackEvents: readonly RecallFeedbackEventRow[];
  readonly memories: readonly MemoryRecordRow[];
  readonly minFeedback?: number;
}

export interface BuildRecallFeedbackPolicyCandidatesInput {
  readonly report: RecallQualityFeedbackReport;
  readonly runId: string;
}

interface MutableCohort {
  memory_class: string;
  cognitive_type: string;
  query_type: string;
  feedback_count: number;
  positive_count: number;
  negative_count: number;
  false_positive_count: number;
  false_null_count: number;
}

const POSITIVE_FEEDBACK = new Set(["used_in_context", "adopted"]);
const NEGATIVE_FEEDBACK = new Set(["ignored", "not_relevant", "false_positive"]);

function memoryClass(memory: MemoryRecordRow | undefined): string {
  const value = memory?.metadata.memory_class;
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function cognitiveType(memory: MemoryRecordRow | undefined): string {
  const value = memory?.metadata.cognitive_type;
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function roundRate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function keyFor(memoryClassValue: string, cognitiveTypeValue: string, queryType: string): string {
  return `${memoryClassValue}\u0000${cognitiveTypeValue}\u0000${queryType}`;
}

function sampleId(runId: string, cohort: RecallQualityFeedbackCohort): string {
  return `${runId}:${cohort.query_type}:${cohort.memory_class}:${cohort.cognitive_type}`;
}

function suggestedAction(cohort: MutableCohort, minFeedback: number): RecallQualitySuggestedAction {
  if (cohort.false_null_count > 0) return "open_repair_queue";
  if (cohort.false_positive_count > 0 && cohort.cognitive_type === "episodic") return "review_temporal_filter";
  if (cohort.feedback_count >= minFeedback && cohort.negative_count > 0) return "review_policy_corpus";
  return "none";
}

function hasCandidateAction(
  cohort: RecallQualityFeedbackCohort
): cohort is RecallQualityFeedbackCohort & { readonly suggested_action: Exclude<RecallQualitySuggestedAction, "none"> } {
  return cohort.suggested_action !== "none";
}

export function buildRecallQualityFeedbackReport(
  input: BuildRecallQualityFeedbackReportInput
): RecallQualityFeedbackReport {
  const traceById = new Map(input.traces.map((trace) => [trace.id, trace]));
  const memoryById = new Map(input.memories.map((memory) => [memory.id, memory]));
  const cohorts = new Map<string, MutableCohort>();
  const minFeedback = input.minFeedback ?? 5;
  let suspicious = 0;

  function cohortFor(memoryClassValue: string, cognitiveTypeValue: string, queryType: string): MutableCohort {
    const key = keyFor(memoryClassValue, cognitiveTypeValue, queryType);
    const existing = cohorts.get(key);
    if (existing) return existing;
    const created: MutableCohort = {
      memory_class: memoryClassValue,
      cognitive_type: cognitiveTypeValue,
      query_type: queryType,
      feedback_count: 0,
      positive_count: 0,
      negative_count: 0,
      false_positive_count: 0,
      false_null_count: 0,
    };
    cohorts.set(key, created);
    return created;
  }

  for (const event of input.feedbackEvents) {
    if (event.suspicious) {
      suspicious += 1;
      continue;
    }
    const trace = traceById.get(event.recallTraceId);
    if (!trace) continue;
    const memory = event.memoryId ? memoryById.get(event.memoryId) : undefined;
    const cohort = event.feedbackType === "false_null"
      ? cohortFor("no_memory_returned", "none", trace.queryType)
      : cohortFor(memoryClass(memory), cognitiveType(memory), trace.queryType);

    cohort.feedback_count += 1;
    if (POSITIVE_FEEDBACK.has(event.feedbackType)) {
      cohort.positive_count += 1;
    } else if (NEGATIVE_FEEDBACK.has(event.feedbackType)) {
      cohort.negative_count += 1;
    }
    if (event.feedbackType === "false_positive") {
      cohort.false_positive_count += 1;
    }
    if (event.feedbackType === "false_null") {
      cohort.false_null_count += 1;
    }
  }

  const rows = [...cohorts.values()]
    .map((cohort): RecallQualityFeedbackCohort => ({
      ...cohort,
      negative_rate: cohort.feedback_count > 0 ? roundRate(cohort.negative_count / cohort.feedback_count) : 0,
      suggested_action: suggestedAction(cohort, minFeedback),
    }))
    .sort((left, right) =>
      left.query_type.localeCompare(right.query_type) ||
      left.memory_class.localeCompare(right.memory_class) ||
      left.cognitive_type.localeCompare(right.cognitive_type)
    );

  return {
    summary: {
      traces: input.traces.length,
      feedback_events: input.feedbackEvents.length - suspicious,
      suspicious_feedback_events: suspicious,
      cohorts: rows.length,
    },
    cohorts: rows,
  };
}

export function buildRecallFeedbackPolicyCandidates(
  input: BuildRecallFeedbackPolicyCandidatesInput
): readonly RecallFeedbackPolicyCandidate[] {
  return input.report.cohorts
    .filter(hasCandidateAction)
    .map((cohort): RecallFeedbackPolicyCandidate => {
      const candidateType: RecallFeedbackPolicyCandidateType =
        cohort.suggested_action === "open_repair_queue"
          ? "repair_queue"
          : cohort.suggested_action === "review_temporal_filter"
            ? "temporal_filter_review"
            : "policy_corpus";
      return {
        candidate_type: candidateType,
        sample_id: sampleId(input.runId, cohort),
        source_text: [
          `Recall feedback cohort requires ${cohort.suggested_action}.`,
          `query_type=${cohort.query_type}`,
          `memory_class=${cohort.memory_class}`,
          `cognitive_type=${cohort.cognitive_type}`,
          `feedback_count=${cohort.feedback_count}`,
          `negative_rate=${cohort.negative_rate}`,
        ].join(" "),
        expected_policy_action: cohort.suggested_action,
        metadata: {
          run_id: input.runId,
          query_type: cohort.query_type,
          memory_class: cohort.memory_class,
          cognitive_type: cohort.cognitive_type,
          feedback_count: cohort.feedback_count,
          positive_count: cohort.positive_count,
          negative_count: cohort.negative_count,
          false_positive_count: cohort.false_positive_count,
          false_null_count: cohort.false_null_count,
          negative_rate: cohort.negative_rate,
        },
      };
    });
}
