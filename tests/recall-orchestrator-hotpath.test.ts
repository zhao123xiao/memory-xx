import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("recall hot path applies scope policy ranking once after confidence gating", () => {
  const source = readFileSync(path.join(process.cwd(), "app/recall/orchestrator.ts"), "utf8");
  const hotPathStart = source.indexOf("const rerankOutcome = await rerankCandidatesWithOptionalModel");
  const hotPathEnd = source.indexOf("const returnedCandidates = rerankedCandidates.slice", hotPathStart);

  assert.ok(hotPathStart > 0, "rerank hot path start not found");
  assert.ok(hotPathEnd > hotPathStart, "rerank hot path end not found");

  const hotPath = source.slice(hotPathStart, hotPathEnd);
  const rankCallCount = hotPath.match(/rankCandidatesByScopePolicy\(/gu)?.length ?? 0;

  assert.equal(rankCallCount, 1);
  assert.doesNotMatch(hotPath, /policyRankedRerankCandidates/u);
});
