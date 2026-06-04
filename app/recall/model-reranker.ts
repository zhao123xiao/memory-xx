import { createHash } from "node:crypto";

import { readRuntimeControlNumberSync } from "../runtime-control-settings";
import { QueryType, type QueryConstraints, type RetrieverCandidate } from "./types";
import { rerankCandidates } from "./reranker";

export interface RerankOutcome {
  readonly candidates: RetrieverCandidate[];
  readonly backend: "disabled" | "local" | "model";
  readonly model_attempted: boolean;
  readonly model_used: boolean;
  readonly reason?: string;
  readonly latency_ms?: number;
}

export interface ModelRerankOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

interface RerankerResultRow {
  readonly memory_id?: unknown;
  readonly index?: unknown;
  readonly document_index?: unknown;
  readonly score?: unknown;
  readonly relevance_score?: unknown;
}

type RerankerPolicy = "adaptive" | "force_top1" | "always";

interface RerankScoreCacheEntry {
  readonly expires_at: number;
  readonly scores: Map<string, number>;
}

const rerankScoreCache = new Map<string, RerankScoreCacheEntry>();

function readPositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readRuntimePositiveInt(
  env: NodeJS.ProcessEnv,
  runtimeKey: string,
  envName: string,
  fallback: number
): number {
  const envValue = readPositiveInt(env, envName, fallback);
  if (env !== process.env) return envValue;
  const runtimeValue = readRuntimeControlNumberSync(runtimeKey, envValue);
  return Number.isFinite(runtimeValue) && runtimeValue > 0 ? runtimeValue : envValue;
}

function readRuntimeNonNegativeInt(
  env: NodeJS.ProcessEnv,
  runtimeKey: string,
  envName: string,
  fallback: number
): number {
  const envValue = readPositiveInt(env, envName, fallback);
  if (env !== process.env) return envValue;
  const runtimeValue = readRuntimeControlNumberSync(runtimeKey, envValue);
  return Number.isFinite(runtimeValue) && runtimeValue >= 0 ? runtimeValue : envValue;
}

function readOptionalPositiveInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readRerankerPolicy(env: NodeJS.ProcessEnv): RerankerPolicy {
  const raw = (env.MEMORY_XX_RERANKER_POLICY ?? "adaptive").trim().toLowerCase();
  return raw === "force_top1" || raw === "always" ? raw : "adaptive";
}

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
  const fraction = parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0, Math.min(1, fraction));
}

function normalizeModelScore(score: number): number {
  if (score > 1 && score <= 100) {
    return score / 100;
  }
  return Math.max(0, Math.min(1, score));
}

function modelRerankAllowedForQueryType(queryType: QueryType, limit: number): boolean {
  if (queryType === QueryType.ExploratorySemantic && limit < 8) {
    return false;
  }
  return queryType === QueryType.ExploratorySemantic ||
    queryType === QueryType.EntityProfile ||
    queryType === QueryType.ProjectContext ||
    queryType === QueryType.TimelineHistory;
}

function topThreeGap(candidates: readonly RetrieverCandidate[]): number {
  if (candidates.length < 3) {
    return Number.POSITIVE_INFINITY;
  }
  return (candidates[0]?.score ?? 0) - (candidates[2]?.score ?? 0);
}

function documentText(candidate: RetrieverCandidate): string {
  return [
    candidate.record.title,
    candidate.record.memory_type,
    candidate.record.category,
    candidate.record.source?.path,
    candidate.record.content
  ]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2400);
}

function documentPayload(candidate: RetrieverCandidate): Record<string, string> {
  const payload: Record<string, string> = {
    memory_id: candidate.memory_id,
    text: compactDocumentText(candidate)
  };

  if (candidate.record.title?.trim()) {
    payload.title = candidate.record.title.trim();
  }
  if (candidate.record.content.trim()) {
    payload.content = candidate.record.content.trim().slice(0, 1200);
  }
  if (candidate.record.source?.path?.trim()) {
    payload.source_path = candidate.record.source.path.trim();
  }
  if (candidate.record.section?.trim()) {
    payload.section = candidate.record.section.trim();
  }

  return payload;
}

function compactDocumentText(candidate: RetrieverCandidate): string {
  const title = candidate.record.title?.trim();
  const content = candidate.record.content.trim();
  const parts = [
    title ? `title: ${title}` : "",
    candidate.record.memory_type ? `type: ${candidate.record.memory_type}` : "",
    content ? `content: ${content}` : ""
  ].filter(Boolean);
  return parts.join("\n").replace(/\s+/g, " ").trim().slice(0, 1400);
}

