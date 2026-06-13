import assert from "node:assert/strict";
import test from "node:test";

import {
  getQdrantRuntimeSnapshot,
  recordQdrantTimeout,
  resetQdrantRuntimeSnapshot,
} from "../app/observability/qdrant-health";

test("qdrant runtime snapshot preserves first, last, and per-kind timeout timestamps", () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-06-06T01:00:00.000Z");
  Date.now = () => now;
  resetQdrantRuntimeSnapshot();

  try {
    recordQdrantTimeout("query");
    now = Date.parse("2026-06-06T01:05:00.000Z");
    recordQdrantTimeout("write");

    const snapshot = getQdrantRuntimeSnapshot({ queryTimeoutMs: 1200, writeTimeoutMs: 5000 });

    assert.equal(snapshot.query_timeouts, 1);
    assert.equal(snapshot.write_timeouts, 1);
    assert.equal(snapshot.total_timeouts, 2);
    assert.equal(snapshot.first_timeout_at, "2026-06-06T01:00:00.000Z");
    assert.equal(snapshot.last_timeout_at, "2026-06-06T01:05:00.000Z");
    assert.equal(snapshot.last_query_timeout_at, "2026-06-06T01:00:00.000Z");
    assert.equal(snapshot.last_write_timeout_at, "2026-06-06T01:05:00.000Z");
  } finally {
    Date.now = originalNow;
    resetQdrantRuntimeSnapshot();
  }
});
