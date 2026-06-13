import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildQdrantReconciliationSmokeReport } from "../scripts/qdrant-reconciliation-smoke";

test("qdrant reconciliation smoke reports missing live configuration", async () => {
  const report = await buildQdrantReconciliationSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
      MEMORY_XX_QDRANT_BASE_URL: "",
      EMBEDDING_API_BASE: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, [
    "missing_env:MEMORY_XX_DATABASE_URL",
    "missing_env:MEMORY_XX_QDRANT_BASE_URL",
    "missing_env:EMBEDDING_API_BASE",
  ]);
});

test("qdrant reconciliation smoke validates report-only projection repair surfaces", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-qdrant-reconciliation-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "qdrant-reconcile.json"), JSON.stringify({
      ok: false,
      action: "qdrant_projection_reconcile",
      diff: { missing: 2, stale: 0, payload_drift: 1, orphan: 0 },
      issues: [{ id: "qdrant_projection_drift", severity: "warning" }],
      note: "Report-only. Re-run with --apply to delete stale points and upsert missing/drifted approved memories.",
    }), "utf8");
    await writeFile(path.join(runtimeDir, "outbox-recovery.json"), JSON.stringify({
      ok: true,
      mode: "scan",
      counts: { pending: 1, failed: 0 },
    }), "utf8");
    await writeFile(path.join(runtimeDir, "qdrant-collection-audit.json"), JSON.stringify({
      ok: true,
      collections: [
        { name: "memory-xx", role: "active", reason: "matches_active_collection" },
      ],
      counts: { active: 1 },
    }), "utf8");
    await writeFile(path.join(runtimeDir, "qdrant-alias.json"), JSON.stringify({
      ok: true,
      qdrant_base: "http://127.0.0.1:6333",
      aliases: [{ alias_name: "memory-xx-active", collection_name: "memory-xx" }],
    }), "utf8");

    const commands: string[] = [];
    const report = await buildQdrantReconciliationSmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
        MEMORY_XX_QDRANT_BASE_URL: "http://127.0.0.1:6333",
        EMBEDDING_API_BASE: "http://127.0.0.1:5221/v1",
      },
      runtimeDir,
      runCommand: async (_name, args, outputFile) => {
        commands.push(args.join(" "));
        return outputFile;
      },
      allowDegraded: true,
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.checked_capabilities, ["qdrant_reconciliation"]);
    assert.equal(report.results.qdrant_reconciliation?.ok, false);
    assert.equal(report.results.qdrant_reconciliation?.degraded, true);
    assert.equal(report.degraded, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(commands.some((command) => command.includes("--apply")), false);
    assert.equal(commands.some((command) => command.includes("--mark-dispatched")), false);
    assert.equal(commands.some((command) => command.includes("replay-qdrant-outbox.ts")), false);
    assert.equal(commands.some((command) => command.includes("fix-qdrant-replay.ts")), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