function rowMemoryId(row: RerankerResultRow, candidates: readonly RetrieverCandidate[]): string | null {
  if (typeof row.memory_id === "string" && row.memory_id.trim() !== "") {
    const direct = row.memory_id.trim();
    if (direct.startsWith("__idx_")) {
      const index = Number.parseInt(direct.slice("__idx_".length), 10);
      return Number.isInteger(index) ? candidates[index]?.memory_id ?? null : null;
    }
    return direct;
  }

  const indexValue = row.index ?? row.document_index;
  if (typeof indexValue === "number" && Number.isInteger(indexValue)) {
    return candidates[indexValue]?.memory_id ?? null;
  }
  return null;
}

function rowScore(row: RerankerResultRow): number | null {
  const raw = row.score ?? row.relevance_score;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function extractScoreMap(parsed: unknown, candidates: readonly RetrieverCandidate[]): Map<string, number> {
  const root = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const rows = Array.isArray(root.results)
    ? root.results
    : Array.isArray(root.data)
      ? root.data
      : [];
  const scores = new Map<string, number>();
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const typed = row as RerankerResultRow;
    const id = rowMemoryId(typed, candidates);
    const score = rowScore(typed);
    if (id && score !== null) {
      scores.set(id, score);
    }
  }
  return scores;
}

function scoreCacheKey(input: {
  readonly endpoint: string;
  readonly model: string;
  readonly normalizedQuery: string;
  readonly selected: readonly RetrieverCandidate[];
  readonly modelWeight: number;
}): string {
  const generation = process.env.MEMORY_XX_EMBEDDING_GENERATION_ID?.trim() || "";
  const candidateSignature = input.selected
    .map((candidate) => `${candidate.memory_id}:${candidate.record.updated_at ?? ""}:${candidate.score.toFixed(6)}`)
    .join("|");
  return createHash("sha256")
    .update(JSON.stringify({
      endpoint: input.endpoint,
      model: input.model,
      generation,
      query: input.normalizedQuery,
      modelWeight: input.modelWeight,
      candidates: candidateSignature
    }))
    .digest("hex");
}

function readCachedScores(key: string): Map<string, number> | null {
  const entry = rerankScoreCache.get(key);
  if (!entry) return null;
  if (entry.expires_at <= Date.now()) {
    rerankScoreCache.delete(key);
    return null;
  }
  return new Map(entry.scores);
}

function writeCachedScores(key: string, scores: Map<string, number>, ttlMs: number): void {
  if (ttlMs <= 0 || scores.size === 0) return;
  const maxEntries = readPositiveInt(process.env, "MEMORY_XX_RERANKER_CACHE_MAX_ENTRIES", 500);
  while (rerankScoreCache.size >= maxEntries) {
    const oldest = rerankScoreCache.keys().next().value;
    if (!oldest) break;
    rerankScoreCache.delete(oldest);
  }
  rerankScoreCache.set(key, {
    scores: new Map(scores),
    expires_at: Date.now() + ttlMs
  });
}

