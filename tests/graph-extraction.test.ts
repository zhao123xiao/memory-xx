import assert from "node:assert/strict";
import test from "node:test";

import { extractGraphHints } from "../app/intelligence/graph-extraction";

test("graph extraction emits canonical known relation types", () => {
  const hints = extractGraphHints("memory-xx 使用 Qdrant，并通过 graph recall 验证 relation evidence。");

  assert.ok(hints.relations.length >= 1);
  assert.ok(hints.relations.every((relation) => relation.relation_type === relation.relation_type.toLowerCase()));
  assert.ok(hints.relations.some((relation) => relation.relation_type === "uses"));
  assert.ok(hints.relations.some((relation) => relation.relation_type === "tests"));
});
