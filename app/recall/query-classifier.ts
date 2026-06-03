import {
  QueryType,
  RetrievalStrategy,
  type QueryClassification,
  type QueryClassificationProfile,
  type StrategyWeights
} from "./types";

const DEFAULT_PROFILE_BY_TYPE: Record<QueryType, QueryClassificationProfile> = {
  [QueryType.ExactLookup]: {
    default_strategy: RetrievalStrategy.LexicalOnly,
    default_top_k: 8,
    rerank_enabled: true,
    explain_detail: "basic"
  },
  [QueryType.PreferenceLookup]: {
    default_strategy: RetrievalStrategy.LexicalOnly,
    default_top_k: 8,
    rerank_enabled: true,
    explain_detail: "basic"
  },
  [QueryType.DecisionLookup]: {
    default_strategy: RetrievalStrategy.LexicalOnly,
    default_top_k: 10,
    rerank_enabled: true,
    explain_detail: "basic"
  },
  [QueryType.ProjectContext]: {
    default_strategy: RetrievalStrategy.Hybrid,
    default_top_k: 10,
    rerank_enabled: true,
    explain_detail: "basic"
  },
  [QueryType.TimelineHistory]: {
    default_strategy: RetrievalStrategy.LexicalOnly,
    default_top_k: 12,
    rerank_enabled: true,
    explain_detail: "basic"
  },
  [QueryType.TodoCommitment]: {
    default_strategy: RetrievalStrategy.LexicalOnly,
    default_top_k: 8,
    rerank_enabled: false,
    explain_detail: "basic"
  },
  [QueryType.EntityProfile]: {
    default_strategy: RetrievalStrategy.Hybrid,
    default_top_k: 10,
    rerank_enabled: true,
    explain_detail: "basic"
  },
  [QueryType.ExploratorySemantic]: {
    default_strategy: RetrievalStrategy.Hybrid,
    default_top_k: 12,
    rerank_enabled: true,
    explain_detail: "basic"
  },
  [QueryType.SourceAudit]: {
    default_strategy: RetrievalStrategy.LexicalOnly,
    default_top_k: 12,
    rerank_enabled: true,
    explain_detail: "full"
  },
  [QueryType.DebugRecall]: {
    default_strategy: RetrievalStrategy.Hybrid,
    default_top_k: 10,
    rerank_enabled: false,
    explain_detail: "full"
  },
  [QueryType.CurrentStateQuery]: {
    default_strategy: RetrievalStrategy.Hybrid,
    default_top_k: 10,
    rerank_enabled: true,
    explain_detail: "basic"
  },
  [QueryType.HistoricalQuery]: {
    default_strategy: RetrievalStrategy.Hybrid,
    default_top_k: 12,
    rerank_enabled: true,
    explain_detail: "basic"
  },
  [QueryType.ProcedureQuery]: {
    default_strategy: RetrievalStrategy.LexicalOnly,
    default_top_k: 10,
    rerank_enabled: true,
    explain_detail: "basic"
  },
  [QueryType.PreferenceQuery]: {
    default_strategy: RetrievalStrategy.LexicalOnly,
    default_top_k: 8,
    rerank_enabled: true,
    explain_detail: "basic"
  },
  [QueryType.EpisodeLookup]: {
    default_strategy: RetrievalStrategy.Hybrid,
    default_top_k: 10,
    rerank_enabled: true,
    explain_detail: "basic"
  },
  [QueryType.DebugAuditQuery]: {
    default_strategy: RetrievalStrategy.Hybrid,
    default_top_k: 20,
    rerank_enabled: false,
    explain_detail: "full"
  }
};

