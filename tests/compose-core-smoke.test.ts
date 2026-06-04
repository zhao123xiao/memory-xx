import assert from "node:assert/strict";
import test from "node:test";

import { buildComposeCoreSmokeReport } from "../scripts/compose-core-smoke";

test("compose core smoke validates core service topology and profile isolation", async () => {
  const report = await buildComposeCoreSmokeReport("docker-compose.yml");

  assert.equal(report.ok, true);
  assert.deepEqual([...report.required_services].sort(), [
    "memory-xx",
    "memory-xx-embedding-proxy",
    "memory-xx-qdrant-projector-worker",
    "postgres",
    "qdrant",
    "redis",
  ].sort());
  assert.deepEqual(report.missing_services, []);
  assert.deepEqual(report.wrapper_missing_depends_on, []);
  assert.deepEqual(report.profile_leaks, []);
  assert.equal(report.core_environment.MEMORY_XX_RUNTIME_PROFILE, "${MEMORY_XX_RUNTIME_PROFILE:-core}");
  assert.equal(report.core_environment.EMBEDDING_API_BASE, "http://memory-xx-embedding-proxy:5221/v1");
});
