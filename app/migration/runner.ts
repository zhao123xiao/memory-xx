import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { Pool, type PoolClient } from "pg";

import {
  type MemoryXXPostgresConfig,
  createPostgresPoolConfig
} from "../db/adapters/postgres-config";
import {
  ensureSchema,
  quoteIdentifier,
  setSearchPath
} from "../db/adapters/postgres-write-database";

export interface SqlMigration {
  readonly version: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
  readonly rollbackAvailable: boolean;
  readonly rollbackFilename?: string;
  readonly rollbackSql?: string;
  readonly rollbackChecksum?: string;
}

export interface RunMigrationsOptions {
  readonly config: MemoryXXPostgresConfig;
  readonly migrationsDirectory?: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly filename: string;
  readonly checksum: string;
  readonly appliedAt: string;
  readonly rollbackAvailable: boolean;
  readonly rollbackFilename?: string;
  readonly rollbackChecksum?: string;
}

export interface MigrationRunResult {
  readonly applied: AppliedMigration[];
  readonly skipped: readonly string[];
  readonly rollbackMissing: readonly string[];
}

const MIGRATIONS_TABLE = "memory_v2_schema_migrations";

export async function runPostgresMigrations(
  options: RunMigrationsOptions
): Promise<MigrationRunResult> {
  const pool = new Pool(createPostgresPoolConfig(options.config));

  try {
    const migrations = await loadSqlMigrations(options.migrationsDirectory);
    const client = await pool.connect();

    try {
      await ensureSchema(client, options.config.schema);
      await setSearchPath(client, options.config.schema);
      await ensureMigrationsTable(client, options.config.schema);

      const existing = await client.query<{ version: string }>(
        `SELECT version FROM ${quoteIdentifier(MIGRATIONS_TABLE)} ORDER BY version ASC`
      );
      const appliedVersions = new Set(existing.rows.map((row) => row.version));
      const applied: AppliedMigration[] = [];
      const skipped: string[] = [];

      for (const migration of migrations) {
        if (appliedVersions.has(migration.version)) {
          skipped.push(migration.filename);
          continue;
        }

        await client.query("BEGIN");
        await setSearchPath(client, options.config.schema);

        try {
          await client.query(migration.sql);
          const insertResult = await client.query<{
            version: string;
            filename: string;
            checksum: string;
            rollback_available: boolean;
            rollback_filename: string | null;
            rollback_checksum: string | null;
            applied_at: Date | string;
          }>(
            `
              INSERT INTO ${quoteIdentifier(MIGRATIONS_TABLE)} (
                version,
                filename,
                checksum,
                rollback_available,
                rollback_filename,
                rollback_checksum,
                applied_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, NOW())
              RETURNING
                version,
                filename,
                checksum,
                rollback_available,
                rollback_filename,
                rollback_checksum,
                applied_at
            `,
            [
              migration.version,
              migration.filename,
              migration.checksum,
              migration.rollbackAvailable,
              migration.rollbackFilename ?? null,
              migration.rollbackChecksum ?? null
            ]
          );

          await client.query("COMMIT");

          const row = insertResult.rows[0];
          applied.push({
            version: row.version,
            filename: row.filename,
            checksum: row.checksum,
            rollbackAvailable: row.rollback_available,
            ...(row.rollback_filename ? { rollbackFilename: row.rollback_filename } : {}),
            ...(row.rollback_checksum ? { rollbackChecksum: row.rollback_checksum } : {}),
            appliedAt:
              row.applied_at instanceof Date
                ? row.applied_at.toISOString()
                : new Date(row.applied_at).toISOString()
          });
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }

      return {
        applied,
        skipped,
        rollbackMissing: migrations
          .filter((migration) => !migration.rollbackAvailable)
          .map((migration) => migration.filename)
      };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function loadSqlMigrations(
  migrationsDirectory = path.resolve(process.cwd(), "migrations")
): Promise<SqlMigration[]> {
  const files = await fs.readdir(migrationsDirectory);
  const forwardSqlFiles = files
    .filter((file) => file.endsWith(".sql") && !isRollbackMigration(filenameBase(file)))
    .sort();
  const rollbackFiles = new Map(
    files
      .filter((file) => file.endsWith(".down.sql"))
      .map((file) => [file.replace(/\.down\.sql$/u, ".sql"), file] as const)
  );
  const prefixCounts = new Map<string, number>();

  for (const filename of forwardSqlFiles) {
    const prefix = migrationPrefix(filename);
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }

  const migrations: SqlMigration[] = [];
  for (const filename of forwardSqlFiles) {
    const filePath = path.join(migrationsDirectory, filename);
    const sql = await fs.readFile(filePath, "utf8");
    const prefix = migrationPrefix(filename);
    const rollbackFilename = rollbackFiles.get(filename);
    const rollbackSql = rollbackFilename
      ? await fs.readFile(path.join(migrationsDirectory, rollbackFilename), "utf8")
      : undefined;

    migrations.push({
      version: (prefixCounts.get(prefix) ?? 0) > 1 ? filename.replace(/\.sql$/u, "") : prefix,
      filename,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
      rollbackAvailable: Boolean(rollbackFilename),
      ...(rollbackFilename ? { rollbackFilename } : {}),
      ...(rollbackSql !== undefined ? { rollbackSql } : {}),
      ...(rollbackSql !== undefined
        ? { rollbackChecksum: createHash("sha256").update(rollbackSql).digest("hex") }
        : {})
    });
  }

  return migrations;
}

function migrationPrefix(filename: string): string {
  const separatorIndex = filename.indexOf("_");
  return separatorIndex === -1
    ? filename.replace(/\.sql$/u, "")
    : filename.slice(0, separatorIndex);
}

function filenameBase(filename: string): string {
  return filename.replace(/\.sql$/u, "");
}

function isRollbackMigration(filenameWithoutSqlExtension: string): boolean {
  return filenameWithoutSqlExtension.endsWith(".down");
}

async function ensureMigrationsTable(client: PoolClient, schema: string): Promise<void> {
  await ensureSchema(client, schema);
  await setSearchPath(client, schema);
  await client.query(
    `
      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(MIGRATIONS_TABLE)} (
        version TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        checksum TEXT NOT NULL,
        rollback_available BOOLEAN NOT NULL DEFAULT FALSE,
        rollback_filename TEXT,
        rollback_checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );
  await client.query(
    `ALTER TABLE ${quoteIdentifier(MIGRATIONS_TABLE)}
       ADD COLUMN IF NOT EXISTS rollback_available BOOLEAN NOT NULL DEFAULT FALSE`
  );
  await client.query(
    `ALTER TABLE ${quoteIdentifier(MIGRATIONS_TABLE)}
       ADD COLUMN IF NOT EXISTS rollback_filename TEXT`
  );
  await client.query(
    `ALTER TABLE ${quoteIdentifier(MIGRATIONS_TABLE)}
       ADD COLUMN IF NOT EXISTS rollback_checksum TEXT`
  );
}