const EXACT_PATTERNS = [/exact\b/, /\bwhat is\b/, /\bwho is\b/, /\bwhere is\b/, /id[:=]/, /什么是/];
const PREFERENCE_PATTERNS = [/\bprefer/, /\bpreference/, /\bhabit/, /喜欢/, /偏好/];
const DECISION_PATTERNS = [/\bdecid/, /\bdecision/, /为什么/, /结论/, /方案/];
const PROJECT_PATTERNS = [/\bproject\b/, /\bmilestone\b/, /阶段/, /项目/];
const TIMELINE_PATTERNS = [
  /\bwhen\b/,
  /\byesterday\b/,
  /\btoday\b/,
  /\blast\b/,
  /\b20\d{2}\b/,
  /昨天/,
  /今天/,
  /上周/,
  /刚才/,
  /之前/,
  /上次/
];
const TODO_PATTERNS = [
  /\btodo\b/,
  /\bnext step\b/,
  /\bcommitment\b/,
  /\bfollow[- ]?up\b/,
  /待办/,
  /下一步/
];
const SOURCE_AUDIT_PATTERNS = [/\bsource\b/, /\bpath\b/, /\.md\b/, /\.ts\b/, /出处/, /来源/];
const DEBUG_PATTERNS = [/\bdebug\b/, /\bdegraded\b/, /\bstrategy\b/, /\bfilter_mode\b/];
const CURRENT_STATE_PATTERNS = [/\bcurrent\b.*\bstatus\b/, /\bcurrent\b.*\bstate\b/, /现在/, /当前/, /目前/, /最新/];
const HISTORICAL_PATTERNS = [/\bhistory\b/, /\bchanged\b.*\bfrom\b/, /以前/, /曾经/, /变更历史/, /什么时候变/];
const PROCEDURE_PATTERNS = [/\bhow to\b/, /\bprocedure\b/, /\bstep by step\b/, /怎么操作/, /如何部署/, /步骤/, /流程/];
const PREFERENCE_QUERY_PATTERNS = [/\bpreference\b.*\bcurrent\b/, /当前偏好/, /当前设置/];
const EPISODE_PATTERNS = [/\bepisode\b/, /\bwhat happened\b/, /发生了什么/, /事件/, /过程/];
const AUDIT_PATTERNS = [/\baudit\b.*\bmemory\b/, /\bfull\b.*\brecord\b/, /审计/, /全部记录/];
const ENTITY_PATTERNS = [/是谁/];
const EXACT_SOURCE_AUDIT_QUERIES = new Set([
  "facts.md",
  "decisions.md",
  "preferences.md",
  "constraints.md",
  "relationships.md"
]);
const EXACT_SECTION_LOOKUP_QUERIES = new Set([
  "project index",
  "persona",
  "collaboration"
]);
const EXACT_DECISION_LOOKUP_QUERIES = new Set(["system decisions"]);

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function strategyWeightsForType(queryType: QueryType): StrategyWeights {
  switch (queryType) {
    case QueryType.ExactLookup:
    case QueryType.SourceAudit:
    case QueryType.DecisionLookup:
    case QueryType.PreferenceLookup:
    case QueryType.PreferenceQuery:
    case QueryType.ProcedureQuery:
    case QueryType.TodoCommitment:
      return { lexical: 1.2, vector: 0.8, metadata: 1.0, temporal: 0.7, knowledge: 0.2 };
    case QueryType.TimelineHistory:
    case QueryType.HistoricalQuery:
    case QueryType.CurrentStateQuery:
    case QueryType.EpisodeLookup:
      return { lexical: 1.0, vector: 1.0, metadata: 0.8, temporal: 1.2, knowledge: 0.2 };
    case QueryType.EntityProfile:
    case QueryType.ProjectContext:
    case QueryType.ExploratorySemantic:
      return { lexical: 0.9, vector: 1.1, metadata: 0.8, temporal: 0.7, knowledge: 0.2 };
    case QueryType.DebugRecall:
    case QueryType.DebugAuditQuery:
      return { lexical: 1.0, vector: 1.0, metadata: 1.0, temporal: 1.0, knowledge: 0.0 };
    default:
      return { lexical: 1.0, vector: 1.0, metadata: 0.8, temporal: 0.8, knowledge: 0.2 };
  }
}

