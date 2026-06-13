export interface TopicNormalizationAliasRow {
  readonly candidate_id: string;
  readonly source_topic: string;
  readonly candidate_topic: string;
  readonly supporting_discoveries: number;
  readonly avg_confidence: number;
  readonly sample_memory_ids: readonly string[];
}

export interface TopicNormalizationCandidate {
  readonly candidate_type: "topic_normalization_candidate";
  readonly candidate_id: string;
  readonly alias_candidate_id: string;
  readonly source_topic: string;
  readonly canonical_topic: string;
  readonly affected_memory_ids: readonly string[];
  readonly suggested_action: "review_topic_normalization";
  readonly review_signal: "normal" | "ambiguous_multi_canonical";
  readonly apply_allowed: false;
  readonly blockers: readonly ["report_only", "requires_human_review"];
  readonly evidence: {
    readonly supporting_discoveries: number;
    readonly avg_confidence: number;
    readonly affected_memory_count: number;
    readonly alternative_canonical_topics: readonly string[];
    readonly report_only: true;
  };
}

export interface TopicNormalizationPlan {
  readonly ok: true;
  readonly generated_at: string;
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly summary: {
    readonly total_aliases: number;
    readonly total_candidates: number;
    readonly ambiguous_source_topics: number;
    readonly by_action: Partial<Record<"review_topic_normalization", number>>;
    readonly report_only: true;
    readonly apply_allowed: false;
  };
  readonly candidates: readonly TopicNormalizationCandidate[];
}

export type TopicNormalizationReviewQueueName = "topic_normalization_review";
export type TopicNormalizationReviewPriority = "high" | "normal";
export type TopicNormalizationRequiredBeforeApply =
  | "human_review"
  | "topic_alias_scope_check"
  | "affected_memory_sample_review"
  | "canonical_topic_disambiguation";

export interface TopicNormalizationReviewQueueItem {
  readonly queue: TopicNormalizationReviewQueueName;
  readonly priority: TopicNormalizationReviewPriority;
  readonly normalization_candidate_id: string;
  readonly alias_candidate_id: string;
  readonly source_topic: string;
  readonly canonical_topic: string;
  readonly affected_memory_ids: readonly string[];
  readonly recommended_action: "review_topic_normalization";
  readonly review_signal: "normal" | "ambiguous_multi_canonical";
  readonly required_before_apply: readonly TopicNormalizationRequiredBeforeApply[];
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly evidence: {
    readonly supporting_discoveries: number;
    readonly avg_confidence: number;
    readonly affected_memory_count: number;
    readonly alternative_canonical_topics: readonly string[];
  };
}

export interface TopicNormalizationReviewQueueReport {
  readonly ok: true;
  readonly generated_at: string;
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly summary: {
    readonly total_candidates: number;
    readonly total_review_items: number;
    readonly ambiguous_review_items: number;
    readonly by_queue: Partial<Record<TopicNormalizationReviewQueueName, number>>;
    readonly report_only: true;
    readonly apply_allowed: false;
  };
  readonly items: readonly TopicNormalizationReviewQueueItem[];
}

export interface BuildTopicNormalizationPlanInput {
  readonly aliases: readonly TopicNormalizationAliasRow[];
  readonly generatedAt?: string;
}

export interface BuildTopicNormalizationReviewQueueInput {
  readonly plan: TopicNormalizationPlan;
  readonly generatedAt?: string;
}

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function stableId(sourceTopic: string, canonicalTopic: string): string {
  const normalized = `${sourceTopic}->${canonicalTopic}`
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  return `topic-normalization:${normalized}`;
}

