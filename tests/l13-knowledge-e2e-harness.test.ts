import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("L13 harness ingests a run-scoped Markdown fixture before validating knowledge recall", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/test-harness/layers/L13-knowledge-e2e.ts"), "utf8");

  assert.match(source, /mkdtempSync/u);
  assert.match(source, /writeFileSync/u);
  assert.match(source, /scripts\/knowledge\/ingest-directory\.ts/u);
  assert.match(source, /knowledgeCollectionId/u);
  assert.match(source, /knowledge:ingest-markdown-fixture/u);
  assert.doesNotMatch(source, /chunks >= 12_000/u);
});

test("L13 harness cleans seeded memory and knowledge fixture rows", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/test-harness/layers/L13-knowledge-e2e.ts"), "utf8");

  assert.match(source, /async function cleanup/u);
  assert.match(source, /forget-memory/u);
  assert.match(source, /metadata->>'ingest_run_id' = \$1/u);
  assert.match(source, /DELETE FROM \$\{schema\}\.chunks/u);
  assert.match(source, /DELETE FROM \$\{schema\}\.documents/u);
});

test("L13 harness verifies unified recall hybrid results expose distinguishable memory and knowledge sources", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/test-harness/layers/L13-knowledge-e2e.ts"), "utf8");

  assert.match(source, /const hybridResults = Array\.isArray\(data\.hybrid_results\)/u);
  assert.match(source, /item\.kind === "memory"/u);
  assert.match(source, /item\.kind === "knowledge"/u);
  assert.match(source, /item\.hybrid_rank_source === "memory"/u);
  assert.match(source, /item\.hybrid_rank_source === "knowledge"/u);
  assert.match(source, /unified:recall-source-disambiguation/u);
});
