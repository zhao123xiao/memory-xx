import type { JsonObject } from "../shared/types";
import { isGraphTestFixture } from "./graph-test-fixture";

export interface GraphSuccessorDiscoveryRepairRow {
  readonly relation_id: string;
  readonly relation_type: string;
  readonly source_memory_id: string;
  readonly source_scope_type: string;
  readonly source_scope_id: string;
  readonly target_memory_id: string;
  readonly target_scope_type: string;
  readonly target_scope_id: string;
  readonly target_title: string | null;
  readonly target_content: string;
  readonly target_topic: string | null;
  readonly target_updated_at: string | null;
  readonly source_created_by?: string | null;
  readonly source_agent_id?: string | null;
  readonly source_title?: string | null;
  readonly source_lifecycle_status?: string | null;
  readonly source_is_current?: boolean | null;
  readonly source_metadata?: JsonObject | null;
  readonly target_created_by?: string | null;
  readonly target_agent_id?: string | null;
  readonly target_metadata?: JsonObject | null;
  readonly relation_metadata?: JsonObject | null;
  readonly review_blocker: string;
}

export interface GraphSuccessorDiscoveryMemoryRow {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly title: string | null;
  readonly content: string;
  readonly topic: string | null;
  readonly lifecycle_status: string;
  readonly review_state: string;
  readonly is_current: boolean;
  readonly updated_at: string | null;
}

export type GraphSuccessorDiscoveryMatchType = "exact_topic" | "same_scope_lexical";

export interface GraphSuccessorDiscoveryTopicAliasSuggestion {
  readonly source_topic: string;
  readonly candidate_topic: string;
}

export interface GraphSuccessorDiscoveryTopicAliasSummary extends GraphSuccessorDiscoveryTopicAliasSuggestion {
  readonly count: number;
}

export interface GraphSuccessorDiscoveryCandidate {
  readonly candidate_type: "graph_successor_discovery";
  readonly candidate_id: string;
  readonly relation_id: string;
  readonly relation_type: string;
  readonly source_memory_id: string;
  readonly old_target_memory_id: string;
  readonly candidate_successor_memory_id: string;
  readonly suggested_relation_type: "supersedes";
  readonly suggested_repair_action: "retarget_relation_after_successor_approval";
  readonly match_type: GraphSuccessorDiscoveryMatchType;
  readonly topic_alias_suggestion: GraphSuccessorDiscoveryTopicAliasSuggestion | null;
  readonly confidence: number;
  readonly apply_allowed: false;
  readonly blockers: readonly ["report_only", "requires_human_review"];
  readonly evidence: {
    readonly scope: string;
    readonly topic: string;
    readonly old_target_updated_at: string | null;
    readonly candidate_updated_at: string | null;
    readonly shared_terms: readonly string[];
    readonly report_only: true;
  };
}

export interface GraphSuccessorDiscoveryCandidateReport {
  readonly ok: true;
  readonly generated_at: string;
  readonly report_only: true;
  readonly apply_allowed: false;
  readonly summary: {
    readonly total_repairs: number;
    readonly total_memories: number;
    readonly total_candidates: number;
    readonly by_suggested_action: Partial<Record<"review_successor_discovery", number>>;
    readonly by_match_type: Partial<Record<GraphSuccessorDiscoveryMatchType, number>>;
    readonly top_topic_alias_suggestions: readonly GraphSuccessorDiscoveryTopicAliasSummary[];
    readonly report_only: true;
    readonly apply_allowed: false;
  };
  readonly candidates: readonly GraphSuccessorDiscoveryCandidate[];
}

export interface BuildGraphSuccessorDiscoveryCandidateReportInput {
  readonly repairs: readonly GraphSuccessorDiscoveryRepairRow[];
  readonly memories: readonly GraphSuccessorDiscoveryMemoryRow[];
  readonly generatedAt?: string;
  readonly maxCandidatesPerRepair?: number;
}

const STOP_TERMS = new Set([
  "the",
  "and",
  "with",
  "before",
  "after",
  "uses",
  "used",
  "now",
  "memory",
]);

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function text(value: { readonly title: string | null; readonly content: string }): string {
  return `${value.title ?? ""}\n${value.content}`;
}

