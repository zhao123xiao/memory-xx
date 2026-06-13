import assert from "node:assert/strict";
import test from "node:test";

import { ScopeType } from "../app";
import { buildHybridResults } from "../app/api/unified/handlers";

test("hybrid results expose explicit memory and knowledge source identities", () => {
  const hybrid = buildHybridResults([
    {
      memory_id: "memory-record-1",
      title: "Project memory",
      content: "Memory counterpart for a knowledge runbook.",
      scope: { type: ScopeType.Project, id: "project-alpha" },
      score: 0.91,
      source_retrievers: ["lexical"],
      matched_terms: ["memory", "runbook"],
    },
  ], [
    {
      chunk_id: "chunk-1",
      document_id: "doc-1",
      collection: "project:alpha:docs",
      repo: "memory-xx",
      source_path: "docs/runbook.md",
      start_line: 1,
      end_line: 4,
      content: "Knowledge runbook content.",
      score: 0.88,
    },
  ], 1, 1);

  const memory = hybrid.find((item) => item.kind === "memory");
  const knowledge = hybrid.find((item) => item.kind === "knowledge");
  const memoryItem = memory as Record<string, any> | undefined;
  const knowledgeItem = knowledge as Record<string, any> | undefined;

  assert.equal(memoryItem?.hybrid_rank_source, "memory");
  assert.equal(memoryItem?.memory_id, "memory-record-1");
  assert.deepEqual(memoryItem?.source, {
    type: "memory",
    scope: { type: ScopeType.Project, id: "project-alpha" },
  });
  assert.equal(knowledgeItem?.hybrid_rank_source, "knowledge");
  assert.equal(knowledgeItem?.source?.source_path, "docs/runbook.md");
});

test("hybrid memory budget excludes knowledge recall items returned by the orchestrator", () => {
  const hybrid = buildHybridResults([
    {
      memory_id: "memory-record-1",
      title: "Project memory",
      content: "Memory counterpart for a knowledge runbook.",
      scope: { type: ScopeType.Project, id: "project-alpha" },
      score: 0.91,
      source_retrievers: ["lexical"],
      matched_terms: ["memory", "runbook"],
    },
    {
      memory_id: "knowledge:chunk-from-orchestrator",
      title: "docs/runbook.md",
      content: "Knowledge item already included in recall results.",
      scope: { type: ScopeType.Project, id: "project-alpha" },
      score: 0.89,
      source_retrievers: ["knowledge"],
      matched_terms: ["runbook"],
      memory_type: "knowledge",
      source_type: "knowledge",
      source_path: "docs/runbook.md",
    } as any,
  ], [
    {
      chunk_id: "chunk-from-handler",
      document_id: "doc-1",
      collection: "project:alpha:docs",
      repo: "memory-xx",
      source_path: "docs/runbook.md",
      content: "Knowledge runbook content.",
      score: 0.88,
    },
  ], 2, 1);

  assert.equal(hybrid.filter((item) => item.kind === "memory").length, 1);
  assert.equal(
    hybrid.some((item) => item.kind === "memory" && item.id === "knowledge:chunk-from-orchestrator"),
    false,
  );
});
