import {
  QueryType,
  RetrievalStrategy,
  type BackendStatus,
  type QueryClassification,
  type RetrievalPlan
} from "./types";

type PhysicalStrategy = "lexical" | "vector";

function preferredStrategy(
  classification: QueryClassification
): RetrievalStrategy {
  switch (classification.query_type) {
    case QueryType.ExactLookup:
    case QueryType.PreferenceLookup:
    case QueryType.DecisionLookup:
    case QueryType.TimelineHistory:
    case QueryType.TodoCommitment:
    case QueryType.SourceAudit:
      return RetrievalStrategy.LexicalOnly;
    case QueryType.DebugRecall:
    case QueryType.ProjectContext:
    case QueryType.EntityProfile:
    case QueryType.ExploratorySemantic:
      return RetrievalStrategy.Hybrid;
    default:
      return classification.strategy_hint;
  }
}

export function buildRetrievalPlan(input: {
  classification: QueryClassification;
  lexical_status: BackendStatus;
  vector_status: BackendStatus;
}): RetrievalPlan {
  const initialStrategy = preferredStrategy(input.classification);
  const degradeReasons: string[] = [];
  const strategyExplain = [`initial strategy=${initialStrategy}`];
  const weights = input.classification.strategy_weights ?? {
    lexical: initialStrategy === RetrievalStrategy.VectorOnly ? 0.8 : 1,
    vector: initialStrategy === RetrievalStrategy.LexicalOnly ? 0.8 : 1,
    metadata: 0.8,
    temporal: 0.8,
    knowledge: 0.2
  };
  const rankedPhysicalStrategies = ([
    ["lexical", weights.lexical],
    ["vector", weights.vector]
  ] satisfies [PhysicalStrategy, number][])
    .sort((left, right) => right[1] - left[1])
    .map(([strategy]) => strategy);
  const primaryStrategy = rankedPhysicalStrategies[0] as PhysicalStrategy;
  const secondaryStrategy = rankedPhysicalStrategies[1] as PhysicalStrategy;

  if (!input.lexical_status.available && !input.vector_status.available) {
    degradeReasons.push(
      input.lexical_status.reason ?? "lexical_backend_unavailable",
      input.vector_status.reason ?? "vector_backend_unavailable"
    );
    strategyExplain.push("both retrievers unavailable, degraded to metadata_only");
    return {
      strategy: RetrievalStrategy.MetadataOnly,
      execute_lexical: false,
      execute_vector: false,
      degraded: true,
      degrade_reasons: degradeReasons,
      strategy_explain: strategyExplain,
      strategy_weights: weights,
      primary_strategy: primaryStrategy,
      secondary_strategy: secondaryStrategy
    };
  }

  if (!input.vector_status.available && input.lexical_status.available) {
    degradeReasons.push(
      input.vector_status.reason ?? "vector_backend_unavailable"
    );
    strategyExplain.push("vector unavailable, degraded to lexical_only");
    return {
      strategy: initialStrategy,
      execute_lexical: true,
      execute_vector: false,
      degraded: true,
      degrade_reasons: degradeReasons,
      strategy_explain: strategyExplain,
      strategy_weights: weights,
      primary_strategy: primaryStrategy,
      secondary_strategy: secondaryStrategy,
      fallback_retry_used: true
    };
  }

  if (!input.lexical_status.available && input.vector_status.available) {
    degradeReasons.push(
      input.lexical_status.reason ?? "lexical_backend_unavailable"
    );
    strategyExplain.push("lexical unavailable, degraded to vector_only");
    return {
      strategy: initialStrategy,
      execute_lexical: false,
      execute_vector: true,
      degraded: true,
      degrade_reasons: degradeReasons,
      strategy_explain: strategyExplain,
      strategy_weights: weights,
      primary_strategy: primaryStrategy,
      secondary_strategy: secondaryStrategy,
      fallback_retry_used: true
    };
  }

  strategyExplain.push(`planner physical primary=${primaryStrategy}, secondary=${secondaryStrategy}`);
  return {
    strategy: initialStrategy,
    execute_lexical: true,
    execute_vector: true,
    degraded: false,
    degrade_reasons: [],
    strategy_explain: strategyExplain,
    strategy_weights: weights,
    primary_strategy: primaryStrategy,
    secondary_strategy: secondaryStrategy,
    fallback_retry_used: input.classification.confidence < 0.85
  };
}
