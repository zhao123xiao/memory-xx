import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildFullOpsSmokeReport } from "../scripts/full-ops-smoke";

test("full ops smoke reports missing live configuration", async () => {
  const report = await buildFullOpsSmokeReport({
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

test("full ops smoke validates degradable maintenance and governance reports", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-full-ops-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "maintenance.json"), JSON.stringify({
      ok: true,
      mode: "report",
      steps: [
        { id: "p0_preflight", ok: true },
        { id: "doctor", ok: true },
        { id: "quality_snapshot", ok: false, degraded: true },
      ],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "auto-repair.json"), JSON.stringify({
      ok: false,
      status: "report",
      issues: [
        { id: "qdrant_projection_drift", severity: "warning", repairability: "auto_safe" },
      ],
      blocked_reasons: [],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "doctor.json"), JSON.stringify({
      ok: false,
      target: "ops-ready",
      blockers: ["quality_report_missing_or_stale"],
      warnings: [],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "quality.json"), JSON.stringify({
      ok: false,
      suite: "all",
      degraded: true,
      blockers: ["live_feedback_missing"],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "governance.json"), JSON.stringify({
      ok: true,
      mode: "dry-run",
      actions: [],
      metrics: { pending: 0 },
    }), "utf8");

    const report = await buildFullOpsSmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
        MEMORY_XX_REDIS_URL: "redis://127.0.0.1:6379/0",
        MEMORY_XX_QDRANT_BASE_URL: "http://127.0.0.1:6333",
        EMBEDDING_API_BASE: "http://127.0.0.1:5221/v1",
      },
      runtimeDir,
      runCommand: async (_name, _args, outputFile) => outputFile,
      allowDegraded: true,
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.checked_modules, [
      "maintenance_orchestrator",
      "auto_repair",
      "repair_report",
      "quality_runner",
      "governance_report",
    ]);
    assert.equal(report.results.maintenance_orchestrator?.ok, true);
    assert.equal(report.results.auto_repair?.degraded, true);
    assert.equal(report.results.repair_report?.degraded, true);
    assert.equal(report.results.quality_runner?.degraded, true);
    assert.equal(report.results.governance_report?.ok, true);
    assert.deepEqual(report.blockers, []);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
