import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("L14 data governance separates production provenance debt from test/eval debt", async () => {
  const source = await readFile("scripts/test-harness/layers/L14-data-governance.ts", "utf8");

  assert.match(source, /production_missing_source/u);
  assert.match(source, /non_production_missing_source/u);
  assert.match(source, /production_missing_identity/u);
  assert.match(source, /non_production_missing_identity/u);
  assert.match(source, /provenance:production-required-fields/u);
});

test("L14 data governance probes optional identity columns before querying provenance", async () => {
  const source = await readFile("scripts/test-harness/layers/L14-data-governance.ts", "utf8");

  assert.match(source, /readMemoryRecordColumns/u);
  assert.match(source, /hasSignatureHash/u);
  assert.match(source, /signature_hash IS NULL OR signature_hash = ''/u);
  assert.match(source, /return "FALSE"/u);
  assert.match(source, /\$\{identityMissingSql\} AS missing_identity/u);
});
