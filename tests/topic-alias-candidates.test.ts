import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTopicAliasCandidateReport,
  type TopicAliasDiscoveryRow,
} from "../app/governance/topic-alias-candidates";

function discovery(input: Partial<TopicAliasDiscoveryRow> & Pick<TopicAliasDiscoveryRow, "candidate_id">): TopicAliasDiscoveryRow {
  return {
    candidate_id: input.candidate_id,
    relation_id: input.relation_id ?? "rel-1",
    source_memory_id: input.source_memory_id ?? "source-1",
    old_target_memory_id: input.old_target_memory_id ?? "old-target",
    candidate_successor_memory_id: input.candidate_successor_memory_id ?? "new-target",
    source_topic: input.source_topic ?? "api-port-old-topic",
    candidate_topic: input.candidate_topic ?? "runtime-port",
    match_type: input.match_type ?? "same_scope_lexical",
    confidence: input.confidence ?? 0.82,
    shared_terms: input.shared_terms ?? ["api", "runtime", "migration"],
  };
}

test("topic alias candidates aggregate successor discovery alias suggestions", () => {
  const report = buildTopicAliasCandidateReport({
    generatedAt: "2026-06-05T00:00:00.000Z",
    discoveries: [
      discovery({ candidate_id: "disc-1", relation_id: "rel-1" }),
      discovery({ candidate_id: "disc-2", relation_id: "rel-2", candidate_successor_memory_id: "new-target-2" }),
      discovery({ candidate_id: "disc-noise", source_topic: "", candidate_topic: "runtime-port" }),
    ],
  });

  assert.equal(report.ok, true);
  assert.equal(report.generated_at, "2026-06-05T00:00:00.000Z");
  assert.equal(report.report_only, true);
  assert.equal(report.apply_allowed, false);
  assert.equal(report.summary.total_discoveries, 3);
  assert.equal(report.summary.total_candidates, 1);
  assert.equal(report.summary.by_action.review_topic_alias, 1);
  assert.equal(report.candidates[0]?.candidate_type, "topic_alias_candidate");
  assert.equal(report.candidates[0]?.source_topic, "api-port-old-topic");
  assert.equal(report.candidates[0]?.candidate_topic, "runtime-port");
  assert.equal(report.candidates[0]?.supporting_discoveries, 2);
  assert.equal(report.candidates[0]?.suggested_action, "review_topic_alias");
  assert.equal(report.candidates[0]?.apply_allowed, false);
  assert.deepEqual(report.candidates[0]?.blockers, ["report_only", "requires_human_review"]);
  assert.deepEqual(
    report.candidates[0]?.evidence.samples.map((sample) => sample.discovery_candidate_id),
    ["disc-1", "disc-2"],
  );
});
