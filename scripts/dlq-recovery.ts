import "./test-harness/config.js";
import { Pool } from "pg";
import { createPostgresPoolConfig, loadMemoryV2PostgresConfig } from "../app/db/adapters/postgres-config";

async function main(): Promise<void> {
  const config = loadMemoryV2PostgresConfig(process.env);
  const pool = new Pool(createPostgresPoolConfig(config));
  const maxAttempts = Number.parseInt(process.env.MEMORY_V2_QDRANT_PROJECTOR_MAX_ATTEMPTS ?? "5", 10);
  try {
    const schema = quoteIdent(config.schema);
    const result = await pool.query(
      `SELECT count(*)::int AS dead_letter_candidates
         FROM ${schema}.outbox_events
        WHERE dispatch_status = 'failed' AND attempts >= $1`,
      [maxAttempts]
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: process.argv[2] ?? "scan",
      max_attempts: maxAttempts,
      dead_letter_candidates: result.rows[0]?.dead_letter_candidates ?? 0,
      note: "This CLI currently reports DLQ candidates; replay remains handled by memory:recall-repair/replay:qdrant-outbox."
    }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return `"${value}"`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
