import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readTimers } from "../scripts/memory-status";

test("memory status accepts fresh runtime timer evidence when systemd user bus is unavailable", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-timer-fallback-"));
  const now = new Date("2026-06-06T06:00:00.000Z");

  await writeFile(path.join(runtimeDir, "cache-invalidation-worker.status.json"), JSON.stringify({
    at: "2026-06-06T05:59:30.000Z",
    errors: [],
    claimed: 0,
    completed: 0,
    failed: 0
  }), "utf8");
  await writeFile(path.join(runtimeDir, "conversation-monitor-heartbeat.json"), JSON.stringify({
    ok: true,
    updated_at: "2026-06-06T05:59:20.000Z",
    phase: "auto_extracting",
    last_error: null
  }), "utf8");

  const probe = await readTimers({
    runtimeDir,
    now: () => now.getTime(),
    execFileSyncImpl: () => {
      throw new Error("Failed to connect to bus: No medium found");
    }
  });

  assert.equal(probe.ok, true);
  assert.equal(probe.degraded, true);
  assert.match(probe.error ?? "", /systemctl --user unavailable/u);
  assert.ok(probe.timers.some((line) => line.includes("cache-invalidation-worker.status.json")));
  assert.ok(probe.timers.some((line) => line.includes("conversation-monitor-heartbeat.json")));
});
