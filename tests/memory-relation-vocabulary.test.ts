import assert from "node:assert/strict";
import test from "node:test";

import {
  isTemporalMemoryRelationType,
  normalizeMemoryRelationType,
  TEMPORAL_MEMORY_RELATION_TYPES,
} from "../app/shared";

test("temporal memory relation vocabulary covers governed memory-to-memory links", () => {
  assert.deepEqual([...TEMPORAL_MEMORY_RELATION_TYPES], [
    "supports",
    "contradicts",
    "supersedes",
    "caused_by",
    "same_issue_as",
    "derived_procedure_from",
  ]);

  assert.equal(isTemporalMemoryRelationType("supersedes"), true);
  assert.equal(isTemporalMemoryRelationType("derived_procedure_from"), true);
  assert.equal(isTemporalMemoryRelationType("depends_on"), false);
});

test("memory relation type normalization canonicalizes supported aliases", () => {
  assert.equal(normalizeMemoryRelationType("SUPERSEDED_BY"), "supersedes");
  assert.equal(normalizeMemoryRelationType("conflicts"), "contradicts");
  assert.equal(normalizeMemoryRelationType("CONFLICTS_WITH"), "contradicts");
  assert.equal(normalizeMemoryRelationType("derived_from"), "derived_procedure_from");
  assert.equal(normalizeMemoryRelationType("same_as"), "same_issue_as");
  assert.equal(normalizeMemoryRelationType("depends_on"), "depends_on");
});
