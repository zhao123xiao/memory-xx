import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("cache invalidation worker script uses shared consumer implementation", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/run-cache-invalidation-worker.ts"), "utf8");

  assert.match(source, /CacheInvalidationWorker/u);
  assert.match(source, /worker\.processOnce\(\)/u);
  assert.doesNotMatch(source, /repo\.claimNext\(tx/u);
  assert.doesNotMatch(source, /repo\.markCompleted\(tx/u);
});
