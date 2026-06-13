import assert from "node:assert/strict";
import test from "node:test";

import { resolveConflict } from "../app/consolidation/conflict-resolver";
import { groupIntoEpisodes } from "../app/consolidation/episode-builder";
import { mergeContents } from "../app/consolidation/merge-engine";
import { runConsolidation } from "../app/consolidation/worker";
import {
  clearQueueForTest,
  dequeue,
  enqueue,
  queueSize,
  setMaxQueueSizeForTest,
} from "../app/coordination/consolidation-queue";

test("episode grouping never mixes records across scopes", () => {
  const groups = groupIntoEpisodes([
    {
      id: "project-a-1",
      content: "project A event one",
      created_at: "2026-06-06T08:00:00.000Z",
      scope_type: "project",
      scope_id: "a",
    },
    {
      id: "project-b-1",
      content: "project B event one",
      created_at: "2026-06-06T08:10:00.000Z",
      scope_type: "project",
      scope_id: "b",
    },
    {
      id: "project-a-2",
      content: "project A event two",
      created_at: "2026-06-06T08:20:00.000Z",
      scope_type: "project",
      scope_id: "a",
    },
    {
      id: "project-b-2",
      content: "project B event two",
      created_at: "2026-06-06T08:30:00.000Z",
      scope_type: "project",
      scope_id: "b",
    },
  ], 1);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.scope_key).sort(),
    ["project:a", "project:b"]
  );
  for (const group of groups) {
    assert.equal(new Set(group.records.map((record) => `${record.scope_type}:${record.scope_id}`)).size, 1);
  }
});

test("consolidation queue enforces capacity and preserves FIFO order", () => {
  clearQueueForTest();
  setMaxQueueSizeForTest(2);
  try {
    const first = enqueue({ type: "dedupe", payload: { order: 1 } });
    const second = enqueue({ type: "conflict", payload: { order: 2 } });
    assert.throws(
      () => enqueue({ type: "episode", payload: { order: 3 } }),
      /consolidation_queue_full/
    );
    assert.equal(queueSize(), 2);
    assert.equal(dequeue()?.id, first);
    assert.equal(dequeue()?.id, second);
    assert.equal(dequeue(), null);
  } finally {
    setMaxQueueSizeForTest(null);
    clearQueueForTest();
  }
});

test("merge engine consolidates overlapping content into structured unique facts", () => {
  const result = mergeContents({
    memory_ids: ["m-1", "m-2"],
    scope_type: "project",
    scope_id: "memory-xx",
    contents: [
      "memory-xx uses Qdrant for vector projection. HTTP transport is the supported MCP test path.",
      "HTTP transport is the supported MCP test path.\n- stdio exits when stdin closes"
    ]
  });

  assert.match(result.merged_content, /^Consolidated memory \(project:memory-xx\)\n\nKey points:\n/u);
  assert.equal(result.merged_content.includes("---"), false);
  assert.equal(
    (result.merged_content.match(/HTTP transport is the supported MCP test path/g) ?? []).length,
    1
  );
  assert.match(result.merged_content, /- memory-xx uses Qdrant for vector projection\./u);
  assert.match(result.merged_content, /- stdio exits when stdin closes/u);
  assert.deepEqual(result.source_ids, ["m-1", "m-2"]);
});

test("conflict resolver prefers current valid facts over invalidated contradicted facts", () => {
  const resolved = resolveConflict({
    id_a: "old-high-importance",
    content_a: "memory-xx stdio is the preferred MCP test path.",
    importance_a: 10,
    created_at_a: "2026-06-01T00:00:00.000Z",
    relation_type_a_to_b: "contradicts",
    fact_status_a: "historical",
    invalid_at_a: "2026-06-05T00:00:00.000Z",
    id_b: "new-current",
    content_b: "memory-xx HTTP transport is the preferred MCP test path.",
    importance_b: 4,
    created_at_b: "2026-06-05T00:00:00.000Z",
    fact_status_b: "current",
    valid_at_b: "2026-06-05T00:00:00.000Z"
  });

  assert.deepEqual(resolved, {
    winner_id: "new-current",
    loser_id: "old-high-importance",
    reason: "current valid fact supersedes contradicted invalidated fact"
  });
});

test("consolidation worker runs mutating stages inside a job transaction hook", async () => {
  const events: string[] = [];
  const result = await runConsolidation({
    runInJobTransaction: async (work) => {
      events.push("tx:start");
      try {
        return await work();
      } finally {
        events.push("tx:end");
      }
    },
    findDuplicates: async () => [{ dedupe_key: "dup-1", memory_ids: ["m1", "m2"], scope_type: "project", scope_id: "memory-xx" }],
    mergeDuplicates: async () => {
      events.push("merge");
      return "merged-memory";
    },
    findConflicts: async () => [{ memory_id_a: "m1", memory_id_b: "m3", relation_type: "contradicts" }],
    resolveConflict: async () => {
      events.push("conflict");
      return "m3";
    },
    buildEpisodes: async () => {
      events.push("episode");
      return 1;
    }
  });

  assert.equal(result.errors.length, 0);
  assert.deepEqual(events, ["tx:start", "merge", "conflict", "episode", "tx:end"]);
});

test("consolidation worker records compensation evidence when a transactional job fails", async () => {
  const compensations: string[] = [];
  const result = await runConsolidation({
    runInJobTransaction: async (work) => work(),
    recordCompensation: async (entry) => {
      compensations.push(`${entry.stage}:${entry.reason}`);
    },
    findDuplicates: async () => [{ dedupe_key: "dup-2", memory_ids: ["m1", "m2"], scope_type: "project", scope_id: "memory-xx" }],
    mergeDuplicates: async () => {
      throw new Error("merge write failed");
    },
    findConflicts: async () => [],
    resolveConflict: async () => null,
    buildEpisodes: async () => 0
  });

  assert.match(result.errors.join(","), /dedupe:dup-2: merge write failed/u);
  assert.deepEqual(compensations, ["dedupe:merge write failed"]);
});
