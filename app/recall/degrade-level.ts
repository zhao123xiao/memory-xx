import type { BackendStatus, DegradeLevel, RetrieverCandidate } from "./types";

function hasPgVectorFallback(candidates: readonly RetrieverCandidate[]): boolean {
  return candidates.some((candidate) =>
    candidate.source_retrievers.includes("pgvector-fallback") ||
    candidate.why_matched.some((reason) => reason.startsWith("vector_fallback:"))
  );
}
export function computeRecallDegradeLevel(input: {
  readonly lexical_status: BackendStatus;
  readonly vector_status: BackendStatus;
  readonly vector_candidates: readonly RetrieverCandidate[];
  readonly degrade_reasons: readonly string[];
}): DegradeLevel {
  const lexicalAvailable = input.lexical_status.available;
  const vectorAvailable = input.vector_status.available;
  const qdrantPrimary = input.vector_status.primary_backend === "qdrant" || input.vector_status.backend === "qdrant";
  const qdrantFallbackUsed = hasPgVectorFallback(input.vector_candidates);
  const qdrantUnavailable =
    input.degrade_reasons.some((reason) => reason.includes("qdrant")) ||
    qdrantFallbackUsed ||
    (qdrantPrimary && !vectorAvailable);

  if (!lexicalAvailable && !vectorAvailable) {
    return 3;
  }

  if (!vectorAvailable && lexicalAvailable) {
    return 2;
  }

  if (qdrantUnavailable && (vectorAvailable || qdrantFallbackUsed)) {
    return 1;
  }

  return 0;
}
