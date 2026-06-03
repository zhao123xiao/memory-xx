import pg from "pg";
import { config } from "../config.js";

export function createPool(schema?: string): pg.Pool {
  const url = new URL(config.dbUrl);
  const poolConfig: pg.PoolConfig = {
    host: url.hostname,
    port: parseInt(url.port || "5432"),
    database: url.pathname.slice(1),
    user: url.username,
    password: decodeURIComponent(url.password),
    max: 5,
    idleTimeoutMillis: 10000,
  };
  if (schema) {
    poolConfig.options = `-c search_path=${schema},public`;
  }
  return new pg.Pool(poolConfig);
}

export async function query(pool: pg.Pool, sql: string, params?: unknown[]): Promise<pg.QueryResult> {
  return pool.query(sql, params);
}

export async function schemaExists(pool: pg.Pool, schemaName: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
    [schemaName],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export async function createSchema(pool: pg.Pool, schemaName: string): Promise<void> {
  await pool.query(`CREATE SCHEMA "${schemaName}"`);
}

export async function dropSchema(pool: pg.Pool, schemaName: string): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
}

export async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
