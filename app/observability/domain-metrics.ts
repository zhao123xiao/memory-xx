import type { WriteTransactionRunner } from "../db/tx/write-transaction";
import { isPostgresTransactionContext, withWriteTransaction } from "../db/tx/write-transaction";
import type { RecallRequest, RecallResponse } from "../recall/types";
import { metrics, type InMemoryRequestMetrics } from "../server/metrics";
import { getPostCommitDegradedSnapshot } from "./post-commit-degraded";
import { getQdrantRuntimeSnapshot } from "./qdrant-health";

const initializedRegistries = new WeakSet<InMemoryRequestMetrics>();
const recallCacheStats = new WeakMap<InMemoryRequestMetrics, { hits: number; checks: number }>();

const WRITE_QUALITY_BUCKETS = ["passed", "pending", "abandoned"] as const;
const RECALL_DEGRADE_LEVELS = ["0", "1", "2", "3"] as const;
const SCOPE_CONFLICT_POLICIES = ["more_specific", "higher_scope", "latest"] as const;

type WriteQualityBucket = (typeof WRITE_QUALITY_BUCKETS)[number];

interface QualityGateLike {
  readonly score?: unknown;
  readonly action?: unknown;
  readonly passed?: unknown;
}

interface SilentApproveRateRow {
  readonly agent: string;
  readonly scope: string;
  readonly sampleSize: number;
  readonly falsePositiveRate: number;
  readonly adoptionRate: number;
}

export function initializeDomainMetrics(registry: InMemoryRequestMetrics = metrics): void {
  if (initializedRegistries.has(registry)) {
    return;
  }

  for (const bucket of WRITE_QUALITY_BUCKETS) {
    registry.addCounter("memory_write_quality_gate_distribution_total", 0, { bucket });
  }
  registry.addCounter("memory_write_quality_gate_false_catch_total", 0);

  for (const level of RECALL_DEGRADE_LEVELS) {
    registry.setGauge("memory_recall_degrade_level", 0, { level });
  }
  registry.addCounter("memory_recall_null_return_total", 0, { query_type: "unknown" });
  registry.addCounter("memory_recall_rerank_enabled_total", 0);
  registry.addCounter("memory_embedding_calls_total", 0, { provider: "unknown", status: "unknown" });
  registry.addCounter("memory_embedding_fallback_total", 0, { reason: "unknown" });
  registry.addCounter("memory_embedding_429_total", 0, { provider: "unknown" });
  registry.addCounter("memory_qdrant_timeout_total", 0, { kind: "query" });
  registry.addCounter("memory_qdrant_timeout_total", 0, { kind: "write" });
  registry.addCounter("memory_reranker_calls_total", 0, { backend: "unknown", status: "unknown" });
  registry.addCounter("memory_reranker_fallback_total", 0, { reason: "unknown" });
  registry.addCounter("memory_reranker_429_total", 0, { backend: "unknown" });
  registry.setGauge("memory_post_commit_degraded_total", 0);
  registry.setGauge("memory_post_commit_degraded_cache_invalidation_failed", 0);
  registry.setGauge("memory_post_commit_degraded_projection_sync_failed", 0);
  registry.setGauge("memory_qdrant_query_timeouts_total", 0);
  registry.setGauge("memory_qdrant_write_timeouts_total", 0);
  registry.setGauge("memory_recall_fallback_ratio", 0, { component: "embedding" });
  registry.setGauge("memory_recall_fallback_ratio", 0, { component: "reranker" });
  registry.setGauge("memory_recall_fallback_ratio", 0, { component: "vector" });
  for (const policy of SCOPE_CONFLICT_POLICIES) {
    registry.addCounter("memory_recall_scope_conflict_applied_total", 0, { policy });
  }

  registry.addCounter("memory_projector_dead_letter_total", 0, { reason: "unknown" });
  registry.addCounter("memory_projector_readback_verify_fail_total", 0);

  registry.addCounter("memory_governance_action_total", 0, { type: "unknown", status: "reported" });
  registry.setGauge("memory_governance_silent_approve_fp_rate", 0, { agent: "unknown", scope: "unknown" });
  registry.setGauge("memory_governance_silent_approve_adoption_rate", 0, { agent: "unknown", scope: "unknown" });
  registry.setGauge("memory_cache_recall_cache_hit_ratio", 0);

  initializedRegistries.add(registry);
}

