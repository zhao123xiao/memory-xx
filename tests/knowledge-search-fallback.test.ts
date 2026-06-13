import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKnowledgeFallbackDiagnostics,
  buildKnowledgePostgresSearchQuery,
} from "../app/knowledge/service";

test("knowledge postgres fallback searches query terms when exact phrase is too narrow", () => {
  const plan = buildKnowledgePostgresSearchQuery({
    query: "model context protocol streaming",
    limit: 5,
    collections: ["openai_docs"],
    repos: ["codex"],
    schema: "knowledge_v1",
    tenantId: "tenant-a",
  });

  assert.match(plan.sql, /content ILIKE \$1/u);
  assert.match(plan.sql, /content ILIKE \$3/u);
  assert.match(plan.sql, /content ILIKE \$4/u);
  assert.match(plan.sql, /content ILIKE \$5/u);
  assert.match(plan.sql, /content ILIKE \$6/u);
  assert.match(plan.sql, /ORDER BY exact_phrase_match DESC, term_match_count DESC, updated_at DESC/u);
  assert.deepEqual(plan.params.slice(0, 6), [
    "%model context protocol streaming%",
    5,
    "%model%",
    "%context%",
    "%protocol%",
    "%streaming%",
  ]);
  assert.equal(plan.mode, "phrase_or_terms");
});

test("knowledge postgres fallback keeps long queries broad with a minimum term threshold", () => {
  const plan = buildKnowledgePostgresSearchQuery({
    query: "how does codex configure mcp streaming timeout",
    limit: 3,
    collections: [],
    repos: [],
    schema: "knowledge_v1",
  });

  assert.match(plan.sql, /term_match_count >= 2/u);
  assert.match(plan.sql, /ORDER BY exact_phrase_match DESC, term_match_count DESC, updated_at DESC/u);
  assert.equal(plan.mode, "phrase_or_terms");
});

test("knowledge postgres fallback does not require visibility when legacy chunks schema lacks the column", () => {
  const plan = buildKnowledgePostgresSearchQuery({
    query: "l13 markdown fixture",
    limit: 3,
    collections: ["project:memory-xx:docs"],
    repos: [],
    schema: "knowledge_v1",
    availableColumns: new Set(["id", "document_id", "collection", "repo", "source_path", "content", "metadata", "updated_at"]),
  });

  assert.doesNotMatch(plan.sql, /visibility IN/u);
  assert.match(plan.sql, /collection = ANY/u);
});

test("knowledge fallback diagnostics preserve upstream failure, latency, and fallback count", () => {
  const diagnostics = buildKnowledgeFallbackDiagnostics({
    failureReason: "qdrant_timeout",
    qdrantLatencyMs: 817,
    fallbackLatencyMs: 42,
    fallbackCount: 3,
    fallbackMode: "phrase_or_terms",
  });

  assert.deepEqual(diagnostics, {
    qdrant: {
      failure_reason: "qdrant_timeout",
      latency_ms: 817,
    },
    fallback: {
      attempted: true,
      count: 3,
      latency_ms: 42,
      mode: "phrase_or_terms",
    },
  });
});
