import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildMemoryDreamingSmokeReport } from "../scripts/memory-dreaming-smoke";

test("memory dreaming smoke reports task listing without wrapper dependency", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-dream-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "dream-worker.status.json"), JSON.stringify({
      worker: "memory_dreaming",
      ok: true,
      phase: "listed_tasks",
      tasks: [
        { id: "memory_stats", name: "Memory Statistics", description: "Collect health snapshot" },
        { id: "consistency_audit", name: "Consistency Audit", description: "Audit consistency" },
      ],
      at: "2026-06-04T00:00:00.000Z",
    }), "utf8");

    const report = await buildMemoryDreamingSmokeReport({
      runtimeDir,
      runListTasks: async () => undefined,
      runOnce: async () => undefined,
      mode: "list",
    });

    assert.equal(report.ok, true);
    assert.equal(report.mode, "list");
    assert.equal(report.status?.phase, "listed_tasks");
    assert.deepEqual(report.task_ids, ["memory_stats", "consistency_audit"]);
    assert.deepEqual(report.blockers, []);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("memory dreaming smoke accepts degraded once report as safe failure evidence", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-dream-smoke-degraded-test-"));
  try {
    await writeFile(path.join(runtimeDir, "dream-worker.status.json"), JSON.stringify({
      worker: "memory_dreaming",
      ok: false,
      phase: "processed_with_failures",
      report: {
        summary: { completed: 1, skipped: 0, failed: 1 },
        tasks: [
          { task_id: "memory_stats", status: "completed" },
          { task_id: "consistency_audit", status: "failed" },
        ],
      },
      at: "2026-06-04T00:00:00.000Z",
    }), "utf8");

    const report = await buildMemoryDreamingSmokeReport({
      runtimeDir,
      runListTasks: async () => undefined,
      runOnce: async () => undefined,
      mode: "once",
      allowDegraded: true,
    });

    assert.equal(report.ok, true);
    assert.equal(report.mode, "once");
    assert.equal(report.status?.phase, "processed_with_failures");
    assert.equal(report.degraded, true);
    assert.deepEqual(report.blockers, []);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