export function recordWriteQualityGate(
  qualityGate: QualityGateLike | null | undefined,
  registry: InMemoryRequestMetrics = metrics
): void {
  const bucket = bucketQualityGate(qualityGate);
  if (!bucket) {
    return;
  }
  initializeDomainMetrics(registry);
  registry.incrementCounter("memory_write_quality_gate_distribution_total", { bucket });
}

export function recordWriteQualityGateFalseCatch(registry: InMemoryRequestMetrics = metrics): void {
  initializeDomainMetrics(registry);
  registry.incrementCounter("memory_write_quality_gate_false_catch_total");
}

export function recordRecallMetrics(
  request: RecallRequest,
  response: RecallResponse,
  registry: InMemoryRequestMetrics = metrics
): void {
  initializeDomainMetrics(registry);

  const level = normalizeDegradeLevel(response.degrade_level ?? response.audit.degrade_level);
  for (const candidate of RECALL_DEGRADE_LEVELS) {
    registry.setGauge("memory_recall_degrade_level", candidate === String(level) ? 1 : 0, { level: candidate });
  }

  const queryType = String(response.audit.query_type ?? request.query_type_hint ?? "unknown");
  const nullReturned =
    response.results.length === 0 ||
    response.null_guard?.null_returned === true ||
    response.audit.null_guard?.null_returned === true ||
    response.audit.confidence_gate?.null_returned === true;
  if (nullReturned) {
    registry.incrementCounter("memory_recall_null_return_total", { query_type: queryType });
  }

  const rerank = response.audit.rerank;
  if (
    request.rerank === true ||
    response.explain?.retrieval.rerank_applied === true ||
    (rerank !== undefined && rerank.backend !== "disabled")
  ) {
    registry.incrementCounter("memory_recall_rerank_enabled_total");
  }

  const scopeConflictPolicy = normalizeScopeConflictPolicy(request.scope_conflict_policy);
  if (scopeConflictPolicy) {
    registry.incrementCounter("memory_recall_scope_conflict_applied_total", { policy: scopeConflictPolicy });
  }

  recordRecallCacheRatio(response, registry);
}

export function recordHttpDomainLatency(
  routeLabel: string,
  durationMs: number,
  registry: InMemoryRequestMetrics = metrics
): void {
  initializeDomainMetrics(registry);
  if (routeLabel.includes("/recall")) {
    registry.observeHistogram("memory_recall_latency_ms", durationMs, { route: routeLabel }, "histogram");
  }
  if (routeLabel.includes("/write") || routeLabel.includes("/remember") || routeLabel.includes("/smart-write")) {
    registry.observeHistogram("memory_write_latency_ms", durationMs, { route: routeLabel }, "histogram");
  }
}

export function recordEmbeddingProviderCall(input: {
  readonly provider: string;
  readonly status: string;
  readonly latencyMs: number;
  readonly httpStatus?: number;
}, registry: InMemoryRequestMetrics = metrics): void {
  initializeDomainMetrics(registry);
  registry.incrementCounter("memory_embedding_calls_total", { provider: input.provider, status: input.status });
  registry.observeHistogram("memory_embedding_latency_ms", input.latencyMs, { provider: input.provider, status: input.status }, "histogram");
  if (input.httpStatus === 429 || input.status === "429") {
    registry.incrementCounter("memory_embedding_429_total", { provider: input.provider });
  }
}

export function recordRerankerFallback(reason: string, registry: InMemoryRequestMetrics = metrics): void {
  initializeDomainMetrics(registry);
  registry.incrementCounter("memory_reranker_fallback_total", { reason: reason || "unknown" });
}

export function recordProjectorLagSeconds(
  eventCreatedAt: string,
  observedAt: string = new Date().toISOString(),
  registry: InMemoryRequestMetrics = metrics
): void {
  const created = Date.parse(eventCreatedAt);
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(created) || !Number.isFinite(observed)) {
    return;
  }
  const lagSeconds = Math.max(0, (observed - created) / 1000);
  initializeDomainMetrics(registry);
  registry.observeHistogram("memory_projector_lag_seconds", lagSeconds, {}, "histogram");
}

export function recordProjectorDeadLetter(reason: string | undefined, registry: InMemoryRequestMetrics = metrics): void {
  initializeDomainMetrics(registry);
  registry.incrementCounter("memory_projector_dead_letter_total", { reason: normalizeProjectorDeadLetterReason(reason) });
}

export function recordProjectorReadbackVerifyFail(registry: InMemoryRequestMetrics = metrics): void {
  initializeDomainMetrics(registry);
  registry.incrementCounter("memory_projector_readback_verify_fail_total");
}

