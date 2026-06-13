export interface TopicAliasDiscoveryRow {
  readonly candidate_id: string;
  readonly relation_id: string;
  readonly source_memory_id: string;
  readonly old_target_memory_id: string;
  readonly candidate_successor_memory_id: string;
  readonly source_topic: string;
  readonly candidate_topic: string;
  readonly match_type: string;
  readonly confidence: number;
  readonly shared_terms: readonly string[];
}

export interface TopicAliasCandidateSample {
  readonly discovery_candidate_id: string;
  readonly relation_id: string;
  readonly old_target_memory_id: string;
  readonly candidate_successor_memory_id: string;
  readonly confidence: number;
  readonly shared_terms: readonly string[];
}

export interface TopicAliasCandidate {
  readonly candidate_type: "topic_alias_candidate";
  readonly candidate_id: string;
  readonly source_topic: string;
  readonly candidate_topic: string;
  readonly supporting_discoveries: number;
  readonly suggested_action: "review_topic_alias";
  readonly apply_allowed: false;
  readonly blockers: readonly ["report_only", "requires_human_review"];
  readonly evidence: {
    readonly match_types: readonly string[];
    readonly avg_confidence: number;
    readonly samples: readonly TopicAliasCandidateSample[];
    readonly report_only: true;
  };
}

export interface TopicAliasCandidateReport {
  readonly ok: true;
  readonly generated_at: string;
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly summary: {
    readonly total_discoveries: number;
    readonly total_candidates: number;
    readonly by_action: Partial<Record<"review_topic_alias", number>>;
    readonly report_only: true;
    readonly apply_allowed: false;
  };
  readonly candidates: readonly TopicAliasCandidate[];
}

export interface BuildTopicAliasCandidateReportInput {
  readonly discoveries: readonly TopicAliasDiscoveryRow[];
  readonly generatedAt?: string;
}

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function aliasKey(sourceTopic: string, candidateTopic: string): string {
  return `${sourceTopic}\u0000${candidateTopic}`;
}

function stableId(sourceTopic: string, candidateTopic: string): string {
  const normalized = `${sourceTopic}->${candidateTopic}`
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  return `topic-alias:${normalized}`;
}

function avg(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}

export function buildTopicAliasCandidateReport(input: BuildTopicAliasCandidateReportInput): TopicAliasCandidateReport {
  const groups = new Map<string, TopicAliasDiscoveryRow[]>();
  for (const row of input.discoveries) {
    const sourceTopic = normalize(row.source_topic);
    const candidateTopic = normalize(row.candidate_topic);
    if (!sourceTopic || !candidateTopic || sourceTopic === candidateTopic) continue;
    const key = aliasKey(sourceTopic, candidateTopic);
    const rows = groups.get(key) ?? [];
    rows.push({ ...row, source_topic: sourceTopic, candidate_topic: candidateTopic });
    groups.set(key, rows);
  }

  const candidates = [...groups.values()].map((rows): TopicAliasCandidate => {
    const first = rows[0]!;
    const samples = rows
      .sort((left, right) =>
        right.confidence - left.confidence ||
        left.candidate_id.localeCompare(right.candidate_id)
      )
      .slice(0, 5)
      .map((row): TopicAliasCandidateSample => ({
        discovery_candidate_id: row.candidate_id,
        relation_id: row.relation_id,
        old_target_memory_id: row.old_target_memory_id,
        candidate_successor_memory_id: row.candidate_successor_memory_id,
        confidence: row.confidence,
        shared_terms: row.shared_terms,
      }));
    return {
      candidate_type: "topic_alias_candidate",
      candidate_id: stableId(first.source_topic, first.candidate_topic),
      source_topic: first.source_topic,
      candidate_topic: first.candidate_topic,
      supporting_discoveries: rows.length,
      suggested_action: "review_topic_alias",
      apply_allowed: false,
      blockers: ["report_only", "requires_human_review"],
      evidence: {
        match_types: [...new Set(rows.map((row) => row.match_type))].sort(),
        avg_confidence: avg(rows.map((row) => row.confidence)),
        samples,
        report_only: true,
      },
    };
  }).sort((left, right) =>
    right.supporting_discoveries - left.supporting_discoveries ||
    left.source_topic.localeCompare(right.source_topic) ||
    left.candidate_topic.localeCompare(right.candidate_topic)
  );

  return {
    ok: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    report_only: true,
    apply_allowed: false,
    summary: {
      total_discoveries: input.discoveries.length,
      total_candidates: candidates.length,
      by_action: candidates.length > 0 ? { review_topic_alias: candidates.length } : {},
      report_only: true,
      apply_allowed: false,
    },
    candidates,
  };
}
