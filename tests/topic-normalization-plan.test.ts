import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTopicNormalizationPlan,
  buildTopicNormalizationReviewQueue,
  type TopicNormalizationAliasRow,
} from "../app/governance/topic-normalization-plan";

function alias(input: Partial<TopicNormalizationAliasRow> & Pick<TopicNormalizationAliasRow, "candidate_id">): TopicNormalizationAliasRow {
  return {
    candidate_id: input.candidate_id,
    source_topic: input.source_topic ?? "api-port-old-topic",
    candidate_topic: input.candidate_topic ?? "runtime-port",
    supporting_discoveries: input.supporting_discoveries ?? 2,
    avg_confidence: input.avg_confidence ?? 0.82,
    sample_memory_ids: input.sample_memory_ids ?? ["old-target", "new-target", "new-target-2"],
  };
}

test("topic normalization plan converts alias candidates into review-only canonicalization plans", () => {
  const report = buildTopicNormalizationPlan({
    generatedAt: "2026-06-05T00:00:00.000Z",
    aliases: [
      alias({ candidate_id: "topic-alias:api-port-old-topic-runtime-port" }),
      alias({ candidate_id: "topic-alias:noise", source_topic: "", candidate_topic: "runtime-port" }),
    ],
  });

  assert.equal(report.ok, true);
  assert.equal(report.generated_at, "2026-06-05T00:00:00.000Z");
  assert.equal(report.report_only, true);
  assert.equal(report.apply_allowed, false);
  assert.equal(report.summary.total_aliases, 2);
  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.summary.by_action.review_topic_normalization, 1);
  assert.equal(report.candidates[0]?.candidate_type, "topic_normalization_candidate");
  assert.equal(report.candidates[0]?.source_topic, "api-port-old-topic");
  assert.equal(report.candidates[0]?.canonical_topic, "runtime-port");
  assert.deepEqual(report.candidates[0]?.affected_memory_ids, ["new-target", "new-target-2", "old-target"]);
  assert.equal(report.candidates[0]?.suggested_action, "review_topic_normalization");
  assert.equal(report.candidates[0]?.apply_allowed, false);
  assert.deepEqual(report.candidates[0]?.blockers, ["report_only", "requires_human_review"]);
});

test("topic normalization review queue prioritizes normalization candidates for human review", () => {
  const plan = buildTopicNormalizationPlan({
    aliases: [
      alias({
        candidate_id: "topic-alias:api-port-old-topic-runtime-port",
        supporting_discoveries: 3,
        sample_memory_ids: ["old-target", "new-target", "another-target"],
      }),
    ],
  });
  const queue = buildTopicNormalizationReviewQueue({
    generatedAt: "2026-06-05T00:00:00.000Z",
    plan,
  });

  assert.equal(queue.ok, true);
  assert.equal(queue.generated_at, "2026-06-05T00:00:00.000Z");
  assert.equal(queue.report_only, true);
  assert.equal(queue.apply_allowed, false);
  assert.equal(queue.summary.total_review_items, 1);
  assert.equal(queue.summary.by_queue.topic_normalization_review, 1);
  assert.equal(queue.items[0]?.queue, "topic_normalization_review");
  assert.equal(queue.items[0]?.priority, "high");
  assert.equal(queue.items[0]?.normalization_candidate_id, plan.candidates[0]?.candidate_id);
  assert.equal(queue.items[0]?.recommended_action, "review_topic_normalization");
  assert.deepEqual(queue.items[0]?.required_before_apply, [
    "human_review",
    "topic_alias_scope_check",
    "affected_memory_sample_review",
  ]);
});

test("topic normalization marks same-source multi-canonical aliases as ambiguous review work", () => {
  const plan = buildTopicNormalizationPlan({
    aliases: [
      alias({
        candidate_id: "topic-alias:old-topic-runtime-port",
        source_topic: "old-topic",
        candidate_topic: "runtime-port",
        sample_memory_ids: ["old", "runtime"],
      }),
      alias({
        candidate_id: "topic-alias:old-topic-release-gate",
        source_topic: "old-topic",
        candidate_topic: "release-gate",
        sample_memory_ids: ["old", "release"],
      }),
    ],
  });

  assert.equal(plan.summary.total_candidates, 2);
  assert.equal(plan.summary.ambiguous_source_topics, 1);
  assert.ok(plan.candidates.every((candidate) => candidate.review_signal === "ambiguous_multi_canonical"));
  assert.deepEqual(
    plan.candidates.map((candidate) => candidate.evidence.alternative_canonical_topics).sort(),
    [
      ["release-gate"],
      ["runtime-port"],
    ],
  );

  const queue = buildTopicNormalizationReviewQueue({ plan });

  assert.equal(queue.summary.ambiguous_review_items, 2);
  assert.ok(queue.items.every((item) => item.priority === "high"));
  assert.ok(queue.items.every((item) => item.review_signal === "ambiguous_multi_canonical"));
  assert.ok(queue.items.every((item) => item.required_before_apply.includes("canonical_topic_disambiguation")));
});