export function recordGovernanceActionMetric(
  actionType: string,
  status: string,
  registry: InMemoryRequestMetrics = metrics
): void {
  initializeDomainMetrics(registry);
  registry.incrementCounter("memory_governance_action_total", {
    type: actionType || "unknown",
    status: status || "unknown"
  });
}

export async function refreshScrapeDomainMetrics(
  database: WriteTransactionRunner | null | undefined,
  registry: InMemoryRequestMetrics = metrics
): Promise<void> {
  initializeDomainMetrics(registry);
  const qdrantSnapshot = getQdrantRuntimeSnapshot({
    queryTimeoutMs: Number.parseInt(process.env.MEMORY_V2_QDRANT_QUERY_TIMEOUT_MS?.trim() || "1200", 10),
    writeTimeoutMs: Number.parseInt(process.env.MEMORY_V2_QDRANT_WRITE_TIMEOUT_MS?.trim() || "5000", 10),
  });
  registry.setGauge("memory_qdrant_query_timeouts_total", qdrantSnapshot.query_timeouts);
  registry.setGauge("memory_qdrant_write_timeouts_total", qdrantSnapshot.write_timeouts);
  registry.setGauge("memory_qdrant_query_timeout_ms", qdrantSnapshot.query_timeout_ms);
  registry.setGauge("memory_qdrant_write_timeout_ms", qdrantSnapshot.write_timeout_ms);

  const postCommit = getPostCommitDegradedSnapshot();
  registry.setGauge("memory_post_commit_degraded_total", postCommit.total);
  registry.setGauge("memory_post_commit_degraded_cache_invalidation_failed", postCommit.cache_invalidation_failed);
  registry.setGauge("memory_post_commit_degraded_projection_sync_failed", postCommit.projection_sync_failed);

  if (!database) {
    return;
  }

  try {
    const rows = await loadSilentApproveRateRows(database);
    for (const row of rows) {
      registry.setGauge("memory_governance_silent_approve_fp_rate", row.falsePositiveRate, {
        agent: row.agent,
        scope: row.scope
      });
      registry.setGauge("memory_governance_silent_approve_adoption_rate", row.adoptionRate, {
        agent: row.agent,
        scope: row.scope
      });
    }
  } catch {
    // Scrape-time gauges are best-effort; metrics must not make /metrics fail.
  }
}

function bucketQualityGate(qualityGate: QualityGateLike | null | undefined): WriteQualityBucket | null {
  if (!qualityGate) {
    return null;
  }

  const action = typeof qualityGate.action === "string" ? qualityGate.action : "";
  if (action === "continue") {
    return "passed";
  }
  if (action === "candidate_pending") {
    return "pending";
  }
  if (action === "buffer") {
    return "abandoned";
  }

  const score = typeof qualityGate.score === "number" && Number.isFinite(qualityGate.score)
    ? qualityGate.score
    : undefined;
  if (score !== undefined) {
    if (score >= 0.75) return "passed";
    if (score >= 0.60) return "pending";
    return "abandoned";
  }

  return qualityGate.passed === true ? "passed" : null;
}

function normalizeDegradeLevel(value: unknown): 0 | 1 | 2 | 3 {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed <= 0) return 0;
  if (parsed >= 3) return 3;
  return Math.floor(parsed) as 0 | 1 | 2 | 3;
}

function normalizeScopeConflictPolicy(value: unknown): string | null {
  switch (value) {
    case "more_specific_wins":
      return "more_specific";
    case "higher_scope_wins":
      return "higher_scope";
    case "latest_wins":
      return "latest";
    default:
      return null;
  }
}

function recordRecallCacheRatio(response: RecallResponse, registry: InMemoryRequestMetrics): void {
  const audit = response.audit.cache;
  if (!audit) {
    return;
  }

  let hits = 0;
  let checks = 0;
  for (const item of [audit.startup_context, audit.search]) {
    if (item.status === "hit" || item.status === "miss") {
      checks += 1;
      if (item.status === "hit") {
        hits += 1;
      }
    }
  }

  if (checks === 0) {
    return;
  }

  const current = recallCacheStats.get(registry) ?? { hits: 0, checks: 0 };
  current.hits += hits;
  current.checks += checks;
  recallCacheStats.set(registry, current);
  registry.setGauge("memory_cache_recall_cache_hit_ratio", roundRate(current.hits / current.checks));
}