export function classifyQuery(input: {
  query: string;
  query_type_hint?: QueryType;
}): QueryClassification {
  if (input.query_type_hint) {
    const profile = DEFAULT_PROFILE_BY_TYPE[input.query_type_hint];
    return {
      query_type: input.query_type_hint,
      confidence: 1,
      strategy_hint: profile.default_strategy,
      top_k: profile.default_top_k,
      rerank_enabled: profile.rerank_enabled,
      explain_detail: profile.explain_detail,
      reasons: ["explicit query_type_hint override"],
      used_hint: true,
      strategy_weights: strategyWeightsForType(input.query_type_hint)
    };
  }

  const normalized = normalizeQuery(input.query);
  const reasons: string[] = [];

  let detectedType = QueryType.ExploratorySemantic;
  let confidence = 0.55;

  const evaluateGroup = (patterns: RegExp[]): boolean =>
    patterns.some((pattern) => pattern.test(normalized));

  if (evaluateGroup(DEBUG_PATTERNS) && !evaluateGroup(AUDIT_PATTERNS)) {
    detectedType = QueryType.DebugRecall;
    confidence = 0.95;
    reasons.push("debug-oriented tokens matched");
  } else if (EXACT_SOURCE_AUDIT_QUERIES.has(normalized)) {
    detectedType = QueryType.SourceAudit;
    confidence = 0.96;
    reasons.push("canonical source filename matched");
  } else if (EXACT_DECISION_LOOKUP_QUERIES.has(normalized)) {
    detectedType = QueryType.DecisionLookup;
    confidence = 0.93;
    reasons.push("canonical decision section matched");
  } else if (EXACT_SECTION_LOOKUP_QUERIES.has(normalized)) {
    detectedType = QueryType.ExactLookup;
    confidence = 0.93;
    reasons.push("canonical section heading matched");
  } else if (evaluateGroup(SOURCE_AUDIT_PATTERNS)) {
    detectedType = QueryType.SourceAudit;
    confidence = 0.92;
    reasons.push("source or audit tokens matched");
  } else if (evaluateGroup(AUDIT_PATTERNS)) {
    detectedType = QueryType.DebugAuditQuery;
    confidence = 0.95;
    reasons.push("audit/debug tokens matched");
  } else if (evaluateGroup(TODO_PATTERNS)) {
    detectedType = QueryType.TodoCommitment;
    confidence = 0.9;
    reasons.push("todo or follow-up tokens matched");
  } else if (evaluateGroup(PREFERENCE_PATTERNS)) {
    detectedType = QueryType.PreferenceLookup;
    confidence = 0.88;
    reasons.push("preference tokens matched");
  } else if (evaluateGroup(DECISION_PATTERNS)) {
    detectedType = QueryType.DecisionLookup;
    confidence = 0.87;
    reasons.push("decision tokens matched");
  } else if (evaluateGroup(PROJECT_PATTERNS)) {
    detectedType = QueryType.ProjectContext;
    confidence = 0.84;
    reasons.push("project context tokens matched");
  } else if (evaluateGroup(TIMELINE_PATTERNS)) {
    detectedType = QueryType.TimelineHistory;
    confidence = 0.82;
    reasons.push("timeline tokens matched");
  } else if (evaluateGroup(EXACT_PATTERNS)) {
    detectedType = QueryType.ExactLookup;
    confidence = 0.8;
    reasons.push("exact lookup phrasing matched");
  } else if (evaluateGroup(CURRENT_STATE_PATTERNS)) {
    detectedType = QueryType.CurrentStateQuery;
    confidence = 0.85;
    reasons.push("current-state tokens matched");
  } else if (evaluateGroup(HISTORICAL_PATTERNS)) {
    detectedType = QueryType.HistoricalQuery;
    confidence = 0.85;
    reasons.push("historical tokens matched");
  } else if (evaluateGroup(PROCEDURE_PATTERNS)) {
    detectedType = QueryType.ProcedureQuery;
    confidence = 0.84;
    reasons.push("procedure tokens matched");
  } else if (evaluateGroup(PREFERENCE_QUERY_PATTERNS)) {
    detectedType = QueryType.PreferenceQuery;
    confidence = 0.83;
    reasons.push("preference query tokens matched");
  } else if (evaluateGroup(EPISODE_PATTERNS)) {
    detectedType = QueryType.EpisodeLookup;
    confidence = 0.82;
    reasons.push("episode tokens matched");
  } else if (evaluateGroup(ENTITY_PATTERNS)) {
    detectedType = QueryType.EntityProfile;
    confidence = 0.78;
    reasons.push("entity-like tokens matched");
  } else if (
    /\b([a-z]+)\s+([a-z]+)\b/i.test(input.query) &&
    /\bprofile\b/.test(normalized)
  ) {
    detectedType = QueryType.EntityProfile;
    confidence = 0.78;
    reasons.push("entity-like tokens matched");
  } else if (/怎么/.test(normalized) || /如何/.test(normalized)) {
    detectedType = QueryType.ExploratorySemantic;
    confidence = 0.65;
    reasons.push("exploratory semantic tokens matched");
  } else {
    reasons.push("defaulted to exploratory semantic search");
  }

  const profile = DEFAULT_PROFILE_BY_TYPE[detectedType];
  return {
    query_type: detectedType,
    confidence,
    strategy_hint: profile.default_strategy,
    top_k: profile.default_top_k,
    rerank_enabled: profile.rerank_enabled,
    explain_detail: profile.explain_detail,
    reasons,
    used_hint: false,
    strategy_weights: strategyWeightsForType(detectedType)
  };
}
