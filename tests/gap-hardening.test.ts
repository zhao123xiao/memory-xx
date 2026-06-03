import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCutoverGate,
  evaluateP1ProductionGate,
  evaluateP1ProductionGateWithDatabase,
  InMemoryWriteDatabase,
  IntelligenceCompareObservationRepository,
  withWriteTransaction
} from "../app";

test("cutover gate fails closed when metrics are missing or under-sampled", () => {
  const missing = evaluateCutoverGate("m4");
  assert.equal(missing.ok, false);
  assert.equal(missing.blockers.includes("cutover_metrics_missing"), true);
  assert.equal(missing.status, "skipped-no-sample");

  const underSampled = evaluateCutoverGate("m4", {
    metrics: [
      { metricId: "query_pass_rate", actual: 1, sampleSize: 1, minSampleSize: 20, dataSource: "recall_feedback_events", window: "24h" }
    ]
  });
  assert.equal(underSampled.ok, false);
  assert.equal(underSampled.blockers.includes("query_pass_rate:sample_size_below_minimum"), true);
});

test("p1 production gate blocks unsafe async recovery settings", () => {
  const result = evaluateP1ProductionGate({
    MEMORY_V2_FAST_ACK_INLINE_FALLBACK: "true",
    MEMORY_V2_ACCEPTED_EXPIRED_BACKLOG: "1",
    MEMORY_V2_WRITE_TICKET_PROCESSING_BACKLOG: "2",
    MEMORY_V2_CACHE_INVALIDATION_BACKLOG: "3",
    MEMORY_V2_P1_GATE_METRICS_JSON: JSON.stringify([
      { metricId: "query_pass_rate", actual: 1, sampleSize: 50, dataSource: "recall_feedback_events", window: "24h" },
      { metricId: "default_filter_accuracy", actual: 1, sampleSize: 50, dataSource: "audit_samples", window: "24h" },
      { metricId: "zero_hit_regression_delta", actual: 0, sampleSize: 50, dataSource: "recall_audit", window: "24h" },
      { metricId: "cache_invalidation_accuracy", actual: 1, sampleSize: 50, dataSource: "cache_audit", window: "24h" },
    ])
  });
  assert.equal(result.ok, false);
  assert.equal(result.blockers.includes("fast_ack_inline_fallback_enabled"), true);
  assert.equal(result.blockers.includes("accepted_expired_backlog:1"), true);
  assert.equal(result.blockers.includes("write_ticket_processing_backlog:2"), true);
  assert.equal(result.blockers.includes("cache_invalidation_backlog:3"), true);
});

test("p1 production gate surfaces policy training readiness and blocks leakage", () => {
  const baseEnv = {
    MEMORY_V2_DATABASE_URL: "postgres://memory-xx-test",
    MEMORY_V2_API_TOKEN: "api-token",
    EMBEDDING_API_KEY: "embedding-token",
    MEMORY_V2_STRICT_SCOPE: "true",
    MEMORY_V2_P1_GATE_METRICS_JSON: JSON.stringify([
      { metricId: "query_pass_rate", actual: 1, sampleSize: 50, dataSource: "recall_feedback_events", window: "24h" },
      { metricId: "default_filter_accuracy", actual: 1, sampleSize: 50, dataSource: "audit_samples", window: "24h" },
      { metricId: "zero_hit_regression_delta", actual: 0, sampleSize: 50, dataSource: "recall_audit", window: "24h" },
      { metricId: "cache_invalidation_accuracy", actual: 1, sampleSize: 50, dataSource: "cache_audit", window: "24h" },
    ])
  };

  const undertrained = evaluateP1ProductionGate({
    ...baseEnv,
    MEMORY_V2_POLICY_TRAINING_SUMMARY_JSON: JSON.stringify({
      progress_percent: 80,
      production_readiness_score: 0.97,
      leakage_eval: { default_leakage: 0 }
    })
  });
  assert.equal(undertrained.ok, true);
  assert.equal(undertrained.warnings.includes("policy_training_progress_below_release_threshold:80/90"), true);

  const leaked = evaluateP1ProductionGate({
    ...baseEnv,
    MEMORY_V2_POLICY_TRAINING_SUMMARY_JSON: JSON.stringify({
      progress_percent: 90,
      production_readiness_score: 0.98,
      leakage_eval: { default_leakage: 1 }
    })
  });
  assert.equal(leaked.ok, false);
  assert.equal(leaked.blockers.includes("policy_training_default_recall_leakage:1"), true);
});


