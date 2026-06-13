import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCacheInvalidationSmokeReport } from "../scripts/cache-invalidation-smoke";

test("cache invalidation smoke reports missing live configuration", async () => {
  const report = await buildCacheInvalidationSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
      MEMORY_XX_REDIS_URL: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, ["missing_env:MEMORY_XX_DATABASE_URL", "missing_env:MEMORY_XX_REDIS_URL"]);
});

test("cache invalidation smoke validates worker status and completed request", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-cache-invalidation-smoke-test-"));
  try {
    const statusFile = path.join(runtimeDir, "cache-invalidation-worker.status.json");
    await writeFile(statusFile, JSON.stringify({
      worker_id: "cache-invalidation-smoke-test",
      dry_run: false,
      claimed: 1,
      completed: 1,
      failed: 0,
      errors: [],
      at: "2026-06-04T00:00:00.000Z",
    }), "utf8");

    const report = await buildCacheInvalidationSmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
        MEMORY_XX_REDIS_URL: "redis://127.0.0.1:6379/0",
      },
      runtimeDir,
      seedRequest: async () => "cache-invalidation-request-smoke",
      runWorker: async () => undefined,
      readRequestStatus: async () => ({ status: "completed", attempts: 1, completed_at: "2026-06-04T00:00:00.000Z" }),
    });

    assert.equal(report.ok, true);
    assert.equal(report.request_id, "cache-invalidation-request-smoke");
    assert.equal(report.worker_status?.completed, 1);
    assert.equal(report.request_status?.status, "completed");
    assert.deepEqual(report.blockers, []);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
