import assert from "node:assert/strict";
import test from "node:test";

import { buildMemoryEvolveObservationReflectionSection } from "../app/governance/memory-evolve-observation-reflection";
import { planConversationMemoryRoute } from "../app/governance/observer-reflector-governor";

test("memory evolve builds observation reflection section from persisted conversation rows", () => {
  const route = planConversationMemoryRoute({
    source: "conversation_ingest",
    scopeType: "project",
    scopeId: "memory-xx",
    messages: [
      { role: "user", content: "tsx 在 WSL 下因为 socket 失败。" },
      { role: "assistant", content: "设置 TMPDIR=/tmp 后 typecheck exit 0。" },
    ],
  });

  const section = buildMemoryEvolveObservationReflectionSection({
    generatedAt: "2026-06-05T12:30:00.000Z",
    batches: [
      {
        id: "cb-1",
        scope_context: { project_ids: ["memory-xx"] },
        metadata: { conversation_memory_route: route },
        created_at: "2026-06-05T10:00:00.000Z",
      },
    ],
    events: [
      {
        id: "event-1",
        batch_id: "cb-1",
        role: "user",
        content: "tsx 在 WSL 下因为 socket 失败。",
        observed_at: "2026-06-05T10:00:00.000Z",
      },
      {
        id: "event-2",
        batch_id: "cb-1",
        role: "assistant",
        content: "设置 TMPDIR=/tmp 后 typecheck exit 0。",
        observed_at: "2026-06-05T10:01:00.000Z",
      },
    ],
    minSemanticObservations: 2,
  });

  assert.equal(section.summary.total_observations, 1);
  assert.equal(section.summary.total_candidates, 1);
  assert.equal(section.candidates[0]?.candidate_type, "procedural_reflection_candidate");
  assert.deepEqual(section.candidates[0]?.observation_ids, ["cb-1"]);
  assert.equal(section.review_queue.summary.total_review_items, 1);
  assert.equal(section.review_queue.summary.retention_only_items, 0);
  assert.equal(section.review_queue.summary.actionable_review_items, 1);
  assert.equal(section.review_queue.summary.by_queue.reflector_candidate, 1);
  assert.equal(section.review_queue.items[0]?.reflection_candidate_ids[0], section.candidates[0]?.candidate_id);
});
