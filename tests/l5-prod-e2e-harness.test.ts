import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("L5 production E2E writes a deterministic Qdrant fallback embedding", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/test-harness/layers/L5-prod-e2e.ts"), "utf8");

  assert.match(source, /function makeTestEmbedding/u);
  assert.match(source, /process\.env\.EMBEDDING_DIMS/u);
  assert.match(source, /metadata:\s*\{[\s\S]*embedding:\s*makeTestEmbedding\(\)/u);
});
