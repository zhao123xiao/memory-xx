import assert from "node:assert/strict";
import test from "node:test";

import { batchConversationEventsForPost } from "../scripts/run-conversation-monitor-worker";

function event(id: string, content: string): Record<string, unknown> {
  return {
    id,
    conversation_id: `conversation-${id}`,
    session_id: `session-${id}`,
    turn_id: `turn-${id}`,
    role: "user",
    content,
    source: "test",
    agent_id: "codex",
    scope_context: { project_ids: ["memory-xx"] },
    observed_at: "2026-06-06T00:00:00.000Z",
    metadata: {},
  };
}

test("conversation worker batches event posts below byte and event limits", () => {
  const events = Array.from({ length: 5 }, (_, index) => event(String(index), "x".repeat(180)));

  const batches = batchConversationEventsForPost(events, { maxBytes: 1_000, maxEvents: 3 });

  assert.equal(batches.length > 1, true);
  assert.equal(batches.flat().length, 5);
  for (const batch of batches) {
    assert.equal(batch.length <= 3, true);
    assert.equal(Buffer.byteLength(JSON.stringify({ events: batch }), "utf8") <= 1_000, true);
  }
});

test("conversation worker drops single events that cannot fit into one post", () => {
  const batches = batchConversationEventsForPost([
    event("small", "ok"),
    event("huge", "x".repeat(5_000)),
    event("small-2", "ok"),
  ], { maxBytes: 1_000, maxEvents: 10 });

  assert.deepEqual(batches.flat().map((item) => item.id), ["small", "small-2"]);
});
