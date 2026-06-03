import {
  RECALL_RERANK_CONFIG,
  hasCloseHeaderMatch,
  normalizeComparableText,
  normalizeSourcePath,
  queryMatchesAlias,
} from "./query-aliases";
import {
  aliasGroupMatchesSignals,
  buildCandidateSignals,
  exactComparableMatch,
  type CandidateSignals
} from "./reranker-signals";
import type { RerankAdjustment } from "./reranker-types";
import {
  QueryType,
  type QueryConstraints,
  type RetrieverCandidate
} from "./types";

export function recencyBoost(candidate: RetrieverCandidate): number {
  const updatedAt = candidate.record.updated_at;
  if (!updatedAt) {
    return 0;
  }

  const ageMs = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(ageMs) || ageMs <= 0) {
    return 0.05;
  }

  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays <= 7) {
    return 0.05;
  }

  if (ageDays <= 30) {
    return 0.02;
  }

  return 0;
}

export function evaluateConfiguredBonuses(
  candidate: RetrieverCandidate,
  constraints: QueryConstraints
): RerankAdjustment {
  const normalizedQuery = normalizeComparableText(constraints.normalized_query);
  const normalizedQueryPath = normalizeSourcePath(constraints.normalized_query);
  const signals = buildCandidateSignals(candidate);
  const reasons: string[] = [];
  let scoreDelta = 0;

  const exactTitleMatch = exactComparableMatch(normalizedQuery, candidate.record.title);
  if (exactTitleMatch) {
    scoreDelta +=
      RECALL_RERANK_CONFIG.exact_match_bonus.exact_title_match_bonus;
    reasons.push("exact_title_match_bonus");
  }

  const exactMemoryIdMatch = exactComparableMatch(
    normalizedQuery,
    candidate.record.memory_id
  );
  if (exactMemoryIdMatch) {
    scoreDelta +=
      RECALL_RERANK_CONFIG.exact_match_bonus.exact_memory_id_match_bonus;
    reasons.push("exact_memory_id_match_bonus");
  }

  const sourcePathMatch =
    signals.normalized_source_paths.some(
      (path) => Boolean(path) && path === normalizedQueryPath
    ) ||
    signals.source_basenames.some(
      (basename) => Boolean(basename) && basename === normalizedQueryPath
    );
  if (sourcePathMatch) {
    scoreDelta += RECALL_RERANK_CONFIG.exact_match_bonus.source_path_match_bonus;
    reasons.push("source_path_match_bonus");
  }

  const sectionHeaderMatch = signals.normalized_sections.some((section) =>
    hasCloseHeaderMatch(normalizedQuery, section)
  );
  if (sectionHeaderMatch) {
    scoreDelta += RECALL_RERANK_CONFIG.exact_match_bonus.section_header_match_bonus;
    reasons.push("section_header_match_bonus");
  }

  for (const aliasGroup of RECALL_RERANK_CONFIG.alias_groups) {
    if (!queryMatchesAlias(constraints.normalized_query, aliasGroup.aliases)) {
      continue;
    }

    if (aliasGroupMatchesSignals(aliasGroup, signals, constraints.classification.query_type)) {
      scoreDelta += aliasGroup.bonus;
      reasons.push(`query_alias_bonus:${aliasGroup.key}`);
    }
  }

  if (signals.is_canonical_source) {
    scoreDelta +=
      RECALL_RERANK_CONFIG.canonical_sort_bonus.canonical_source_path_bonus;
    reasons.push("canonical_source_path_bonus");
  }

  if (signals.is_canonical_source && (exactTitleMatch || sourcePathMatch)) {
    scoreDelta +=
      RECALL_RERANK_CONFIG.canonical_sort_bonus.canonical_exact_match_bonus;
    reasons.push("canonical_exact_match_bonus");
  }

  if (signals.is_canonical_source && exactTitleMatch) {
    scoreDelta +=
      RECALL_RERANK_CONFIG.canonical_sort_bonus.same_title_canonical_bonus;
    reasons.push("same_title_canonical_bonus");
  }

  if (signals.is_canonical_status_row) {
    scoreDelta +=
      RECALL_RERANK_CONFIG.canonical_sort_bonus.canonical_status_row_bonus;
    reasons.push("canonical_status_row_bonus");
  }

  if (
    signals.is_daily_log_source &&
    RECALL_RERANK_CONFIG.canonical_sort_bonus.non_timeline_daily_log_query_types.includes(
      constraints.classification.query_type
    ) &&
    !exactTitleMatch &&
    !sourcePathMatch
  ) {
    scoreDelta -= RECALL_RERANK_CONFIG.canonical_sort_bonus.daily_log_penalty;
    reasons.push("daily_log_penalty");
  }

  // Memory-type aware priority routing: boost structured fact/preference/decision records
  // when their type matches the query intent.
  const memoryType = signals.memory_type;
  if (memoryType) {
    const queryType = constraints.classification.query_type;
    const memoryTypeBoosts: Record<string, { match: QueryType[]; delta: number; universal?: number }> = {
      fact: {
        match: [
          QueryType.ExactLookup,
          QueryType.PreferenceLookup,
          QueryType.DecisionLookup,
          QueryType.SourceAudit,
          QueryType.EntityProfile,
          QueryType.DebugRecall
        ],
        delta: 0.25,
        universal: 0.10
      },
      preference: { match: [QueryType.PreferenceLookup], delta: 0.20 },
      decision: { match: [QueryType.DecisionLookup, QueryType.ProjectContext, QueryType.DebugRecall], delta: 0.22 },
      constraint: { match: [QueryType.DecisionLookup, QueryType.ProjectContext], delta: 0.18 },
      lesson: { match: [QueryType.ExploratorySemantic, QueryType.ProjectContext], delta: 0.12 },
      identity: { match: [QueryType.EntityProfile], delta: 0.30, universal: 0.08 },
      ops: { match: [QueryType.DebugRecall, QueryType.ProjectContext], delta: 0.25, universal: 0.06 }
    };
    const boost = memoryTypeBoosts[memoryType];
    if (boost) {
      if (boost.match.includes(queryType)) {
        scoreDelta += boost.delta;
        reasons.push(`memory_type_${memoryType}_match`);
      }
      if (boost.universal) {
        scoreDelta += boost.universal;
        reasons.push(`memory_type_${memoryType}_universal`);
      }
    }
  }

  return {
    score_delta: scoreDelta,
    why_matched: reasons
  };
}

