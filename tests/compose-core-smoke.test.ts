import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildComposeCoreSmokeReport, buildComposeProfileLiveSmokeReport } from "../scripts/compose-core-smoke";

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

test("compose profile live smoke fails on unhealthy or crashed profile containers", async () => {
  const report = await buildComposeProfileLiveSmokeReport({
    composePsJsonLines: [
      JSON.stringify({ Service: "memory-xx", State: "running", Health: "healthy", ExitCode: 0 }),
      JSON.stringify({ Service: "postgres", State: "running", Health: "healthy", ExitCode: 0 }),
      JSON.stringify({ Service: "redis", State: "running", Health: "healthy", ExitCode: 0 }),
      JSON.stringify({ Service: "qdrant", State: "running", Health: "", ExitCode: 0 }),
      JSON.stringify({ Service: "memory-xx-embedding-proxy", State: "running", Health: "healthy", ExitCode: 0 }),
      JSON.stringify({ Service: "memory-xx-qdrant-projector-worker", State: "running", Health: "", ExitCode: 0 }),
      JSON.stringify({ Service: "memory-xx-fastpath", State: "exited", Health: "", ExitCode: 0 }),
      JSON.stringify({ Service: "memory-xx-lexical-sidecar", State: "exited", Health: "", ExitCode: 1 }),
    ],
    healthPayload: {
      runtime_profile: "enhanced",
      runtime_modules: {
        mode: "enhanced",
        states: {
          wrapper: { blocks_profile: false },
          postgres: { blocks_profile: false },
          redis: { blocks_profile: false },
          qdrant: { blocks_profile: false },
          embedding_proxy: { blocks_profile: false },
          projector: { blocks_profile: false },
        },
      },
      full_stack_capabilities: { states: {} },
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.missing_services, []);
  assert.deepEqual(report.unhealthy_services, []);
  assert.deepEqual(report.exited_nonzero_services, ["memory-xx-lexical-sidecar:1"]);
  assert.equal(report.blockers.includes("exited_nonzero_service:memory-xx-lexical-sidecar:1"), true);
});

test("compose profile live smoke accepts disabled profile containers that exit cleanly", async () => {
  const report = await buildComposeProfileLiveSmokeReport({
    composePsJsonLines: [
      JSON.stringify({ Service: "memory-xx", State: "running", Health: "healthy", ExitCode: 0 }),
      JSON.stringify({ Service: "postgres", State: "running", Health: "healthy", ExitCode: 0 }),
      JSON.stringify({ Service: "redis", State: "running", Health: "healthy", ExitCode: 0 }),
      JSON.stringify({ Service: "qdrant", State: "running", Health: "", ExitCode: 0 }),
      JSON.stringify({ Service: "memory-xx-embedding-proxy", State: "running", Health: "healthy", ExitCode: 0 }),
      JSON.stringify({ Service: "memory-xx-qdrant-projector-worker", State: "running", Health: "", ExitCode: 0 }),
      JSON.stringify({ Service: "memory-xx-fastpath", State: "exited", Health: "", ExitCode: 0 }),
    ],
    healthPayload: {
      runtime_profile: "enhanced",
      runtime_modules: {
        mode: "enhanced",
        states: {
          wrapper: { blocks_profile: false },
          postgres: { blocks_profile: false },
          redis: { blocks_profile: false },
          qdrant: { blocks_profile: false },
          embedding_proxy: { blocks_profile: false },
          projector: { blocks_profile: false },
        },
      },
      full_stack_capabilities: { states: {} },
    },
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.exited_zero_services, ["memory-xx-fastpath"]);
  assert.deepEqual(report.blocking_runtime_modules, []);
});

test("compose profile live smoke requires enabled runtime service containers to be running", async () => {
  const report = await buildComposeProfileLiveSmokeReport({
    composePsJsonLines: [
      JSON.stringify({ Service: "memory-xx", State: "running", Health: "healthy", ExitCode: 0 }),
      JSON.stringify({ Service: "postgres", State: "running", Health: "healthy", ExitCode: 0 }),
      JSON.stringify({ Service: "redis", State: "running", Health: "healthy", ExitCode: 0 }),
      JSON.stringify({ Service: "qdrant", State: "running", Health: "", ExitCode: 0 }),
      JSON.stringify({ Service: "memory-xx-embedding-proxy", State: "running", Health: "healthy", ExitCode: 0 }),
      JSON.stringify({ Service: "memory-xx-qdrant-projector-worker", State: "running", Health: "", ExitCode: 0 }),
    ],
    healthPayload: {
      runtime_profile: "enhanced",
      runtime_modules: {
        mode: "enhanced",
        states: {
          wrapper: { state: "enabled", blocks_profile: false, service: "memory-xx-wrapper.service" },
          postgres: { state: "enabled", blocks_profile: false },
          redis: { state: "enabled", blocks_profile: false },
          qdrant: { state: "enabled", blocks_profile: false },
          embedding_proxy: { state: "enabled", blocks_profile: false, service: "memory-xx-embedding-proxy.service" },
          projector: { state: "enabled", blocks_profile: false, service: "memory-xx-qdrant-projector-worker.service" },
          fastpath: { state: "enabled", blocks_profile: false, service: "memory-xx-fastpath.service" },
        },
      },
      full_stack_capabilities: { states: {} },
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.missing_enabled_services, ["fastpath:memory-xx-fastpath"]);
  assert.equal(report.blockers.includes("missing_enabled_service:fastpath:memory-xx-fastpath"), true);
});

test("compose profile live smoke retries transient Docker health starting state", async () => {
  let attempts = 0;
  const report = await buildComposeProfileLiveSmokeReport({
    waitMs: 50,
    pollIntervalMs: 1,
    composePsJsonLines: async () => {
      attempts += 1;
      const health = attempts === 1 ? "starting" : "healthy";
      return [
        JSON.stringify({ Service: "memory-xx", State: "running", Health: health, ExitCode: 0 }),
        JSON.stringify({ Service: "postgres", State: "running", Health: "healthy", ExitCode: 0 }),
        JSON.stringify({ Service: "redis", State: "running", Health: "healthy", ExitCode: 0 }),
        JSON.stringify({ Service: "qdrant", State: "running", Health: "", ExitCode: 0 }),
        JSON.stringify({ Service: "memory-xx-embedding-proxy", State: "running", Health: "healthy", ExitCode: 0 }),
        JSON.stringify({ Service: "memory-xx-qdrant-projector-worker", State: "running", Health: "", ExitCode: 0 }),
      ];
    },
    healthPayload: {
      runtime_profile: "enhanced",
      runtime_modules: {
        mode: "enhanced",
        states: {
          wrapper: { blocks_profile: false },
          postgres: { blocks_profile: false },
          redis: { blocks_profile: false },
          qdrant: { blocks_profile: false },
          embedding_proxy: { blocks_profile: false },
          projector: { blocks_profile: false },
        },
      },
      full_stack_capabilities: { states: {} },
    },
  });

  assert.equal(report.ok, true);
  assert.equal(attempts, 2);
});