function applyModelScores(
  selected: readonly RetrieverCandidate[],
  rest: readonly RetrieverCandidate[],
  scores: ReadonlyMap<string, number>,
  modelWeight: number
): RetrieverCandidate[] {
  const ranked = selected
    .map((candidate, index) => {
      const score = scores.get(candidate.memory_id);
      if (score === undefined) {
        return {
          ...candidate,
          score: candidate.score * Math.max(0, 1 - modelWeight),
          why_matched: [...candidate.why_matched, "model_rerank_missing_score"]
        };
      }
      const normalizedScore = normalizeModelScore(score);
      const localScore = candidate.local_score ?? candidate.score;
      const finalScore = localScore * Math.max(0, 1 - modelWeight) + normalizedScore * modelWeight;
      return {
        ...candidate,
        score: finalScore,
        final_score: finalScore,
        rerank_score: score,
        why_matched: [...candidate.why_matched, "model_rerank_applied"],
        cluster_key: candidate.cluster_key ?? `model-rerank:${index}`
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const rightModel = right.rerank_score ?? Number.NEGATIVE_INFINITY;
      const leftModel = left.rerank_score ?? Number.NEGATIVE_INFINITY;
      return rightModel - leftModel;
    });
  return [...ranked, ...rest];
}

export async function rerankCandidatesWithOptionalModel(
  candidates: RetrieverCandidate[],
  constraints: QueryConstraints,
  options: ModelRerankOptions = {}
): Promise<RerankOutcome> {
  const local = rerankCandidates(candidates, constraints);
  const env = options.env ?? process.env;
  const policy = readRerankerPolicy(env);

  if (!constraints.classification.rerank_enabled && policy !== "always") {
    return {
      candidates: local,
      backend: "disabled",
      model_attempted: false,
      model_used: false,
      reason: "query_profile_disabled_rerank"
    };
  }

  const mode = (env.MEMORY_XX_RERANKER_MODE ?? "").trim().toLowerCase();
  const endpoint = (env.MEMORY_XX_RERANKER_ENDPOINT ?? "").trim();
  const policyForcesModel = policy === "force_top1" || policy === "always";
  const minCandidates = policyForcesModel
    ? Math.min(readPositiveInt(env, "MEMORY_XX_RERANKER_MIN_CANDIDATES", 4), 2)
    : readPositiveInt(env, "MEMORY_XX_RERANKER_MIN_CANDIDATES", 4);
  const minGap = readFraction(env, "MEMORY_XX_RERANKER_LOCAL_TOP3_GAP_THRESHOLD", 0.20);
  const forceModelRerank = constraints.force_model_rerank === true || policyForcesModel;
  if (
    policy !== "always" &&
    !constraints.classification.rerank_enabled
  ) {
    return {
      candidates: local,
      backend: "disabled",
      model_attempted: false,
      model_used: false,
      reason: "query_profile_disabled_rerank"
    };
  }
  if (!forceModelRerank && !modelRerankAllowedForQueryType(constraints.classification.query_type, constraints.limit)) {
    return {
      candidates: local,
      backend: "local",
      model_attempted: false,
      model_used: false,
      reason: "query_type_skips_model_reranker"
    };
  }
  if (local.length < minCandidates) {
    return {
      candidates: local,
      backend: "local",
      model_attempted: false,
      model_used: false,
      reason: "not_enough_candidates"
    };
  }
  const gap = topThreeGap(local);
  if (policy === "adaptive" && !forceModelRerank && gap >= minGap) {
    return {
      candidates: local,
      backend: "local",
      model_attempted: false,
      model_used: false,
      reason: "local_top3_confident"
    };
  }
  if (mode !== "model" || endpoint === "") {
    return {
      candidates: local,
      backend: "local",
      model_attempted: false,
      model_used: false,
      reason: "model_reranker_not_configured"
    };
  }

  const configuredTimeoutMs = readRuntimePositiveInt(env, "recall.reranker.timeout_ms", "MEMORY_XX_RERANKER_TIMEOUT_MS", 1500);
  const timeoutCapMs = readOptionalPositiveInt(env, "MEMORY_XX_RERANKER_TIMEOUT_CAP_MS");
  const timeoutMs = timeoutCapMs === undefined ? configuredTimeoutMs : Math.min(configuredTimeoutMs, timeoutCapMs);
  const model = (env.MEMORY_XX_RERANKER_MODEL ?? "qwen3-reranker").trim() || "qwen3-reranker";
  const maxCandidates = Math.max(1, readPositiveInt(env, "MEMORY_XX_RERANKER_MAX_CANDIDATES", policyForcesModel ? 8 : 10));
  const modelWeight = readFraction(env, "MEMORY_XX_RERANKER_MODEL_WEIGHT", 0.25);
  const selected = local.slice(0, maxCandidates);
  const rest = local.slice(maxCandidates);
  const cacheTtlMs = readRuntimeNonNegativeInt(env, "cache.reranker.ttl_ms", "MEMORY_XX_RERANKER_CACHE_TTL_MS", 60_000);
  const cacheKey = scoreCacheKey({
    endpoint,
    model,
    normalizedQuery: constraints.normalized_query,
    selected,
    modelWeight
  });
  const cachedScores = readCachedScores(cacheKey);
  if (cachedScores) {
    return {
      candidates: applyModelScores(selected, rest, cachedScores, modelWeight),
      backend: "model",
      model_attempted: true,
      model_used: true,
      reason: "model_cache_hit",
      latency_ms: 0
    };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.MEMORY_XX_RERANKER_API_KEY?.trim()
          ? { authorization: `Bearer ${env.MEMORY_XX_RERANKER_API_KEY.trim()}` }
          : {})
      },
      body: JSON.stringify({
        model,
        query: constraints.normalized_query,
        documents: selected.map((candidate) => documentPayload(candidate))
      }),
      signal: controller.signal
    });

    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        candidates: local,
        backend: "local",
        model_attempted: true,
        model_used: false,
        reason: `model_http_${response.status}`,
        latency_ms: latencyMs
      };
    }

    const parsed = await response.json() as unknown;
    const scores = extractScoreMap(parsed, selected);
    if (scores.size === 0) {
      return {
        candidates: local,
        backend: "local",
        model_attempted: true,
        model_used: false,
        reason: "model_empty_scores",
        latency_ms: latencyMs
      };
    }

    writeCachedScores(cacheKey, scores, cacheTtlMs);

    return {
      candidates: applyModelScores(selected, rest, scores, modelWeight),
      backend: "model",
      model_attempted: true,
      model_used: true,
      latency_ms: latencyMs
    };
  } catch (error) {
    return {
      candidates: local,
      backend: "local",
      model_attempted: true,
      model_used: false,
      reason: error instanceof Error && error.name === "AbortError"
        ? "model_timeout"
        : "model_error",
      latency_ms: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}
