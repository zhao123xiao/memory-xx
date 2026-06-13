import assert from "node:assert/strict";
import test from "node:test";

import { buildConversationObservationSkipMetadata } from "../app/api/conversation/handlers";

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

test("assistant-only skipped conversation batches keep observer route metadata", () => {
  const result = buildConversationObservationSkipMetadata({
    source: "conversation_ingest",
    scopeType: "project",
    scopeId: "memory-xx",
    messages: [
      { role: "assistant", content: "CI 还在跑，继续等待 build-and-test。" },
    ],
    noOpReasons: ["assistant_only_ignored"],
  });
  const route = objectValue(result.metadata.conversation_memory_route);
  const reasons = Array.isArray(route.reasons) ? route.reasons : [];

  assert.deepEqual(result.noOpReasons, ["assistant_only_ignored"]);
  assert.equal(route.stage, "observer");
  assert.equal(route.storage_target, "event_log_only");
  assert.equal(route.recall_policy, "never");
  assert.equal(route.default_recall_allowed, false);
  assert.equal(reasons.includes("assistant_only_observation"), true);
});