export function normalizeScore(value: number, values: readonly number[]): number {
  const finite = values.filter((item) => Number.isFinite(item));
  if (finite.length === 0) return 0;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (max === min) return value > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function readMemoryStrength(candidate: RetrieverCandidate): number {
  const strength = candidate.record.memory_strength;
  return typeof strength === "number" && Number.isFinite(strength)
    ? clamp(strength, 0, 1)
    : 1;
}

function selectRecordTime(candidate: RetrieverCandidate): string | undefined {
  return candidate.record.valid_at ?? candidate.record.observed_at ?? candidate.record.updated_at ?? candidate.record.created_at;
}

export function computeRecencyScopeBonus(candidate: RetrieverCandidate, constraints: QueryConstraints): number {
  let bonus = 0;
  const selectedTime = selectRecordTime(candidate);
  if (selectedTime) {
    const ageMs = Date.now() - Date.parse(selectedTime);
    if (Number.isFinite(ageMs) && ageMs >= 0) {
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      if (ageDays <= 1) bonus += 0.10;
      else if (ageDays <= 7) bonus += 0.05;
    }
  }

  const firstScope = constraints.allowed_scope_set[0];
  if (firstScope && firstScope.type === candidate.record.scope_type && firstScope.id === candidate.record.scope_id) {
    bonus += 0.05;
  } else if (constraints.allowed_scope_set.some((scope) => scope.type === candidate.record.scope_type && scope.id === candidate.record.scope_id)) {
    bonus += 0.02;
  }

  const taskId = constraints.query_context?.task_id;
  if (taskId) {
    const haystack = [
      candidate.record.title,
      candidate.record.content,
      candidate.record.source?.path,
      candidate.record.project_id
    ].filter(Boolean).join(" ").toLowerCase();
    if (haystack.includes(taskId.toLowerCase())) {
      bonus += 0.05;
    }
  }

  return clamp(bonus, 0, 0.15);
}

export function graphEvidenceWeight(queryType: QueryType): number {
  switch (queryType) {
    case QueryType.DecisionLookup:
    case QueryType.TimelineHistory:
    case QueryType.HistoricalQuery:
    case QueryType.DebugRecall:
    case QueryType.DebugAuditQuery:
      return 0.18;
    case QueryType.EntityProfile:
    case QueryType.ProjectContext:
    case QueryType.CurrentStateQuery:
    case QueryType.EpisodeLookup:
      return 0.22;
    case QueryType.ExactLookup:
    case QueryType.SourceAudit:
    case QueryType.PreferenceLookup:
    case QueryType.PreferenceQuery:
    case QueryType.ProcedureQuery:
      return 0.06;
    default:
      return 0.08;
  }
}

export function computeGraphPathBonus(candidate: RetrieverCandidate, constraints: QueryConstraints): number {
  if (!candidate.source_retrievers.includes("graph") && (candidate.graph_score ?? 0) <= 0) {
    return 0;
  }
  const graphAwareQuery =
    constraints.classification.query_type === QueryType.ProjectContext ||
    constraints.classification.query_type === QueryType.EntityProfile ||
    constraints.classification.query_type === QueryType.DecisionLookup ||
    constraints.classification.query_type === QueryType.TimelineHistory ||
    constraints.classification.query_type === QueryType.HistoricalQuery ||
    constraints.classification.query_type === QueryType.DebugRecall ||
    constraints.classification.query_type === QueryType.DebugAuditQuery ||
    constraints.classification.query_type === QueryType.EpisodeLookup;
  const queryMentionsGraphPath =
    /(?:graph|关系|关联|路径|relation|entity|实体|依赖|depends|timeline|时间线|阶段|gate|模块)/iu.test(
      constraints.query_context?.original_query ?? constraints.normalized_query
    );
  if (!graphAwareQuery && !queryMentionsGraphPath) {
    return 0;
  }
  const hasEvidence =
    (candidate.graph_entities?.length ?? 0) > 0 ||
    (candidate.graph_relations?.length ?? 0) > 0 ||
    (candidate.graph_evidence_sources?.length ?? 0) > 0 ||
    candidate.why_matched.some((reason) =>
      reason.includes("entity_exact") ||
      reason.includes("relation_path") ||
      reason.includes("source_evidence")
    );
  if (!hasEvidence) {
    return 0;
  }

  const graphRank = candidate.graph_rank;
  const rankBonus = typeof graphRank === "number" && Number.isFinite(graphRank)
    ? Math.max(0, 0.16 - (graphRank - 1) * 0.018)
    : 0.06;
  const evidenceBonus =
    candidate.why_matched.some((reason) => reason.includes("source_evidence")) ||
    (candidate.graph_evidence_sources?.length ?? 0) > 0
      ? 0.08
      : 0;
  const relationBonus =
    candidate.why_matched.some((reason) => reason.includes("relation_path")) ||
    (candidate.graph_relations?.length ?? 0) > 0
      ? 0.08
      : 0;
  const entityExactBonus = candidate.why_matched.some((reason) => reason.includes("entity_exact")) ? 0.07 : 0;
  const graphSourceBonus = candidate.source_retrievers.includes("graph") ? 0.04 : 0;
  const termCoverage = candidate.matched_terms.length / Math.max(constraints.query_terms.length, 1);
  const coverageBonus = termCoverage >= 0.5 ? Math.min(0.06, termCoverage * 0.05) : 0;

  return clamp(rankBonus + evidenceBonus + relationBonus + entityExactBonus + graphSourceBonus + coverageBonus, 0, 0.38);
}

function containsAll(value: string, terms: readonly string[]): boolean {
  return terms.every((term) => value.includes(term));
}

export function computeIntentEvidenceBonus(
  signals: CandidateSignals,
  constraints: QueryConstraints
): number {
  const query = normalizeComparableText(constraints.normalized_query);
  const text = `${signals.normalized_title} ${signals.normalized_content}`;
  let bonus = 0;

  if (
    query.includes("cutover") &&
    (query.includes("阶段") || query.includes("划分") || query.includes("m4") || query.includes("m5"))
  ) {
    if (containsAll(text, ["m4", "m5"])) {
      bonus += 0.18;
    }
    if (text.includes("切读") || text.includes("灰度切读")) {
      bonus += 0.07;
    }
    if (text.includes("切写") || text.includes("唯一写") || text.includes("新写")) {
      bonus += 0.07;
    }
    if (text.includes("回滚") || text.includes("rollback")) {
      bonus += 0.03;
    }
  }

  if (
    query.includes("review") &&
    query.includes("approve") &&
    query.includes("reject") &&
    (query.includes("流程") || query.includes("procedure") || query.includes("相关"))
  ) {
    if (containsAll(text, ["approve", "reject"])) {
      bonus += 0.14;
    }
    if (text.includes("review") || text.includes("审批")) {
      bonus += 0.07;
    }
    if (text.includes("lifecycle") || text.includes("生命周期")) {
      bonus += 0.05;
    }
    if (text.includes("archive") || text.includes("supersede") || text.includes("tombstone")) {
      bonus += 0.04;
    }
  }

  if (query.includes("主账") || query.includes("source of truth")) {
    if (
      text.includes("markdown") &&
      (text.includes("主账") || text.includes("source of truth"))
    ) {
      bonus += 0.20;
    }
    if (
      signals.normalized_title.includes("decisions md") ||
      signals.normalized_title.includes("facts md") ||
      signals.normalized_source_paths.some((path) =>
        path === "memory/decisions.md" || path === "memory/facts.md" || path === "memory.md"
      )
    ) {
      bonus += 0.10;
    }
  }

  return clamp(bonus, 0, 0.30);
}
