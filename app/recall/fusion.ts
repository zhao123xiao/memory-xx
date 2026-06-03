import {
  QueryType,
  type QueryClassification,
  type RecallFusionAudit,
  type RetrieverCandidate
} from "./types";

const DEFAULT_RRF_K = 20;

type FusionSource = "lexical" | "vector" | "graph";

function weightForSource(classification: QueryClassification): Record<FusionSource, number> {
  switch (classification.query_type) {
    case QueryType.ExactLookup:
    case QueryType.SourceAudit:
    case QueryType.PreferenceLookup:
    case QueryType.PreferenceQuery:
    case QueryType.ProcedureQuery:
      return { lexical: 1.25, vector: 0.8, graph: 0.75 };
    case QueryType.DecisionLookup:
    case QueryType.TimelineHistory:
    case QueryType.HistoricalQuery:
    case QueryType.DebugRecall:
    case QueryType.DebugAuditQuery:
      return { lexical: 1.0, vector: 0.8, graph: 1.9 };
    case QueryType.EntityProfile:
    case QueryType.ProjectContext:
    case QueryType.CurrentStateQuery:
    case QueryType.EpisodeLookup:
      return { lexical: 0.85, vector: 0.95, graph: 2.1 };
    case QueryType.ExploratorySemantic:
      return { lexical: 0.9, vector: 1.1, graph: 0.95 };
    default:
      return { lexical: 1.0, vector: 1.0, graph: 1.0 };
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function rrfScore(weight: number, rank: number, k: number): number {
  return weight / (k + rank);
}

function blendSourceScore(existing: number | undefined, candidate: number | undefined): number | undefined {
  if (existing === undefined) return candidate;
  if (candidate === undefined) return existing;
  const high = Math.max(existing, candidate);
  const low = Math.min(existing, candidate);
  return (0.7 * high) + (0.3 * low);
}

export function fuseRecallCandidatesRrf(input: {
  readonly lexical: readonly RetrieverCandidate[];
  readonly vector: readonly RetrieverCandidate[];
  readonly graph?: readonly RetrieverCandidate[];
  readonly classification: QueryClassification;
  readonly graph_guard?: {
    readonly cap_weight?: number;
    readonly reason?: string;
  };
  readonly k?: number;
}): { candidates: RetrieverCandidate[]; audit: RecallFusionAudit } {
  const k = input.k ?? DEFAULT_RRF_K;
  const weights = weightForSource(input.classification);
  const originalGraphWeight = weights.graph;
  if (input.graph_guard?.cap_weight !== undefined && input.graph_guard.cap_weight < weights.graph) {
    weights.graph = input.graph_guard.cap_weight;
  }
  const merged = new Map<string, RetrieverCandidate>();

  const addCandidate = (
    candidate: RetrieverCandidate,
    source: FusionSource,
    rank: number
  ) => {
    const existing = merged.get(candidate.memory_id);
    const sourceScore = rrfScore(weights[source], rank, k);
    if (!existing) {
      merged.set(candidate.memory_id, {
        ...candidate,
        score: sourceScore,
        rrf_score: sourceScore,
        lexical_rank: source === "lexical" ? rank : candidate.lexical_rank,
        vector_rank: source === "vector" ? rank : candidate.vector_rank,
        graph_rank: source === "graph" ? rank : candidate.graph_rank,
        matched_terms: [...candidate.matched_terms],
        why_matched: [...candidate.why_matched, `rrf_${source}_rank:${rank}`],
        source_retrievers: unique([...candidate.source_retrievers, source])
      });
      return;
    }

    const nextRrf = (existing.rrf_score ?? existing.score) + sourceScore;
    merged.set(candidate.memory_id, {
      ...existing,
      score: nextRrf,
      rrf_score: nextRrf,
      lexical_score: blendSourceScore(existing.lexical_score, candidate.lexical_score),
      vector_score: blendSourceScore(existing.vector_score, candidate.vector_score),
      graph_score: blendSourceScore(existing.graph_score, candidate.graph_score),
      graph_path_score: blendSourceScore(existing.graph_path_score, candidate.graph_path_score),
      graph_rank_reason: existing.graph_rank_reason ?? candidate.graph_rank_reason,
      graph_entities: unique([...(existing.graph_entities ?? []), ...(candidate.graph_entities ?? [])]),
      graph_relations: unique([...(existing.graph_relations ?? []), ...(candidate.graph_relations ?? [])]),
      graph_evidence_sources: unique([...(existing.graph_evidence_sources ?? []), ...(candidate.graph_evidence_sources ?? [])]),
      graph_path: unique([...(existing.graph_path ?? []), ...(candidate.graph_path ?? [])]),
      graph_entity_evidence: existing.graph_entity_evidence ?? candidate.graph_entity_evidence,
      graph_relation_evidence: existing.graph_relation_evidence ?? candidate.graph_relation_evidence,
      graph_source_evidence: existing.graph_source_evidence ?? candidate.graph_source_evidence,
      graph_path_evidence: existing.graph_path_evidence ?? candidate.graph_path_evidence,
      lexical_rank: source === "lexical" ? Math.min(existing.lexical_rank ?? rank, rank) : existing.lexical_rank,
      vector_rank: source === "vector" ? Math.min(existing.vector_rank ?? rank, rank) : existing.vector_rank,
      graph_rank: source === "graph" ? Math.min(existing.graph_rank ?? rank, rank) : existing.graph_rank,
      matched_terms: unique([...existing.matched_terms, ...candidate.matched_terms]),
      why_matched: unique([...existing.why_matched, ...candidate.why_matched, `rrf_${source}_rank:${rank}`]),
      source_retrievers: unique([...existing.source_retrievers, ...candidate.source_retrievers, source])
    });
  };

  input.lexical.forEach((candidate, index) => addCandidate(candidate, "lexical", index + 1));
  input.vector.forEach((candidate, index) => addCandidate(candidate, "vector", index + 1));
  input.graph?.forEach((candidate, index) => addCandidate(candidate, "graph", index + 1));

  const candidates = [...merged.values()].sort((left, right) => (right.rrf_score ?? right.score) - (left.rrf_score ?? left.score));
  return {
    candidates,
    audit: {
      method: "rrf",
      k,
      lexical_weight: weights.lexical,
      vector_weight: weights.vector,
      graph_weight: weights.graph,
      ...(weights.graph !== originalGraphWeight
        ? {
            graph_original_weight: originalGraphWeight,
            graph_weight_capped: true,
            graph_weight_cap_reason: input.graph_guard?.reason ?? "graph_guard"
          }
        : {}),
      lexical_candidates: input.lexical.length,
      vector_candidates: input.vector.length,
      graph_candidates: input.graph?.length ?? 0,
      merged_candidates: candidates.length
    }
  };
}
