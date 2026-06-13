import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConsolidationCandidateReport,
  type ConsolidationCandidateRecord,
} from "../app/governance/consolidation-candidates";

function record(input: Partial<ConsolidationCandidateRecord> & Pick<ConsolidationCandidateRecord, "id" | "content">): ConsolidationCandidateRecord {
  return {
    id: input.id,
    scope_type: input.scope_type ?? "project",
    scope_id: input.scope_id ?? "memory-xx",
    title: input.title ?? input.id,
    content: input.content,
    memory_type: input.memory_type ?? "fact",
    memory_class: input.memory_class ?? "long_term_fact",
    cognitive_type: input.cognitive_type ?? "semantic",
    recall_policy: input.recall_policy ?? "default",
    lifecycle_status: input.lifecycle_status ?? "approved",
    review_state: input.review_state ?? "approved",
    is_current: input.is_current ?? true,
    topic: input.topic ?? "runtime",
    source: input.source ?? "conversation_ingest",
    observed_at: input.observed_at ?? "2026-06-05T08:00:00.000Z",
    updated_at: input.updated_at ?? "2026-06-05T08:00:00.000Z",
    memory_strength: input.memory_strength ?? 0.8,
  };
}

test("consolidation report groups duplicated semantic facts without mutating records", () => {
  const report = buildConsolidationCandidateReport({
    records: [
      record({
        id: "port-a",
        content: "The memory-xx API listens on port 5100 in production.",
        topic: "api-port",
        updated_at: "2026-06-05T08:00:00.000Z",
      }),
      record({
        id: "port-b",
        content: "Production memory-xx API listens on port 5100.",
        topic: "api-port",
        updated_at: "2026-06-05T09:00:00.000Z",
      }),
      record({
        id: "model",
        content: "The default model is dreamfield/DeepSeek-V4-Flash.",
        topic: "model",
      }),
    ],
    semanticSimilarityThreshold: 0.55,
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.summary.by_type.semantic_duplicate_cluster, 1);
  assert.equal(report.candidates[0]?.candidate_type, "semantic_duplicate_cluster");
  assert.equal(report.candidates[0]?.representative_memory_id, "port-b");
  assert.deepEqual(report.candidates[0]?.memory_ids, ["port-a", "port-b"]);
  assert.equal(report.candidates[0]?.suggested_action, "review_merge_or_supersede");
});

test("consolidation report groups repeated episodic observations by scope source and day", () => {
  const report = buildConsolidationCandidateReport({
    records: [
      record({
        id: "obs-1",
        content: "Auto-approval rollout check reported candidate_only still enabled.",
        cognitive_type: "episodic",
        memory_class: "operational_issue",
        recall_policy: "explicit_only",
        topic: "auto-approval-rollout",
        source: "conversation_ingest",
        observed_at: "2026-06-05T08:00:00.000Z",
        memory_strength: 0.4,
      }),
      record({
        id: "obs-2",
        content: "Auto-approval rollout check reported pending candidates still high.",
        cognitive_type: "episodic",
        memory_class: "operational_issue",
        recall_policy: "explicit_only",
        topic: "auto-approval-rollout",
        source: "conversation_ingest",
        observed_at: "2026-06-05T09:00:00.000Z",
        memory_strength: 0.5,
      }),
      record({
        id: "obs-other-day",
        content: "Auto-approval rollout check on a different day.",
        cognitive_type: "episodic",
        memory_class: "operational_issue",
        recall_policy: "explicit_only",
        topic: "auto-approval-rollout",
        source: "conversation_ingest",
        observed_at: "2026-06-06T09:00:00.000Z",
      }),
    ],
    minEpisodicClusterSize: 2,
  });

  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.summary.by_type.episodic_observation_cluster, 1);
  assert.equal(report.candidates[0]?.candidate_type, "episodic_observation_cluster");
  assert.equal(report.candidates[0]?.representative_memory_id, "obs-2");
  assert.deepEqual(report.candidates[0]?.memory_ids, ["obs-1", "obs-2"]);
  assert.equal(report.candidates[0]?.suggested_action, "review_episode_summary_candidate");
});
