import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildConversationMonitorSmokeReport } from "../scripts/conversation-monitor-smoke";

test("conversation monitor smoke reports missing live configuration", async () => {
  const report = await buildConversationMonitorSmokeReport({
    env: {
      MEMORY_XX_WRAPPER_URL: "",
      MEMORY_XX_DATABASE_URL: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, ["missing_env:MEMORY_XX_WRAPPER_URL", "missing_env:MEMORY_XX_DATABASE_URL"]);
});

test("conversation monitor smoke validates heartbeat and stored conversation event", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-conversation-monitor-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "conversation-monitor-heartbeat.json"), JSON.stringify({
      ok: true,
      phase: "monitoring",
      posted_events: 1,
      flushed_sessions: 0,
      updated_at: "2026-06-04T00:00:00.000Z",
    }), "utf8");

    const report = await buildConversationMonitorSmokeReport({
      env: {
        MEMORY_XX_WRAPPER_URL: "http://127.0.0.1:5100",
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
      },
      runtimeDir,
      runWorker: async () => undefined,
      countEvents: async () => 1,
      now: () => new Date("2026-06-04T00:00:10.000Z"),
    });

    assert.equal(report.ok, true);
    assert.equal(report.heartbeat?.phase, "monitoring");
    assert.equal(report.event_count, 1);
    assert.deepEqual(report.blockers, []);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
