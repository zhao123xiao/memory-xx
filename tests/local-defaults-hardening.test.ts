import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const productionScripts = [
  "app/ops/conversation-monitor-worker.service.example",
  "scripts/archive-next-residue-logs.ts",
  "scripts/fix-qdrant-replay.ts",
  "scripts/functional-test-memory-xx.sh",
  "scripts/memory-backup.ts",
  "scripts/embedding-manifest.ts",
  "scripts/test-mem0-extraction-benchmark.ts",
  "scripts/random-recall-sample.ts",
  "scripts/test-harness/layers/L3-observation-gates.ts",
  "scripts/test-harness/layers/L18-graph-recall.ts",
];

test("production script defaults do not depend on the local developer path or scope", () => {
  for (const relativePath of productionScripts) {
    const source = readFileSync(path.join(process.cwd(), relativePath), "utf8");
    assert.doesNotMatch(source, /\/home\/xiaoxiao\/services\/memory-xx/u, relativePath);
    assert.doesNotMatch(source, /"xiaoxiao-default"/u, relativePath);
  }
});
