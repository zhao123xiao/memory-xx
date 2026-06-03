import {
  QueryType,
  type QueryConstraints,
  type RecallConfidenceGatePayload,
  type RetrieverCandidate
} from "./types";

interface RerankOutcomeLike {
  readonly model_used: boolean;
}

export interface RecallConfidenceGateResult {
  readonly candidates: RetrieverCandidate[];
  readonly audit: RecallConfidenceGatePayload;
}

const DEFAULT_GUARDED_QUERY_TYPES = new Set<QueryType>([
  QueryType.ExploratorySemantic,
  QueryType.TimelineHistory,
  QueryType.EntityProfile,
  QueryType.ExactLookup,
  QueryType.DecisionLookup,
  QueryType.CurrentStateQuery
]);

function readFraction(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed > 1 ? parsed / 100 : parsed;
}

function envFlagDisabled(env: NodeJS.ProcessEnv, name: string): boolean {
  return ["0", "false", "off", "disabled"].includes(
    (env[name] ?? "").trim().toLowerCase()
  );
}

function normalizeModelScore(score: number): number {
  if (score > 1 && score <= 100) {
    return score / 100;
  }
  return Math.max(0, Math.min(1, score));
}

function topModelScore(candidates: readonly RetrieverCandidate[]): number | undefined {
  const scores = candidates
    .map((candidate) => candidate.rerank_score)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score))
    .map(normalizeModelScore);

  return scores.length > 0 ? Math.max(...scores) : undefined;
}

function isStrictNullQueryType(queryType: QueryType): boolean {
  return queryType === QueryType.ExactLookup ||
    queryType === QueryType.DecisionLookup ||
    queryType === QueryType.CurrentStateQuery ||
    queryType === QueryType.PreferenceLookup ||
    queryType === QueryType.SourceAudit;
}

function hasProtectiveExactSignal(candidate: RetrieverCandidate): boolean {
  return candidate.why_matched.some((reason) =>
    reason.includes("exact_") ||
    reason.includes("source_path_match_bonus") ||
    reason.includes("query_alias_bonus")
  );
}

function findMarginCutoff(candidates: readonly RetrieverCandidate[], minResults: number): number | undefined {
  for (let index = Math.max(minResults - 1, 0); index < candidates.length - 1; index += 1) {
    const current = candidates[index]?.score ?? 0;
    const next = candidates[index + 1]?.score ?? 0;
    if (current - next > 0.15) {
      return index + 1;
    }
  }
  return undefined;
}

function asksForSensitiveValue(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const secretToken =
    /(密码|口令|密钥|私钥|凭证|令牌|api\s*key|apikey|access\s*key|secret|token|credential|password|passcode|wifi|wi-fi)/i
      .test(normalized);
  if (!secretToken) {
    return false;
  }

  const policyOrHandlingIntent =
    /(如何|怎么|怎样|是否|能不能|可以|允许|禁止|保存|泄露|处理|脱敏|规则|策略|要求|确保|policy|rule|store|save|redact|mask|allow|allowed|forbid|forbidden|avoid|leak|handle|should)/i
      .test(normalized);
  return !policyOrHandlingIntent;
}

export function applyRecallConfidenceGate(
  candidates: readonly RetrieverCandidate[],
  constraints: QueryConstraints,
  rerankOutcome: RerankOutcomeLike,
  env: NodeJS.ProcessEnv = process.env
): RecallConfidenceGateResult {
  if (envFlagDisabled(env, "MEMORY_V2_RECALL_LOW_CONFIDENCE_GUARD")) {
    return {
      candidates: [...candidates],
      audit: { applied: false, reason: "disabled" }
    };
  }

  if (asksForSensitiveValue(constraints.normalized_query)) {
    return {
      candidates: [],
      audit: {
        applied: true,
        reason: "sensitive_value_lookup",
        candidate_count: candidates.length
      }
    };
  }

  if (!DEFAULT_GUARDED_QUERY_TYPES.has(constraints.classification.query_type)) {
    return {
      candidates: [...candidates],
      audit: { applied: false, reason: "query_type_not_guarded" }
    };
  }

  const topScore = topModelScore(candidates);
  const threshold = readFraction(
    env,
    "MEMORY_V2_RECALL_ABSOLUTE_MIN_SCORE",
    0.20
  );

  const filtered = candidates.filter((candidate) =>
    candidate.score >= threshold || hasProtectiveExactSignal(candidate)
  );
  const absoluteFiltered = candidates.length - filtered.length;
  const strictNull = isStrictNullQueryType(constraints.classification.query_type);
  const minResultPolicy = strictNull ? "strict_null" : "allow_low_confidence";

  if (filtered.length === 0) {
    if (!strictNull && candidates.length > 0) {
      const lowConfidence = { ...candidates[0]!, low_confidence: true };
      return {
        candidates: [lowConfidence],
        audit: {
          applied: true,
          reason: "low_confidence_singleton",
          top_model_score: topScore,
          threshold,
          candidate_count: candidates.length,
          absolute_filtered: absoluteFiltered,
          min_result_policy: minResultPolicy,
          null_returned: false,
          low_confidence_returned: true
        }
      };
    }
    return {
      candidates: [],
      audit: {
        applied: true,
        reason: "absolute_low_score",
        top_model_score: topScore,
        threshold,
        candidate_count: candidates.length,
        absolute_filtered: absoluteFiltered,
        min_result_policy: minResultPolicy,
        null_returned: true
      }
    };
  }

  const minResults = strictNull ? 0 : 1;
  const cutoff = findMarginCutoff(filtered, minResults);
  const marginFiltered = cutoff === undefined ? filtered : filtered.slice(0, cutoff);

  return {
    candidates: marginFiltered,
    audit: {
      applied: absoluteFiltered > 0 || cutoff !== undefined,
      reason: absoluteFiltered > 0 || cutoff !== undefined ? "confidence_filtered" : "confidence_passed",
      top_model_score: topScore,
      threshold,
      candidate_count: candidates.length,
      absolute_filtered: absoluteFiltered,
      margin_cutoff_rank: cutoff,
      min_result_policy: minResultPolicy,
      null_returned: false,
      low_confidence_returned: marginFiltered.some((candidate) => candidate.low_confidence === true)
    }
  };
}
