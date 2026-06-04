import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

test("compose core smoke reports duplicate service environment keys", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "memory-xx-compose-smoke-"));
  const composeFile = path.join(dir, "docker-compose.yml");
  await writeFile(composeFile, `
services:
  memory-xx:
    environment:
      MEMORY_XX_RUNTIME_PROFILE: \${MEMORY_XX_RUNTIME_PROFILE:-core}
      MEMORY_XX_RUNTIME_PROFILE: core
      EMBEDDING_API_BASE: http://memory-xx-embedding-proxy:5221/v1
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      qdrant:
        condition: service_started
      memory-xx-embedding-proxy:
        condition: service_started
      memory-xx-qdrant-projector-worker:
        condition: service_started
  memory-xx-embedding-proxy:
    profiles:
      - core
  memory-xx-qdrant-projector-worker:
    profiles:
      - core
  postgres:
  redis:
  qdrant:
`, "utf8");

  const report = await buildComposeCoreSmokeReport(composeFile);

  assert.equal(report.ok, false);
  assert.deepEqual(report.duplicate_environment_keys, ["memory-xx:MEMORY_XX_RUNTIME_PROFILE"]);
  assert.equal(report.blockers.includes("duplicate_environment_key:memory-xx:MEMORY_XX_RUNTIME_PROFILE"), true);
});