export function buildTopicNormalizationPlan(input: BuildTopicNormalizationPlanInput): TopicNormalizationPlan {
  const candidateTopicsBySource = new Map<string, Set<string>>();
  for (const alias of input.aliases) {
    const sourceTopic = normalize(alias.source_topic);
    const canonicalTopic = normalize(alias.candidate_topic);
    if (!sourceTopic || !canonicalTopic || sourceTopic === canonicalTopic) continue;
    const topics = candidateTopicsBySource.get(sourceTopic) ?? new Set<string>();
    topics.add(canonicalTopic);
    candidateTopicsBySource.set(sourceTopic, topics);
  }
  const ambiguousSourceTopics = [...candidateTopicsBySource.values()].filter((topics) => topics.size > 1).length;

  const candidates = input.aliases
    .map((alias): TopicNormalizationCandidate | null => {
      const sourceTopic = normalize(alias.source_topic);
      const canonicalTopic = normalize(alias.candidate_topic);
      if (!sourceTopic || !canonicalTopic || sourceTopic === canonicalTopic) return null;
      const affectedMemoryIds = [...new Set(alias.sample_memory_ids.filter(Boolean))].sort();
      const alternativeCanonicalTopics = [...(candidateTopicsBySource.get(sourceTopic) ?? new Set<string>())]
        .filter((topic) => topic !== canonicalTopic)
        .sort();
      return {
        candidate_type: "topic_normalization_candidate",
        candidate_id: stableId(sourceTopic, canonicalTopic),
        alias_candidate_id: alias.candidate_id,
        source_topic: sourceTopic,
        canonical_topic: canonicalTopic,
        affected_memory_ids: affectedMemoryIds,
        suggested_action: "review_topic_normalization",
        review_signal: alternativeCanonicalTopics.length > 0 ? "ambiguous_multi_canonical" : "normal",
        apply_allowed: false,
        blockers: ["report_only", "requires_human_review"],
        evidence: {
          supporting_discoveries: alias.supporting_discoveries,
          avg_confidence: alias.avg_confidence,
          affected_memory_count: affectedMemoryIds.length,
          alternative_canonical_topics: alternativeCanonicalTopics,
          report_only: true,
        },
      };
    })
    .filter((candidate): candidate is TopicNormalizationCandidate => candidate !== null)
    .sort((left, right) =>
      right.evidence.supporting_discoveries - left.evidence.supporting_discoveries ||
      left.source_topic.localeCompare(right.source_topic) ||
      left.canonical_topic.localeCompare(right.canonical_topic)
    );

  return {
    ok: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    report_only: true,
    apply_allowed: false,
    summary: {
      total_aliases: input.aliases.length,
      total_candidates: candidates.length,
      ambiguous_source_topics: ambiguousSourceTopics,
      by_action: candidates.length > 0 ? { review_topic_normalization: candidates.length } : {},
      report_only: true,
      apply_allowed: false,
    },
    candidates,
  };
}

function reviewPriority(candidate: TopicNormalizationCandidate): TopicNormalizationReviewPriority {
  return candidate.review_signal === "ambiguous_multi_canonical" ||
    candidate.evidence.supporting_discoveries >= 3 ||
    candidate.evidence.affected_memory_count >= 3
    ? "high"
    : "normal";
}

function requiredBeforeApply(candidate: TopicNormalizationCandidate): TopicNormalizationReviewQueueItem["required_before_apply"] {
  const required: TopicNormalizationRequiredBeforeApply[] = [
    "human_review",
    "topic_alias_scope_check",
    "affected_memory_sample_review",
  ];
  if (candidate.review_signal === "ambiguous_multi_canonical") {
    required.push("canonical_topic_disambiguation");
  }
  return required;
}

export function buildTopicNormalizationReviewQueue(
  input: BuildTopicNormalizationReviewQueueInput,
): TopicNormalizationReviewQueueReport {
  const items = input.plan.candidates.map((candidate): TopicNormalizationReviewQueueItem => ({
    queue: "topic_normalization_review",
    priority: reviewPriority(candidate),
    normalization_candidate_id: candidate.candidate_id,
    alias_candidate_id: candidate.alias_candidate_id,
    source_topic: candidate.source_topic,
    canonical_topic: candidate.canonical_topic,
    affected_memory_ids: candidate.affected_memory_ids,
    recommended_action: "review_topic_normalization",
    review_signal: candidate.review_signal,
    required_before_apply: requiredBeforeApply(candidate),
    report_only: true,
    apply_allowed: false,
    evidence: {
      supporting_discoveries: candidate.evidence.supporting_discoveries,
      avg_confidence: candidate.evidence.avg_confidence,
      affected_memory_count: candidate.evidence.affected_memory_count,
      alternative_canonical_topics: candidate.evidence.alternative_canonical_topics,
    },
  }));

  return {
    ok: true,
    generated_at: input.generatedAt ?? input.plan.generated_at,
    report_only: true,
    apply_allowed: false,
    summary: {
      total_candidates: input.plan.candidates.length,
      total_review_items: items.length,
      ambiguous_review_items: items.filter((item) => item.review_signal === "ambiguous_multi_canonical").length,
      by_queue: items.length > 0 ? { topic_normalization_review: items.length } : {},
      report_only: true,
      apply_allowed: false,
    },
    items,
  };
}
