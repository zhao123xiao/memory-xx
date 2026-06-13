import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildBackupOpsSmokeReport } from "../scripts/backup-ops-smoke";

test("backup ops smoke reports missing live configuration", async () => {
  const report = await buildBackupOpsSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, [
    "missing_env:MEMORY_XX_DATABASE_URL",
    "missing_env:MEMORY_XX_CLI_TOKEN_OR_MEMORY_XX_ADMIN_TOKEN",
  ]);
});

test("backup ops smoke reports missing CLI admin token", async () => {
  const report = await buildBackupOpsSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
      MEMORY_XX_CLI_TOKEN: "",
      MEMORY_XX_ADMIN_TOKEN: "",
      MEMORY_XX_API_TOKEN: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, ["missing_env:MEMORY_XX_CLI_TOKEN_OR_MEMORY_XX_ADMIN_TOKEN"]);
});

test("backup ops smoke validates dry-run backup, migration, bundle, and secrets audit surfaces", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-backup-ops-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "memory-backup.json"), JSON.stringify({
      ok: true,
      mode: "dry_run",
      backup_dir: path.join(runtimeDir, "backup"),
      items: ["Postgres schema dump", "Qdrant alias and active collection metadata"],
      next: "rerun with --apply",
    }), "utf8");
    await writeFile(path.join(runtimeDir, "migration-preflight.json"), JSON.stringify({
      ok: false,
      status: "degraded",
      profile: "docker-compose-local",
      blockers: ["postgres:not_reachable"],
      warnings: ["qdrant:not_checked"],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "deployment-bundle.json"), JSON.stringify({
      ok: true,
      profile: "docker-compose-local",
      output: path.join(runtimeDir, "deployment-bundle"),
      includes_live_secrets: false,
      preflight_status: "degraded",
    }), "utf8");
    await writeFile(path.join(runtimeDir, "secrets-audit.json"), JSON.stringify({
      ok: true,
      blocker_count: 0,
      findings: [],
    }), "utf8");

    const commands: string[] = [];
    const report = await buildBackupOpsSmokeReport({
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
    assert.deepEqual(report.checked_capabilities, [
      "backup_and_restore",
      "deployment_packaging",
    ]);
    assert.equal(report.results.backup_and_restore?.ok, true);
    assert.equal(report.results.backup_and_restore?.degraded, false);
    assert.equal(report.results.deployment_packaging?.ok, false);
    assert.equal(report.results.deployment_packaging?.degraded, true);
    assert.equal(report.degraded, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(commands.some((command) => command.includes("--apply")), false);
    assert.equal(commands.some((command) => command.includes("pg_dump")), false);
    assert.equal(commands.some((command) => command.includes("rollback")), false);
    assert.equal(commands.some((command) => command.includes("memory-governance-revert")), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
