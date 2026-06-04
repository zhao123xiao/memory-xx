import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildWriteTicketSmokeReport } from "../scripts/write-ticket-smoke";

test("write ticket smoke reports missing live configuration", async () => {
  const report = await buildWriteTicketSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
      MEMORY_XX_REDIS_URL: "",
      MEMORY_XX_QDRANT_BASE_URL: "",
      EMBEDDING_API_BASE: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, [
    "missing_env:MEMORY_XX_DATABASE_URL",
    "missing_env:MEMORY_XX_REDIS_URL",
    "missing_env:MEMORY_XX_QDRANT_BASE_URL",
    "missing_env:EMBEDDING_API_BASE",
  ]);
});

test("write ticket smoke validates worker status and completed ticket", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-write-ticket-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "write-ticket-worker.status.json"), JSON.stringify({
      worker_id: "write-ticket-smoke-test",
      ok: true,
      phase: "processed",
      claimed: 1,
      completed: 1,
      failed: 0,
      at: "2026-06-04T00:00:00.000Z",
    }), "utf8");

    const report = await buildWriteTicketSmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
        MEMORY_XX_REDIS_URL: "redis://127.0.0.1:6379/0",
        MEMORY_XX_QDRANT_BASE_URL: "http://127.0.0.1:6333",
        EMBEDDING_API_BASE: "http://127.0.0.1:5221/v1",
      },
      runtimeDir,
      seedTicket: async () => "write-ticket-smoke-ticket",
      runWorker: async () => undefined,
      readTicketStatus: async () => ({
        status: "created",
        attempts: 1,
        terminal_at: "2026-06-04T00:00:00.000Z",
        created_memory_id: "memory-smoke",
        candidate_memory_id: null,
        duplicate_of_memory_id: null,
        failure_reason: null,
      }),
    });

    assert.equal(report.ok, true);
    assert.equal(report.ticket_id, "write-ticket-smoke-ticket");
    assert.equal(report.worker_status?.completed, 1);
    assert.equal(report.ticket_status?.status, "created");
    assert.equal(report.ticket_status?.created_memory_id, "memory-smoke");
    assert.deepEqual(report.blockers, []);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
