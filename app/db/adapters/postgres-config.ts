import type { PoolConfig } from "pg";

import { InvalidInputError } from "../../shared/errors/write-errors";

export interface MemoryV2PostgresConfig {
  readonly databaseUrl: string;
  readonly schema: string;
  readonly applicationName: string;
  readonly maxConnections: number;
  readonly idleTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly ssl: PoolConfig["ssl"];
}

const DEFAULT_APPLICATION_NAME = "memory-xx";
const DEFAULT_SCHEMA = "public";
const DEFAULT_MAX_CONNECTIONS = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

export function loadMemoryV2PostgresConfig(
  env: NodeJS.ProcessEnv = process.env
): MemoryV2PostgresConfig {
  const databaseUrl = env.MEMORY_V2_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new InvalidInputError("MEMORY_V2_DATABASE_URL is required for PostgreSQL execution.");
  }

  return {
    databaseUrl,
    schema: env.MEMORY_V2_DATABASE_SCHEMA?.trim() || DEFAULT_SCHEMA,
    applicationName: env.MEMORY_V2_DATABASE_APPLICATION_NAME?.trim() || DEFAULT_APPLICATION_NAME,
    maxConnections: parsePositiveInteger(
      env.MEMORY_V2_DATABASE_MAX_CONNECTIONS,
      "MEMORY_V2_DATABASE_MAX_CONNECTIONS",
      DEFAULT_MAX_CONNECTIONS
    ),
    idleTimeoutMs: parsePositiveInteger(
      env.MEMORY_V2_DATABASE_IDLE_TIMEOUT_MS,
      "MEMORY_V2_DATABASE_IDLE_TIMEOUT_MS",
      DEFAULT_IDLE_TIMEOUT_MS
    ),
    connectionTimeoutMs: parsePositiveInteger(
      env.MEMORY_V2_DATABASE_CONNECTION_TIMEOUT_MS,
      "MEMORY_V2_DATABASE_CONNECTION_TIMEOUT_MS",
      DEFAULT_CONNECTION_TIMEOUT_MS
    ),
    ssl: parseSslMode(env.MEMORY_V2_DATABASE_SSLMODE)
  };
}

export function createPostgresPoolConfig(
  config: MemoryV2PostgresConfig
): PoolConfig {
  return {
    connectionString: config.databaseUrl,
    application_name: config.applicationName,
    max: config.maxConnections,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    ssl: config.ssl
  };
}

function parsePositiveInteger(
  value: string | undefined,
  variableName: string,
  defaultValue: number
): number {
  if (!value || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidInputError(`${variableName} must be a positive integer.`, {
      variableName,
      value
    });
  }

  return parsed;
}

function parseSslMode(value: string | undefined): PoolConfig["ssl"] {
  const mode = value?.trim().toLowerCase();
  if (!mode || mode === "disable") {
    return false;
  }

  if (mode === "require") {
    return {
      rejectUnauthorized: false
    };
  }

  if (mode === "verify-ca" || mode === "verify-full") {
    return {
      rejectUnauthorized: true
    };
  }

  throw new InvalidInputError(
    "MEMORY_V2_DATABASE_SSLMODE must be one of disable, require, verify-ca, or verify-full.",
    {
      value
    }
  );
}
