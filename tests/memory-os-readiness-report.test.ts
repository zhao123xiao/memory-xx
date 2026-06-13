import test from "node:test";
import assert from "node:assert/strict";

import { buildMemoryOsReadinessReport } from "../app/governance/memory-os-readiness-report";

test("memory os readiness report maps evolve debt into governed capability domains", () => {
  const report = buildMemoryOsReadinessReport({
    pendingSafeCloseCandidates: 10,
    pendingRequiresHumanReview: 2,
    temporalValidityDebtCandidates: 3,
    temporalTransitionCandidates: 4,
    memoryLinkCandidates: 5,
    graphOrphanCandidates: 6,
    graphRelationRepairCandidates: 4,
    graphRelationRepairTopActions: [
      {
        action: "retarget_relation_to_successor",
        count: 3,
      },
    ],
    topicNormalizationReviewQueueCandidates: 6,
    graphOrphanTopReasons: [
      {
        reason: "missing_relation",
        count: 4,
        suggested_action: "review_graph_enrichment",
      },
      {
        reason: "missing_relation_target",
        count: 2,
        suggested_action: "review_relation_repair_or_archive",
      },
    ],
    adaptiveCalibrationCohorts: 7,
    contextHygieneCandidates: 8,
    consolidationCandidates: 9,
    extractionRecallCandidates: 10,
    recallFeedbackCandidates: 11,
    policyFeedbackBackpropCandidates: 12,
    observationReflectionCandidates: 13,
    observationReviewQueueCandidates: 14,
    proceduralPromotionCandidates: 15,
  }, "2026-06-05T00:00:00.000Z");

  assert.equal(report.ok, true);
  assert.equal(report.generated_at, "2026-06-05T00:00:00.000Z");
  assert.equal(report.report_only, true);
  assert.equal(report.apply_allowed, false);
  assert.equal(report.summary.capability_domains, 5);
  assert.equal(report.summary.domains_with_debt, 5);
  assert.equal(report.summary.total_action_candidates, 5);
  assert.equal(report.summary.raw_debt_signals, 161);
  assert.equal(typeof report.summary.overall_readiness_percent, "number");
  assert.equal(report.summary.overall_readiness_percent > 0, true);
  assert.equal(report.summary.overall_readiness_percent < 100, true);
  assert.equal(report.summary.lowest_readiness_domain, "governance");
  assert.deepEqual(
    report.summary.top_blockers.map((blocker) => [blocker.domain, blocker.action_candidates]),
    [
      ["governance", 53],
      ["update", 43],
      ["maintenance", 33],
    ],
  );
  assert.equal(report.summary.report_only, true);
  assert.equal(report.summary.apply_allowed, false);
  assert.deepEqual(
    report.domains.map((domain) => [domain.domain, domain.action_candidates, domain.status, typeof domain.readiness_percent]),
    [
      ["storage", 17, "needs_attention", "number"],
      ["update", 43, "needs_attention", "number"],
      ["retrieval", 15, "needs_attention", "number"],
      ["governance", 53, "needs_attention", "number"],
      ["maintenance", 33, "needs_attention", "number"],
    ],
  );
  const storage = report.domains.find((domain) => domain.domain === "storage");
  assert.deepEqual(storage?.top_blockers, [
    {
      source: "topic_normalization_review",
      reason: "review_topic_normalization",
      action_candidates: 6,
      recommended_next_step: "review topic aliases before canonical topic rewrites",
    },
    {
      source: "graph_orphan",
      reason: "missing_relation",
      action_candidates: 4,
      recommended_next_step: "review_graph_enrichment",
    },
    {
      source: "graph_relation_repair",
      reason: "retarget_relation_to_successor",
      action_candidates: 3,
      recommended_next_step: "retarget_relation_to_successor",
    },
    {
      source: "graph_orphan",
      reason: "missing_relation_target",
      action_candidates: 2,
      recommended_next_step: "review_relation_repair_or_archive",
    },
  ]);
  assert.equal(storage?.evidence_keys.includes("topic_normalization_review_queue_candidates"), true);
  assert.equal(report.domains.every((domain) => domain.readiness_percent < 100), true);
});

test("memory os readiness report uses production graph debt when lane counts are available", () => {
  const report = buildMemoryOsReadinessReport({
    graphOrphanCandidates: 67,
    graphOrphanProductionCandidates: 1,
    graphRelationRepairCandidates: 19,
    graphRelationRepairProductionCandidates: 1,
    graphRelationRepairTopActions: [
      {
        action: "review_successor_before_retarget",
        count: 19,
      },
    ],
    graphRelationRepairProductionTopActions: [
      {
        action: "review_successor_before_retarget",
        count: 1,
      },
    ],
    graphOrphanTopReasons: [
      {
        reason: "non_current_relation_target",
        count: 19,
        suggested_action: "review_relation_repair_or_archive",
      },
    ],
    graphOrphanProductionTopReasons: [
      {
        reason: "non_current_relation_target",
        count: 1,
        suggested_action: "review_relation_repair_or_archive",
      },
    ],
  });

  const storage = report.domains.find((domain) => domain.domain === "storage");
  assert.equal(storage?.action_candidates, 1);
  assert.deepEqual(storage?.top_blockers, [
    {
      source: "graph_orphan",
      reason: "non_current_relation_target",
      action_candidates: 1,
      recommended_next_step: "review_relation_repair_or_archive",
    },
    {
      source: "graph_relation_repair",
      reason: "review_successor_before_retarget",
      action_candidates: 1,
      recommended_next_step: "review_successor_before_retarget",
    },
  ]);
  assert.equal(report.summary.raw_debt_signals, 1);
});

test("memory os readiness report keeps clean domains explicit", () => {
  const report = buildMemoryOsReadinessReport({});

  assert.equal(report.summary.capability_domains, 5);
  assert.equal(report.summary.domains_with_debt, 0);
  assert.equal(report.summary.total_action_candidates, 0);
  assert.equal(report.summary.raw_debt_signals, 0);
  assert.equal(report.summary.overall_readiness_percent, 100);
  assert.equal(["storage", "update", "retrieval", "governance", "maintenance"].includes(report.summary.lowest_readiness_domain), true);
  assert.deepEqual(report.summary.top_blockers, []);
  assert.equal(report.domains.every((domain) => domain.status === "clean"), true);
  assert.equal(report.domains.every((domain) => domain.action_candidates === 0), true);
  assert.equal(report.domains.every((domain) => domain.readiness_percent === 100), true);
});
