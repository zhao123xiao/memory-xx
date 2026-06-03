import "./test-harness/config.js";
import { Pool } from "pg";
import { createPostgresPoolConfig, loadMemoryV2PostgresConfig } from "../app/db/adapters/postgres-config";

async function main(): Promise<void> {
  const config = loadMemoryV2PostgresConfig(process.env);
  const pool = new Pool(createPostgresPoolConfig(config));
  try {
    const schema = quoteIdent(config.schema);
    const events = await pool.query(
      `SELECT event_type, count(*)::int AS count
         FROM ${schema}.memory_events
        GROUP BY event_type
        ORDER BY event_type`
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: process.argv.includes("archive") ? "archive-report" : "scan",
      apply: process.argv.includes("--apply"),
      events: events.rows,
      note: "Archive mode is report-only in this recovered CLI surface."
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