test("p1 production gate can derive intelligence compare high diff rate from database observations", async () => {
  const database = new InMemoryWriteDatabase();
  const repository = new IntelligenceCompareObservationRepository();
  await withWriteTransaction(database, async (tx) => {
    for (let index = 0; index < 20; index += 1) {
      await repository.append(tx, {
        observedAt: new Date().toISOString(),
        primaryModel: "primary",
        fallbackModel: "fallback",
        primaryLatencyMs: 10,
        fallbackLatencyMs: 12,
        primarySchemaValid: true,
        fallbackSchemaValid: true,
        memoryCountDiff: index < 6 ? 1 : 0,
        confidenceDiff: index < 6 ? 0.4 : 0.01
      });
    }
  });

  const result = await evaluateP1ProductionGateWithDatabase({
    MEMORY_V2_DATABASE_URL: "postgres://memory-xx-test",
    MEMORY_V2_API_TOKEN: "api-token",
    EMBEDDING_API_KEY: "embedding-token",
    MEMORY_V2_STRICT_SCOPE: "true",
    MEMORY_V2_P1_GATE_METRICS_JSON: JSON.stringify([
      { metricId: "query_pass_rate", actual: 1, sampleSize: 50, dataSource: "recall_feedback_events", window: "24h" },
      { metricId: "default_filter_accuracy", actual: 1, sampleSize: 50, dataSource: "audit_samples", window: "24h" },
      { metricId: "zero_hit_regression_delta", actual: 0, sampleSize: 50, dataSource: "recall_audit", window: "24h" },
      { metricId: "cache_invalidation_accuracy", actual: 1, sampleSize: 50, dataSource: "cache_audit", window: "24h" },
    ])
  }, { database });

  assert.equal(result.ok, false);
  assert.equal(result.blockers.includes("intelligence_compare_high_diff_rate:0.3"), true);
  assert.equal(result.warnings.includes("intelligence_compare_observations_summary:6/20"), true);
});

test("p1 production gate treats clean intelligence compare observations as pass signal", async () => {
  const database = new InMemoryWriteDatabase();
  const repository = new IntelligenceCompareObservationRepository();
  await withWriteTransaction(database, async (tx) => {
    for (let index = 0; index < 20; index += 1) {
      await repository.append(tx, {
        observedAt: new Date().toISOString(),
        primaryModel: "primary",
        fallbackModel: "fallback",
        primaryLatencyMs: 10,
        fallbackLatencyMs: 12,
        primarySchemaValid: true,
        fallbackSchemaValid: true,
        memoryCountDiff: 0,
        confidenceDiff: 0
      });
    }
  });

  const result = await evaluateP1ProductionGateWithDatabase({
    MEMORY_V2_DATABASE_URL: "postgres://memory-xx-test",
    MEMORY_V2_API_TOKEN: "api-token",
    EMBEDDING_API_KEY: "embedding-token",
    MEMORY_V2_STRICT_SCOPE: "true",
    MEMORY_V2_P1_GATE_METRICS_JSON: JSON.stringify([
      { metricId: "query_pass_rate", actual: 1, sampleSize: 50, dataSource: "recall_feedback_events", window: "24h" },
      { metricId: "default_filter_accuracy", actual: 1, sampleSize: 50, dataSource: "audit_samples", window: "24h" },
      { metricId: "zero_hit_regression_delta", actual: 0, sampleSize: 50, dataSource: "recall_audit", window: "24h" },
      { metricId: "cache_invalidation_accuracy", actual: 1, sampleSize: 50, dataSource: "cache_audit", window: "24h" },
    ])
  }, { database });

  assert.equal(result.ok, true);
  assert.equal(result.warnings.some((warning) => warning.startsWith("intelligence_compare_observations_")), false);
});

