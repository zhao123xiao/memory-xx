import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "./test-harness/config.js";
import { createPool, query, closePool } from "./test-harness/lib/db-helpers.js";

function anonymize(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function main(): Promise<void> {
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = Math.max(1, Math.min(Number(limitArg?.split("=")[1] ?? 250), 1000));
  const outDir = path.join(config.projectRoot, "reports", "graphiti-shadow");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `shadow-export-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const pool = createPool();

  try {
    const rows = await query(pool, `
      SELECT id, scope_type, scope_id, memory_type, title, content, memory_layer, fact_status,
             valid_at, invalid_at, observed_at, episode_id, metadata
      FROM ${config.dbSchema}.memory_records
      WHERE is_current IS TRUE
        AND lifecycle_status = 'approved'
      ORDER BY updated_at DESC
      LIMIT $1
    `, [limit]);

    const lines = rows.rows.map((row) => JSON.stringify({
      episode_id: row.episode_id ? anonymize(String(row.episode_id)) : null,
      memory_id: anonymize(String(row.id)),
      scope: `${row.scope_type}:${anonymize(String(row.scope_id))}`,
      memory_type: row.memory_type,
      title: row.title,
      fact: row.content,
      memory_layer: row.memory_layer,
      fact_status: row.fact_status,
      valid_at: row.valid_at,
      invalid_at: row.invalid_at,
      observed_at: row.observed_at,
      topic: row.metadata?.topic ?? null,
    }));
    fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
    console.log(JSON.stringify({ ok: true, out_path: outPath, records: rows.rowCount }, null, 2));
  } finally {
    await closePool(pool);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
