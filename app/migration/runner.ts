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
}

export interface MigrationRunResult {
  readonly applied: AppliedMigration[];
  readonly skipped: readonly string[];
}

const MIGRATIONS_TABLE = "memory_xx_schema_migrations";

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
            applied_at: Date | string;
          }>(
            `
              INSERT INTO ${quoteIdentifier(MIGRATIONS_TABLE)} (
                version,
                filename,
                checksum,
                applied_at
              )
              VALUES ($1, $2, $3, NOW())
              RETURNING version, filename, checksum, applied_at
            `,
            [migration.version, migration.filename, migration.checksum]
          );

          await client.query("COMMIT");

          const row = insertResult.rows[0];
          applied.push({
            version: row.version,
            filename: row.filename,
            checksum: row.checksum,
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
        skipped
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
  const sqlFiles = files.filter((file) => file.endsWith(".sql")).sort();
  const prefixCounts = new Map<string, number>();

  for (const filename of sqlFiles) {
    const prefix = migrationPrefix(filename);
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }

  const migrations: SqlMigration[] = [];
  for (const filename of sqlFiles) {
    const filePath = path.join(migrationsDirectory, filename);
    const sql = await fs.readFile(filePath, "utf8");
    const prefix = migrationPrefix(filename);

    migrations.push({
      version: (prefixCounts.get(prefix) ?? 0) > 1 ? filename.replace(/\.sql$/u, "") : prefix,
      filename,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex")
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

async function ensureMigrationsTable(client: PoolClient, schema: string): Promise<void> {
  await ensureSchema(client, schema);
  await setSearchPath(client, schema);
  await client.query(
    `
      CREATE TABLE IF NOT EXISTS ${quoteIdentifier(MIGRATIONS_TABLE)} (
        version TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );
}