function normalizeProjectorDeadLetterReason(reason: string | undefined): string {
  const value = (reason ?? "unknown").toLowerCase();
  if (value.includes("projection_verify_failed") || value.includes("verify")) {
    return "verify_failed";
  }
  if (value.includes("idempot") || value.includes("conflict") || value.includes("duplicate")) {
    return "idempotency_conflict";
  }
  if (value.includes("timeout")) {
    return "timeout";
  }
  if (value.includes("embedding")) {
    return "embedding_missing";
  }
  if (value.includes("qdrant")) {
    return "qdrant_error";
  }
  return "unknown";
}

async function loadSilentApproveRateRows(database: WriteTransactionRunner): Promise<readonly SilentApproveRateRow[]> {
  return withWriteTransaction(database, async (tx) => {
    if (isPostgresTransactionContext(tx)) {
      const rows = await tx.query<{
        agent: string;
        scope: string;
        sample_size: number | string;
        false_positive_rate: number | string;
        adoption_rate: number | string;
      }>(`
        WITH silent AS (
          SELECT
            COALESCE(agent_id, metadata->>'agent_id', created_by, 'unknown') AS agent,
            scope_type || ':' || scope_id AS scope,
            id
          FROM memory_records
          WHERE review_state = 'silent_approved'
            AND created_at <= now() - interval '24 hours'
        ),
        feedback AS (
          SELECT memory_id,
            count(*) FILTER (WHERE feedback_type IN ('wrong', 'deleted', 'not_relevant'))::int AS fp,
            count(*) FILTER (WHERE feedback_type IN ('confirmed', 'used'))::int AS adopted
          FROM memory_feedback_events
          GROUP BY memory_id
        )
        SELECT
          s.agent,
          s.scope,
          count(*)::int AS sample_size,
          CASE WHEN count(*) = 0 THEN 0 ELSE COALESCE(sum(f.fp), 0)::float / count(*) END AS false_positive_rate,
          CASE WHEN count(*) = 0 THEN 0 ELSE COALESCE(sum(f.adopted), 0)::float / count(*) END AS adoption_rate
        FROM silent s
        LEFT JOIN feedback f ON f.memory_id = s.id
        GROUP BY 1, 2
        ORDER BY sample_size DESC, false_positive_rate DESC
        LIMIT 200
      `);
      return rows.map((row) => ({
        agent: String(row.agent ?? "unknown"),
        scope: String(row.scope ?? "unknown"),
        sampleSize: Number(row.sample_size ?? 0),
        falsePositiveRate: roundRate(Number(row.false_positive_rate ?? 0)),
        adoptionRate: roundRate(Number(row.adoption_rate ?? 0)),
      }));
    }

    const feedbackByMemory = new Map<string, { fp: number; adopted: number }>();
    for (const feedback of tx.state.memoryFeedbackEvents) {
      const current = feedbackByMemory.get(feedback.memoryId) ?? { fp: 0, adopted: 0 };
      if (["wrong", "deleted", "not_relevant"].includes(feedback.feedbackType)) {
        current.fp += 1;
      }
      if (["confirmed", "used"].includes(feedback.feedbackType)) {
        current.adopted += 1;
      }
      feedbackByMemory.set(feedback.memoryId, current);
    }

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const groups = new Map<string, { agent: string; scope: string; sample: number; fp: number; adopted: number }>();
    for (const memory of tx.state.memoryRecords) {
      if (memory.reviewState !== "silent_approved" || Date.parse(memory.createdAt) > cutoff) {
        continue;
      }
      const agent = readMetadataString(memory.metadata, "agent_id") ?? memory.agentId ?? memory.createdBy ?? "unknown";
      const scope = `${memory.scopeType}:${memory.scopeId}`;
      const key = `${agent}\n${scope}`;
      const current = groups.get(key) ?? { agent, scope, sample: 0, fp: 0, adopted: 0 };
      const feedback = feedbackByMemory.get(memory.id) ?? { fp: 0, adopted: 0 };
      current.sample += 1;
      current.fp += feedback.fp;
      current.adopted += feedback.adopted;
      groups.set(key, current);
    }

    return [...groups.values()].map((group) => ({
      agent: group.agent,
      scope: group.scope,
      sampleSize: group.sample,
      falsePositiveRate: roundRate(group.sample === 0 ? 0 : group.fp / group.sample),
      adoptionRate: roundRate(group.sample === 0 ? 0 : group.adopted / group.sample),
    }));
  });
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function roundRate(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : 0;
}