function tokens(value: string): Set<string> {
  const matches = value.toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/gu) ?? [];
  return new Set(matches.filter((item) => !STOP_TERMS.has(item)));
}

function sharedTerms(repair: GraphSuccessorDiscoveryRepairRow, memory: GraphSuccessorDiscoveryMemoryRow): string[] {
  const memoryTokens = tokens(text(memory));
  return [...tokens(`${repair.target_title ?? ""}\n${repair.target_content}`)]
    .filter((item) => memoryTokens.has(item))
    .sort()
    .slice(0, 8);
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function scopeKey(scopeType: string, scopeId: string): string {
  return `${normalize(scopeType)}:${scopeId}`;
}

function topicKey(value: string | null): string {
  return normalize(value);
}

function matchTypeFor(
  repair: GraphSuccessorDiscoveryRepairRow,
  memory: GraphSuccessorDiscoveryMemoryRow,
): GraphSuccessorDiscoveryMatchType {
  const repairTopic = topicKey(repair.target_topic);
  return repairTopic && topicKey(memory.topic) === repairTopic ? "exact_topic" : "same_scope_lexical";
}

function topicAliasSuggestion(
  repair: GraphSuccessorDiscoveryRepairRow,
  memory: GraphSuccessorDiscoveryMemoryRow,
  matchType: GraphSuccessorDiscoveryMatchType,
): GraphSuccessorDiscoveryTopicAliasSuggestion | null {
  const sourceTopic = topicKey(repair.target_topic);
  const candidateTopic = topicKey(memory.topic);
  if (matchType !== "same_scope_lexical" || !sourceTopic || !candidateTopic || sourceTopic === candidateTopic) {
    return null;
  }
  return {
    source_topic: sourceTopic,
    candidate_topic: candidateTopic,
  };
}

function isEligibleRepair(row: GraphSuccessorDiscoveryRepairRow): boolean {
  if (row.source_lifecycle_status !== undefined && normalize(row.source_lifecycle_status) !== "approved") {
    return false;
  }
  if (row.source_is_current === false) {
    return false;
  }
  if (isGraphTestFixture({
    sourceMetadata: row.source_metadata,
    targetMetadata: row.target_metadata,
    relationMetadata: row.relation_metadata,
    sourceCreatedBy: row.source_created_by,
    sourceAgentId: row.source_agent_id,
    targetCreatedBy: row.target_created_by,
    targetAgentId: row.target_agent_id,
    relationId: row.relation_id,
    sourceTitle: row.source_title,
    targetTitle: row.target_title,
    targetLifecycleStatus: null,
    targetIsCurrent: false,
  })) {
    return false;
  }
  return normalize(row.review_blocker) === "missing_successor" &&
    !!row.target_memory_id &&
    !!row.source_memory_id;
}

function isEligibleMemory(row: GraphSuccessorDiscoveryMemoryRow): boolean {
  return row.is_current &&
    normalize(row.lifecycle_status) === "approved" &&
    ["approved", "not_required"].includes(normalize(row.review_state));
}

function stableId(repair: GraphSuccessorDiscoveryRepairRow, memory: GraphSuccessorDiscoveryMemoryRow): string {
  return `graph-successor-discovery:${repair.relation_id}:${repair.target_memory_id}:${memory.id}`;
}

function increment<TKey extends string>(target: Partial<Record<TKey, number>>, key: TKey): void {
  target[key] = (target[key] ?? 0) + 1;
}

function aliasKey(alias: GraphSuccessorDiscoveryTopicAliasSuggestion): string {
  return `${alias.source_topic}\u0000${alias.candidate_topic}`;
}

function topTopicAliasSuggestions(
  candidates: readonly GraphSuccessorDiscoveryCandidate[],
): readonly GraphSuccessorDiscoveryTopicAliasSummary[] {
  const counts = new Map<string, { alias: GraphSuccessorDiscoveryTopicAliasSuggestion; count: number }>();
  for (const candidate of candidates) {
    if (!candidate.topic_alias_suggestion) continue;
    const key = aliasKey(candidate.topic_alias_suggestion);
    const current = counts.get(key);
    counts.set(key, {
      alias: candidate.topic_alias_suggestion,
      count: (current?.count ?? 0) + 1,
    });
  }
  return [...counts.values()]
    .sort((left, right) =>
      right.count - left.count ||
      left.alias.source_topic.localeCompare(right.alias.source_topic) ||
      left.alias.candidate_topic.localeCompare(right.alias.candidate_topic)
    )
    .slice(0, 5)
    .map((item) => ({
      ...item.alias,
      count: item.count,
    }));
}

export function buildGraphSuccessorDiscoveryCandidateReport(
  input: BuildGraphSuccessorDiscoveryCandidateReportInput,
): GraphSuccessorDiscoveryCandidateReport {
  const maxCandidatesPerRepair = input.maxCandidatesPerRepair ?? 3;
  const eligibleMemories = input.memories.filter(isEligibleMemory);
  const candidates: GraphSuccessorDiscoveryCandidate[] = [];

  for (const repair of input.repairs.filter(isEligibleRepair)) {
    const repairScope = scopeKey(repair.target_scope_type, repair.target_scope_id);
    const repairCandidates = eligibleMemories
      .filter((memory) => memory.id !== repair.target_memory_id)
      .filter((memory) => scopeKey(memory.scope_type, memory.scope_id) === repairScope)
      .map((memory) => {
        const terms = sharedTerms(repair, memory);
        const matchType = matchTypeFor(repair, memory);
        const timeBonus = timestamp(memory.updated_at) > timestamp(repair.target_updated_at) ? 0.08 : 0;
        const matchBonus = matchType === "exact_topic" ? 0.06 : 0;
        const confidence = Math.min(0.92, 0.58 + Math.min(terms.length, 5) * 0.06 + timeBonus + matchBonus);
        return { memory, terms, confidence, matchType };
      })
      .filter((item) =>
        item.confidence >= 0.7 &&
        (item.matchType === "exact_topic" ? item.terms.length >= 2 : item.terms.length >= 3)
      )
      .sort((left, right) =>
        right.confidence - left.confidence ||
        timestamp(right.memory.updated_at) - timestamp(left.memory.updated_at) ||
        left.memory.id.localeCompare(right.memory.id)
      )
      .slice(0, maxCandidatesPerRepair);

    for (const item of repairCandidates) {
      candidates.push({
        candidate_type: "graph_successor_discovery",
        candidate_id: stableId(repair, item.memory),
        relation_id: repair.relation_id,
        relation_type: repair.relation_type,
        source_memory_id: repair.source_memory_id,
        old_target_memory_id: repair.target_memory_id,
        candidate_successor_memory_id: item.memory.id,
        suggested_relation_type: "supersedes",
        suggested_repair_action: "retarget_relation_after_successor_approval",
        match_type: item.matchType,
        topic_alias_suggestion: topicAliasSuggestion(repair, item.memory, item.matchType),
        confidence: item.confidence,
        apply_allowed: false,
        blockers: ["report_only", "requires_human_review"],
        evidence: {
          scope: repairScope,
          topic: topicKey(repair.target_topic),
          old_target_updated_at: repair.target_updated_at,
          candidate_updated_at: item.memory.updated_at,
          shared_terms: item.terms,
          report_only: true,
        },
      });
    }
  }

  const sorted = candidates.sort((left, right) =>
    left.relation_id.localeCompare(right.relation_id) ||
    right.confidence - left.confidence ||
    left.candidate_successor_memory_id.localeCompare(right.candidate_successor_memory_id)
  );
  const byMatchType: Partial<Record<GraphSuccessorDiscoveryMatchType, number>> = {};
  for (const candidate of sorted) increment(byMatchType, candidate.match_type);
  return {
    ok: true,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    report_only: true,
    apply_allowed: false,
    summary: {
      total_repairs: input.repairs.length,
      total_memories: input.memories.length,
      total_candidates: sorted.length,
      by_suggested_action: sorted.length > 0 ? { review_successor_discovery: sorted.length } : {},
      by_match_type: byMatchType,
      top_topic_alias_suggestions: topTopicAliasSuggestions(sorted),
      report_only: true,
      apply_allowed: false,
    },
    candidates: sorted,
  };
}
