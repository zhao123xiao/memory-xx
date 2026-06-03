import {
  RECALL_RERANK_CONFIG,
  hasCloseHeaderMatch,
  normalizeComparableText,
  normalizeSourcePath,
  queryMatchesAlias,
} from "./query-aliases";
import {
  countExtraClusterCueMatches,
  exactComparableMatch,
  unique,
  type CandidateSignals
} from "./reranker-signals";
import type { CandidateEvaluation, ClusterSiblingEvaluation } from "./reranker-types";
import type { QueryConstraints } from "./types";

const STABLE_PLAN_SIGNALS = [
  /已产出/u,
  /已形成/u,
  /已完成/u,
  /已确认/u,
  /已落地/u,
  /已建立/u,
  /已补齐/u,
  /已为/u,
  /已核验/u,
  /已补入/u,
  /当前状态[：:]/u,
  /长期目标/u,
  /项目.{0,6}当前阶段[：:]/u,
  /满分定义/u,
  /原则[：:]/u,
  /目标[：:]/u
];

const STALE_CHECKLIST_SIGNALS = [
  /^继续修复/u,
  /^继续扩展/u,
  /^继续优化/u,
  /^继续增强/u,
  /^继续明确/u,
  /^继续补充/u,
  /^继续把/u,
  /^若后续/u,
  /^若仍需/u,
  /^视需要/u,
  /^下一步[（(]/u,
  /^后续重点/u,
  /^后续除非/u,
  /^还需根据/u,
  /^仍需/u,
  /^编写/u,
  /^推进 T/u,
  /^把 .+ 继续脚本化/u,
  /^回头修复/u
];

function computeLifecyclePriority(signals: CandidateSignals): number {
  const content = signals.normalized_content;
  const title = signals.normalized_title;
  const combined = title ? `${title} ${content}` : content;

  let stableScore = 0;
  for (const pattern of STABLE_PLAN_SIGNALS) {
    if (pattern.test(combined)) {
      stableScore += 0.18;
    }
  }

  let staleScore = 0;
  for (const pattern of STALE_CHECKLIST_SIGNALS) {
    if (pattern.test(content)) {
      staleScore -= 0.22;
    }
  }

  return stableScore + staleScore;
}

/**
 * Returns the value to add to clusterWinnerPriority when the query contains a
 * specific alias identifier (e.g. "memory-framework-9.5-execution") and the
 * candidate's memory_id is an exact match for that identifier.
 *
 * Unlike the existing `exactMemoryId` check (which requires the FULL query string
 * to equal the memory_id), this fires when the memory_id appears as a substring
 * within the query — covering cases like:
 *   query  = "项目 memory-framework-9.5-execution 当前阶段 当前状态"
 *   memory_id = "memory-framework-9.5-execution"
 *
 * The check is done in two forms to handle normalisations that alter separators:
 * 1. raw memory_id as substring of the normalised query (handles hyphenated IDs)
 * 2. normalised memory_id as substring of the normalised query (handles ID-only queries)
 */
function exactAliasMatchBoost(
  candidate: CandidateEvaluation,
  constraints: QueryConstraints
): number {
  const rawMemoryId = candidate.candidate.record.memory_id;
  if (!rawMemoryId) {
    return 0;
  }

  const normalizedMemoryId = normalizeComparableText(rawMemoryId);
  const normalizedQuery = constraints.normalized_query;

  // Find which alias group(s) the query matched — the query's identifier(s)
  // tell us what exact project/project-label to steer toward.
  for (const aliasGroup of RECALL_RERANK_CONFIG.alias_groups) {
    if (!queryMatchesAlias(normalizedQuery, aliasGroup.aliases)) {
      continue;
    }

    // Check if the memory_id (raw or normalised) appears in the query.
    // This handles both hyphenated IDs like "memory-framework-9.5-execution"
    // and the normalised form "memory framework 9 5 execution".
    const rawInQuery = normalizedQuery.includes(rawMemoryId);
    const normalizedInQuery = normalizedQuery.includes(normalizedMemoryId);

    if (rawInQuery || normalizedInQuery) {
      return 2.8;
    }
  }

  return 0;
}

function clusterWinnerPriority(
  candidate: CandidateEvaluation,
  constraints: QueryConstraints
): number {
  const exactTitle = exactComparableMatch(
    constraints.normalized_query,
    candidate.candidate.record.title
  );
  const exactMemoryId = exactComparableMatch(
    constraints.normalized_query,
    candidate.candidate.record.memory_id
  );
  const normalizedQueryPath = normalizeSourcePath(constraints.normalized_query);
  const exactSourcePath =
    candidate.signals.normalized_source_paths.some(
      (path) => path === normalizedQueryPath
    ) ||
    candidate.signals.source_basenames.some(
      (basename) => basename === normalizedQueryPath
    );
  const sectionHeaderMatch = candidate.signals.normalized_sections.some((section) =>
    hasCloseHeaderMatch(constraints.normalized_query, section)
  );
  const projectLedgerPriority = candidate.signals.normalized_source_paths.includes(
    "memory/projects.md"
  )
    ? 0.1
    : 0;
  const dailyPenalty = candidate.signals.is_daily_log_source ? -0.1 : 0;
  const contentCoverage = Math.min(candidate.candidate.record.content.length / 1000, 0.08);
  const extraCueCount = countExtraClusterCueMatches(candidate.signals, constraints);
  const lifecyclePriority = computeLifecyclePriority(candidate.signals);
  const aliasBoost = exactAliasMatchBoost(candidate, constraints);

  return (
    aliasBoost +
    (exactMemoryId ? 3.4 : 0) +
    (exactTitle ? 3 : 0) +
    (exactSourcePath ? 2 : 0) +
    (sectionHeaderMatch ? 1.5 : 0) +
    (candidate.signals.is_canonical_status_row ? 1.6 : 0) +
    (candidate.signals.is_canonical_source ? 1.2 : 0) +
    projectLedgerPriority +
    dailyPenalty +
    contentCoverage +
    lifecyclePriority +
    extraCueCount * 0.45 +
    candidate.score * 0.2
  );
}

function clusterSiblingPackingPriority(
  sibling: ClusterSiblingEvaluation,
  constraints: QueryConstraints
): number {
  const exactTitle = exactComparableMatch(
    constraints.normalized_query,
    sibling.candidate.candidate.record.title
  );
  const exactMemoryId = exactComparableMatch(
    constraints.normalized_query,
    sibling.candidate.candidate.record.memory_id
  );
  const aliasBoost = exactAliasMatchBoost(sibling.candidate, constraints);
  const lifecyclePriority = computeLifecyclePriority(sibling.candidate.signals);
  const canonicalSourcePriority = sibling.candidate.signals.is_canonical_source ? 0.18 : 0;
  const dailyPenalty = sibling.candidate.signals.is_daily_log_source ? -0.18 : 0;

  return (
    sibling.extraCueCount * 0.8 +
    (sibling.sameTitleAsWinner ? 0.25 : 0) +
    aliasBoost +
    (exactMemoryId ? 0.6 : 0) +
    (exactTitle ? 0.3 : 0) +
    lifecyclePriority +
    canonicalSourcePriority +
    dailyPenalty +
    sibling.candidate.score * 0.2
  );
}

function buildSiblingPackingOrder(
  winner: CandidateEvaluation,
  siblings: CandidateEvaluation[],
  constraints: QueryConstraints
): ClusterSiblingEvaluation[] {
  return siblings
    .map((candidate) => ({
      candidate,
      extraCueCount: countExtraClusterCueMatches(candidate.signals, constraints),
      sameTitleAsWinner:
        Boolean(winner.signals.normalized_title) &&
        winner.signals.normalized_title === candidate.signals.normalized_title
    }))
    .sort((left, right) => {
      const priorityGap =
        clusterSiblingPackingPriority(right, constraints) -
        clusterSiblingPackingPriority(left, constraints);
      if (priorityGap !== 0) {
        return priorityGap;
      }
      if (right.extraCueCount !== left.extraCueCount) {
        return right.extraCueCount - left.extraCueCount;
      }
      if (Number(right.sameTitleAsWinner) !== Number(left.sameTitleAsWinner)) {
        return Number(right.sameTitleAsWinner) - Number(left.sameTitleAsWinner);
      }
      if (
        Number(right.candidate.signals.is_daily_log_source) !==
        Number(left.candidate.signals.is_daily_log_source)
      ) {
        return (
          Number(left.candidate.signals.is_daily_log_source) -
          Number(right.candidate.signals.is_daily_log_source)
        );
      }
      if (right.candidate.score !== left.candidate.score) {
        return right.candidate.score - left.candidate.score;
      }
      return (
        right.candidate.candidate.record.content.length -
        left.candidate.candidate.record.content.length
      );
    });
}

export function applyClusterAwareArbitration(
  evaluations: CandidateEvaluation[],
  constraints: QueryConstraints
): CandidateEvaluation[] {
  const grouped = new Map<string, CandidateEvaluation[]>();

  for (const evaluation of evaluations) {
    if (!evaluation.cluster_key) {
      continue;
    }

    const bucket = grouped.get(evaluation.cluster_key) ?? [];
    bucket.push(evaluation);
    grouped.set(evaluation.cluster_key, bucket);
  }

  const adjustments = new Map<
    string,
    {
      scoreDelta: number;
      reasons: string[];
    }
  >();

  const protectedSiblingIds = new Set<string>();

  for (const [clusterKey, bucket] of grouped) {
    if (bucket.length < 2) {
      continue;
    }

    const ranked = [...bucket].sort((left, right) => {
      const priorityGap =
        clusterWinnerPriority(right, constraints) -
        clusterWinnerPriority(left, constraints);
      if (priorityGap !== 0) {
        return priorityGap;
      }

      return right.score - left.score;
    });

    const winner = ranked[0];
    const winnerAdjustment = adjustments.get(winner.candidate.memory_id) ?? {
      scoreDelta: 0,
      reasons: []
    };
    winnerAdjustment.reasons.push("cluster_winner_selected");

    if (winner.signals.is_canonical_source) {
      winnerAdjustment.scoreDelta += 0.16;
      winnerAdjustment.reasons.push("canonical_cluster_bonus");
    }

    if (winner.signals.is_canonical_status_row) {
      winnerAdjustment.scoreDelta += 0.12;
      winnerAdjustment.reasons.push("status_row_bonus");
    }

    adjustments.set(winner.candidate.memory_id, winnerAdjustment);

    const packedSiblings = buildSiblingPackingOrder(
      winner,
      ranked.slice(1),
      constraints
    ).slice(0, 4);

    for (const [index, sibling] of packedSiblings.entries()) {
      const packedAdjustment = adjustments.get(sibling.candidate.candidate.memory_id) ?? {
        scoreDelta: 0,
        reasons: []
      };
      packedAdjustment.scoreDelta += Math.max(0.08 - index * 0.015, 0.03);
      packedAdjustment.reasons.push("same_cluster_exact_id_candidate");
      if (sibling.extraCueCount > 0) {
        packedAdjustment.scoreDelta += Math.min(sibling.extraCueCount * 0.04, 0.16);
        packedAdjustment.reasons.push("same_cluster_content_cue_bonus");
      }
      adjustments.set(sibling.candidate.candidate.memory_id, packedAdjustment);
      protectedSiblingIds.add(sibling.candidate.candidate.memory_id);
    }

    for (const loser of ranked.slice(1)) {
      const loserAdjustment = adjustments.get(loser.candidate.memory_id) ?? {
        scoreDelta: 0,
        reasons: []
      };

      if (
        !protectedSiblingIds.has(loser.candidate.memory_id) &&
        winner.signals.normalized_title &&
        loser.signals.normalized_title &&
        winner.signals.normalized_title === loser.signals.normalized_title
      ) {
        loserAdjustment.scoreDelta -= 0.08;
        loserAdjustment.reasons.push("same_title_sibling_penalty");
      }

      if (loser.signals.is_daily_log_source && !winner.signals.is_daily_log_source) {
        loserAdjustment.scoreDelta -= 0.04;
        loserAdjustment.reasons.push(`cluster_loser:${clusterKey}`);
      }

      adjustments.set(loser.candidate.memory_id, loserAdjustment);
    }
  }

  return evaluations
    .map((evaluation) => {
      const adjustment = adjustments.get(evaluation.candidate.memory_id);
      if (!adjustment) {
        return evaluation;
      }

      return {
        ...evaluation,
        score: evaluation.score + adjustment.scoreDelta,
        why_matched: unique([...evaluation.why_matched, ...adjustment.reasons])
      };
    })
    .sort((left, right) => right.score - left.score);
}

