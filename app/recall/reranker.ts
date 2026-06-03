import { deriveClusterKey } from "./cluster-key";
import { applyClusterAwareArbitration } from "./reranker-cluster";
import { buildCandidateSignals, unique } from "./reranker-signals";
import {
  clamp,
  computeGraphPathBonus,
  computeIntentEvidenceBonus,
  computeRecencyScopeBonus,
  evaluateConfiguredBonuses,
  graphEvidenceWeight,
  normalizeScore,
  readMemoryStrength,
  recencyBoost,
} from "./reranker-bonuses";
import type { CandidateEvaluation } from "./reranker-types";
import {
  QueryType,
  type QueryConstraints,
  type RetrieverCandidate
} from "./types";

export function rerankCandidates(
  candidates: RetrieverCandidate[],
  constraints: QueryConstraints
): RetrieverCandidate[] {
  if (!constraints.classification.rerank_enabled) {
    return [...candidates].sort((left, right) => right.score - left.score);
  }

  const useRrfFormula = candidates.some((candidate) => candidate.rrf_score !== undefined);
  const rrfValues = candidates.map((candidate) => candidate.rrf_score ?? 0);
  const lexicalValues = candidates.map((candidate) => candidate.lexical_score ?? 0);
  const vectorValues = candidates.map((candidate) => candidate.vector_score ?? 0);
  const graphValues = candidates.map((candidate) => candidate.graph_score ?? 0);
  const graphWeight = graphEvidenceWeight(constraints.classification.query_type);

  const evaluated = [...candidates].map((candidate) => {
    const lexicalScore = candidate.lexical_score ?? 0;
    const vectorScore = candidate.vector_score ?? 0;
    const graphScore = candidate.graph_score ?? 0;
    const matchedCoverage =
      candidate.matched_terms.length / Math.max(constraints.query_terms.length, 1);
    const hybridBoost = candidate.source_retrievers.length > 1 ? 0.15 : 0;
    const exactCoverageBoost = matchedCoverage >= 1 ? 0.08 : matchedCoverage * 0.04;
    const timeBoost =
      constraints.classification.query_type === QueryType.TimelineHistory ||
      constraints.classification.query_type === QueryType.ProjectContext
        ? recencyBoost(candidate)
        : 0;
    const configuredBonus = evaluateConfiguredBonuses(candidate, constraints);
    const signals = buildCandidateSignals(candidate);
    const cluster = deriveClusterKey(candidate, constraints);
    const metadataBonusRaw = configuredBonus.score_delta;
    const metadataBonusCapped = useRrfFormula ? clamp(metadataBonusRaw, -0.25, 0.25) : metadataBonusRaw;
    const recencyScopeBonus = useRrfFormula ? computeRecencyScopeBonus(candidate, constraints) : timeBoost;
    const graphPathBonus = useRrfFormula ? computeGraphPathBonus(candidate, constraints) : 0;
    const intentEvidenceBonus = computeIntentEvidenceBonus(signals, constraints);

    const nextScore = useRrfFormula
      ? normalizeScore(candidate.rrf_score ?? 0, rrfValues) * 0.35 +
        normalizeScore(lexicalScore, lexicalValues) * 0.18 +
        normalizeScore(vectorScore, vectorValues) * 0.17 +
        normalizeScore(graphScore, graphValues) * graphWeight +
        readMemoryStrength(candidate) * 0.10 +
        metadataBonusCapped * 0.10 +
        recencyScopeBonus * 0.05 +
        graphPathBonus +
        intentEvidenceBonus
      : lexicalScore * 0.45 +
        vectorScore * 0.45 +
        hybridBoost +
        exactCoverageBoost +
        timeBoost +
        configuredBonus.score_delta +
        intentEvidenceBonus;

    return {
      candidate: {
        ...candidate,
        metadata_bonus_raw: metadataBonusRaw,
        metadata_bonus_capped: metadataBonusCapped,
        recency_scope_bonus: useRrfFormula ? recencyScopeBonus : undefined
      },
      signals,
      score: nextScore,
      cluster_key: cluster.key,
      why_matched: unique([
        ...candidate.why_matched,
        "minimal_rerank_applied",
        ...(graphPathBonus > 0 ? [`graph_path_bonus:${graphPathBonus.toFixed(3)}`] : []),
        ...(intentEvidenceBonus > 0 ? [`intent_evidence_bonus:${intentEvidenceBonus.toFixed(3)}`] : []),
        ...configuredBonus.why_matched,
        ...cluster.reasons
      ])
    } satisfies CandidateEvaluation;
  });

  return applyClusterAwareArbitration(evaluated, constraints).map((evaluation) => ({
    ...evaluation.candidate,
    score: evaluation.score,
    local_score: evaluation.score,
    final_score: evaluation.score,
    cluster_key: evaluation.cluster_key,
    why_matched: [...evaluation.why_matched]
  }));
}
