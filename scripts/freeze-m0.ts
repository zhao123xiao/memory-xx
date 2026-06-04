import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { createClient } from "redis";

function readEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(filePath)) return env;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return env;
}

function redact(value: string, key: string): string {
  if (/token|password|secret|key/i.test(key)) return value ? "<redacted>" : "";
  if (value.includes("@")) return value.replace(/:\/\/[^@]+@/, "://<redacted>@");
  return value;
}

function runText(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, [...args], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return `ERROR: ${error instanceof Error ? error.message : String(error)}\n`;
  }
}

async function queryPg(databaseUrl: string, schema: string): Promise<Record<string, unknown>> {
  if (!databaseUrl) return { available: false, error: "MEMORY_XX_DATABASE_URL not configured" };
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await pool.query(`SET search_path TO ${quoteIdent(schema)}, public`);
    const counts = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM memory_records) AS memory_records,
        (SELECT count(*)::int FROM outbox_events) AS outbox_events,
        (SELECT count(*)::int FROM outbox_events WHERE dispatch_status != 'dispatched') AS outbox_pending,
        (SELECT count(*)::int FROM recall_traces) AS recall_traces,
        (SELECT count(*)::int FROM recall_feedback_events) AS recall_feedback_events,
        (SELECT pg_database_size(current_database())::bigint) AS database_size_bytes
    `);
    const growth = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM outbox_events WHERE created_at >= now() - interval '24 hours') AS outbox_events_24h,
        (SELECT count(*)::int FROM recall_traces WHERE created_at >= now() - interval '24 hours') AS recall_traces_24h,
        (SELECT count(*)::int FROM recall_feedback_events WHERE created_at >= now() - interval '24 hours') AS recall_feedback_events_24h
    `);
    return {
      available: true,
      schema,
      counts: counts.rows[0] ?? {},
      growth_24h: growth.rows[0] ?? {},
    };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await pool.end();
  }
}

async function queryQdrant(baseUrl: string, collection: string, apiKey?: string): Promise<Record<string, unknown>> {
  if (!baseUrl || !collection) return { available: false, error: "Qdrant base URL or collection not configured" };
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/collections/${encodeURIComponent(collection)}`, {
      headers: apiKey ? { "api-key": apiKey } : undefined,
    });
    const json = await response.json().catch(() => null);
    return { available: response.ok, status: response.status, collection, response: json };
  } catch (error) {
    return { available: false, collection, error: error instanceof Error ? error.message : String(error) };
  }
}

async function queryRedis(url: string): Promise<Record<string, unknown>> {
  if (!url) return { available: false, error: "MEMORY_XX_REDIS_URL not configured" };
  const client = createClient({ url });
  try {
    await client.connect();
    const info = await client.info("memory");
    const dbSize = await client.dbSize();
    const usedMemory = /used_memory:(\d+)/.exec(info)?.[1] ?? null;
    return { available: true, keys: dbSize, used_memory_bytes: usedMemory ? Number(usedMemory) : null };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

async function main(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const outputDir = join(process.cwd(), "artifacts", "m0-freeze", date);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });

  const envPath = process.env.MEMORY_XX_ENV_PATH || join(process.cwd(), ".env");
  const fileEnv = readEnvFile(envPath);
  const mergedEnv = { ...fileEnv, ...process.env } as Record<string, string>;
  const schema = mergedEnv.MEMORY_XX_DATABASE_SCHEMA || "memory_xx";
  const databaseUrl = mergedEnv.MEMORY_XX_DATABASE_URL || "";

  const redactedEnv = Object.fromEntries(
    Object.entries(mergedEnv)
      .filter(([key]) => key.startsWith("MEMORY_XX_") || key.startsWith("OPENCLAW_") || key === "OPENAI_API_KEY")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, redact(String(value ?? ""), key)])
  );

  writeFileSync(join(outputDir, "redacted-env.json"), JSON.stringify(redactedEnv, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(outputDir, "status.md"), [
    "# M0 Freeze Status",
    "",
    `- captured_at: ${new Date().toISOString()}`,
    `- cwd: ${process.cwd()}`,
    `- env_path: ${envPath}`,
    "",
    "## Git Status",
    "",
    "```",
    runText("git", ["status", "--short", "--", "."]).trimEnd(),
    "```",
    "",
    "## User Systemd Units",
    "",
    "```",
    runText("systemctl", ["--user", "list-units", "--type=service", "--no-pager"]).trimEnd(),
    "```",
  ].join("\n") + "\n", { mode: 0o600 });

  const schemaDump = databaseUrl
    ? runText("pg_dump", ["--schema-only", "--no-owner", "--no-privileges", `--schema=${schema}`, databaseUrl])
    : "-- MEMORY_XX_DATABASE_URL not configured\n";
  writeFileSync(join(outputDir, "schema.sql"), schemaDump, { mode: 0o600 });

  const [pgInfo, qdrantInfo, redisInfo] = await Promise.all([
    queryPg(databaseUrl, schema),
    queryQdrant(
      mergedEnv.MEMORY_XX_QDRANT_BASE_URL || "",
      mergedEnv.MEMORY_XX_QDRANT_COLLECTION || mergedEnv.MEMORY_XX_QDRANT_COLLECTION_NAME || "",
      mergedEnv.MEMORY_XX_QDRANT_API_KEY
    ),
    queryRedis(mergedEnv.MEMORY_XX_REDIS_URL || ""),
  ]);
  writeFileSync(join(outputDir, "data-manifest.json"), JSON.stringify({ postgres: pgInfo }, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(outputDir, "qdrant-info.json"), JSON.stringify(qdrantInfo, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(outputDir, "redis-info.json"), JSON.stringify(redisInfo, null, 2) + "\n", { mode: 0o600 });

  process.stdout.write(JSON.stringify({ ok: true, output_dir: outputDir }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
