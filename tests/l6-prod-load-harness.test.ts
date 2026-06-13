import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("L6 load harness computes QPS from wall-clock elapsed time", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/test-harness/layers/L6-prod-load.ts"), "utf8");

  assert.match(source, /const loadStartedAt = Date\.now\(\)/u);
  assert.match(source, /const loadElapsedMs = Math\.max\(1, Date\.now\(\) - loadStartedAt\)/u);
  assert.match(source, /results\.length \/ loadElapsedMs \* 1000/u);
  assert.doesNotMatch(source, /const totalTime = durations\.reduce/u);
});

test("L6 load harness reports p99 improvement against an optional baseline", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/test-harness/layers/L6-prod-load.ts"), "utf8");

  assert.match(source, /MEMORY_XX_LOAD_BASELINE_P99_MS/u);
  assert.match(source, /p99_improvement_pct/u);
  assert.match(source, /load:p99-improvement/u);
});

test("L6 cleanup retries rate-limited tombstone requests with bounded retry-after backoff", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/test-harness/layers/L6-prod-load.ts"), "utf8");

  assert.match(source, /MAX_CLEANUP_TOMBSTONE_ATTEMPTS/u);
  assert.match(source, /retry_after_seconds/u);
  assert.match(source, /Retry-After/u);
  assert.match(source, /resp\.status === 429/u);
  assert.match(source, /await sleep\(/u);
});
