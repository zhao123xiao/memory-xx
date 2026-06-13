import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRuntimeObservabilitySmokeReport } from "../scripts/runtime-observability-smoke";

test("runtime observability smoke reports missing live configuration", async () => {
  const report = await buildRuntimeObservabilitySmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
      MEMORY_XX_CLI_TOKEN: "",
      MEMORY_XX_ADMIN_TOKEN: "",
      MEMORY_XX_API_TOKEN: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, [
    "missing_env:MEMORY_XX_DATABASE_URL",
    "missing_env:MEMORY_XX_CLI_TOKEN_OR_MEMORY_XX_ADMIN_TOKEN",
  ]);
});

test("runtime observability smoke validates retention and artifact dry-runs", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-runtime-observability-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "runtime-observability-retention.json"), JSON.stringify({
      ok: true,
      mode: "dry_run",
      candidates: [
        { table: "runtime_component_snapshots", candidate_count: 2, retention_days: 30 },
        { table: "runtime_agent_connections", candidate_count: 0, retention_days: 30 },
      ],
      report_path: path.join(runtimeDir, "runtime-observability-retention", "report.json"),
    }), "utf8");
    await writeFile(path.join(runtimeDir, "trace-retention.json"), JSON.stringify({
      ok: true,
      apply: false,
      candidate_count: 3,
      summary: {
        total: 100,
        ordinary_delete_eligible: 3,
      },
      sample: [{ id: "trace_1", created_at: "2026-01-01T00:00:00.000Z" }],
      report_path: path.join(runtimeDir, "trace-retention", "report.json"),
    }), "utf8");
    await writeFile(path.join(runtimeDir, "runtime-artifacts-cleanup.json"), JSON.stringify({
      ok: true,
      mode: "dry_run",
      root_dir: runtimeDir,
      files: [
        { name: ".env.bak-test", kind: "env_backup", size_bytes: 12 },
      ],
      deleted: [],
      archived: [],
    }), "utf8");

    const commands: string[] = [];
    const report = await buildRuntimeObservabilitySmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
        MEMORY_XX_ADMIN_TOKEN: "admin-token",
      },
      runtimeDir,
      runCommand: async (_name, args, outputFile) => {
        commands.push(args.join(" "));
        return outputFile;
      },
      allowDegraded: true,
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.checked_capabilities, ["runtime_observability_retention"]);
    assert.equal(report.results.runtime_observability_retention?.ok, true);
    assert.equal(report.results.runtime_observability_retention?.degraded, true);
    assert.equal(report.degraded, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(commands.some((command) => command.includes("--apply")), false);
    assert.equal(commands.some((command) => command.includes("archive-next-residue-logs")), false);
    assert.equal(commands.some((command) => command.includes("rm ")), false);
    assert.equal(commands.some((command) => command.includes("rename")), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
