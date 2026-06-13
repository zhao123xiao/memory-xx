import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadSqlMigrations } from "../app/migration/runner";

test("loadSqlMigrations attaches rollback companions without treating down files as forward migrations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "memory-xx-migrations-"));

  try {
    await writeFile(path.join(directory, "0001_create_widget.sql"), "CREATE TABLE widget (id TEXT PRIMARY KEY);\n");
    await writeFile(path.join(directory, "0001_create_widget.down.sql"), "DROP TABLE widget;\n");
    await writeFile(path.join(directory, "0002_add_widget_name.sql"), "ALTER TABLE widget ADD COLUMN name TEXT;\n");

    const migrations = await loadSqlMigrations(directory);

    assert.deepEqual(
      migrations.map((migration) => migration.filename),
      ["0001_create_widget.sql", "0002_add_widget_name.sql"]
    );
    assert.equal(migrations[0]?.rollbackFilename, "0001_create_widget.down.sql");
    assert.equal(migrations[0]?.rollbackSql, "DROP TABLE widget;\n");
    assert.match(migrations[0]?.rollbackChecksum ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(migrations[0]?.rollbackAvailable, true);
    assert.equal(migrations[1]?.rollbackFilename, undefined);
    assert.equal(migrations[1]?.rollbackAvailable, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("governance lease conflict target has a matching partial unique index migration", () => {
  const repository = readFileSync(
    path.join(process.cwd(), "app/db/repositories/governance-repository.ts"),
    "utf8"
  );
  const migrations = readdirSync(path.join(process.cwd(), "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .map((file) => readFileSync(path.join(process.cwd(), "migrations", file), "utf8"))
    .join("\n");

  assert.match(repository, /ON CONFLICT \(job_type\) WHERE lease_acquired_by IS NOT NULL/u);
  assert.match(
    migrations,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_governance_runs_active_lease\s+ON memory_governance_runs \(job_type\)\s+WHERE lease_acquired_by IS NOT NULL;/u
  );
});

test("governance running jobs have a status-based unique index migration", () => {
  const migrations = readdirSync(path.join(process.cwd(), "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .map((file) => readFileSync(path.join(process.cwd(), "migrations", file), "utf8"))
    .join("\n");

  assert.match(
    migrations,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_governance_runs_active_job\s+ON memory_governance_runs \(job_type\)\s+WHERE status = 'running';/u
  );
});
