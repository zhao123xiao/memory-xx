import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("L12 harness proves same-project multi-agent sharing through a third agent recall", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/test-harness/layers/L12-multi-agent-contract.ts"), "utf8");

  assert.match(source, /project-shared-\$\{runId\}/u);
  assert.match(source, /agent-a:remember-shared/u);
  assert.match(source, /agent-b:remember-shared/u);
  assert.match(source, /agent-c:reflect-shared-project/u);
  assert.match(source, /finalMemoryIds\.includes\(agentAMemoryId\)[\s\S]+finalMemoryIds\.includes\(agentBMemoryId\)/u);
});

test("L12 harness uses distinct trusted-agent bearer tokens instead of one shared wrapper token", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/test-harness/layers/L12-multi-agent-contract.ts"), "utf8");

  assert.match(source, /agentTokens/u);
  assert.match(source, /Authorization": `Bearer \$\{token\}`/u);
  assert.match(source, /registerHarnessAgent/u);
  assert.doesNotMatch(source, /const headers = \{ "Content-Type": "application\/json", "Authorization": "Bearer " \+ config\.wrapperToken \};/u);
});

test("L12 harness reports distinct token count from bearer tokens only", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/test-harness/layers/L12-multi-agent-contract.ts"), "utf8");

  assert.match(source, /const distinctTokenCount = new Set\(\[agentTokens\.agentA, agentTokens\.agentB, agentTokens\.agentC\]\)\.size/u);
  assert.doesNotMatch(source, /new Set\(Object\.values\(agentTokens\)\)\.size/u);
});

test("L12 harness keeps a cross-project isolation probe in the contract", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/test-harness/layers/L12-multi-agent-contract.ts"), "utf8");

  assert.match(source, /project-isolated-\$\{runId\}/u);
  assert.match(source, /agent-c:reflect-isolated-project/u);
  assert.match(source, /!isolatedMemoryIds\.includes\(agentBMemoryId\)/u);
});
