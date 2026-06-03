import type { CandidateSignals } from "./reranker-signals";
import type { RetrieverCandidate } from "./types";

export interface ClusterSiblingEvaluation {
  readonly candidate: CandidateEvaluation;
  readonly extraCueCount: number;
  readonly sameTitleAsWinner: boolean;
}

export interface RerankAdjustment {
  readonly score_delta: number;
  readonly why_matched: readonly string[];
}

export interface CandidateEvaluation {
  readonly candidate: RetrieverCandidate;
  readonly signals: CandidateSignals;
  readonly score: number;
  readonly why_matched: readonly string[];
  readonly cluster_key?: string;
}
