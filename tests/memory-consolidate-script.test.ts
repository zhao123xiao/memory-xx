import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("legacy memory-consolidate apply cannot be re-enabled by env flag", async () => {
  const source = await readFile("scripts/memory-consolidate.ts", "utf8");

  assert.doesNotMatch(source, /MEMORY_XX_ALLOW_LEGACY_DIRECT_LIFECYCLE_SQL/u);
  assert.match(source, /if \(apply\) \{/u);
  assert.match(source, /memory-consolidate apply is disabled/u);
  assert.match(source, /memory_events, outbox, projection, and cache invalidation/u);
});