test("p1 production gate blocks continuous intelligence compare high diff trend", async () => {
  const database = new InMemoryWriteDatabase();
  const repository = new IntelligenceCompareObservationRepository();
  const bucketStarts = [
    "2026-05-25T10:00:00.000Z",
    "2026-05-25T11:00:00.000Z",
    "2026-05-25T12:00:00.000Z"
  ];
  await withWriteTransaction(database, async (tx) => {
    for (const bucketStart of bucketStarts) {
      for (let index = 0; index < 10; index += 1) {
        await repository.append(tx, {
          observedAt: bucketStart,
          primaryModel: "primary",
          fallbackModel: "fallback",
          primaryLatencyMs: 10,
          fallbackLatencyMs: 12,
          primarySchemaValid: true,
          fallbackSchemaValid: true,
          memoryCountDiff: index < 3 ? 1 : 0,
          confidenceDiff: index < 3 ? 0.4 : 0.01
        });
      }
    }
  });

  const result = await evaluateP1ProductionGateWithDatabase({
    MEMORY_V2_P1_GATE_METRICS_JSON: JSON.stringify([
      { metricId: "query_pass_rate", actual: 1, sampleSize: 50, dataSource: "recall_feedback_events", window: "24h" },
      { metricId: "default_filter_accuracy", actual: 1, sampleSize: 50, dataSource: "audit_samples", window: "24h" },
      { metricId: "zero_hit_regression_delta", actual: 0, sampleSize: 50, dataSource: "recall_audit", window: "24h" },
      { metricId: "cache_invalidation_accuracy", actual: 1, sampleSize: 50, dataSource: "cache_audit", window: "24h" },
    ]),
    MEMORY_V2_P1_GATE_ALLOW_DEGRADED: "true"
  }, {
    database,
    compareNow: "2026-05-25T12:30:00.000Z",
    compareTrendMinSampleSize: 10
  });

  assert.equal(result.ok, false);
  assert.equal(result.blockers.includes("intelligence_compare_continuous_high_diff:3_buckets:max=0.3"), true);
  assert.equal(result.warnings.some((warning) => warning.startsWith("intelligence_compare_observations_trend:3/10@0.3")), true);
});

test("cutover gate blocks high-risk drift unless explicitly degraded", () => {
  const metrics = [
    { metricId: "query_pass_rate", actual: 0.99, sampleSize: 50, dataSource: "recall_feedback_events", window: "24h" },
    { metricId: "default_filter_accuracy", actual: 1, sampleSize: 50, dataSource: "audit_samples", window: "24h" },
    { metricId: "zero_hit_regression_delta", actual: 0, sampleSize: 50, dataSource: "recall_audit", window: "24h" },
    { metricId: "cache_invalidation_accuracy", actual: 1, sampleSize: 50, dataSource: "cache_audit", window: "24h" },
    { metricId: "candidate_only_false_positive_proxy", actual: 1, sampleSize: 50, dataSource: "intelligence_quality", window: "24h" },
  ];

  const blocked = evaluateCutoverGate("m4", { metrics });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockers.includes("candidate_only_false_positive_proxy:drift_detected"), true);

  const degraded = evaluateCutoverGate("m4", { metrics, allowDegraded: true });
  assert.equal(degraded.ok, true);
  assert.equal(degraded.warnings.includes("candidate_only_false_positive_proxy:drift_detected"), true);
});
