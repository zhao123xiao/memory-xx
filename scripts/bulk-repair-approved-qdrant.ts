/**
 * bulk-repair-approved-qdrant.ts
 *
 * 对所有 approved + is_current + content_embedding IS NOT NULL 记录
 * 触发 Qdrant sync（使用修复后的 projector）。
 *
 * 用法：
 *   MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/memory_xx \
 *   MEMORY_XX_DATABASE_SCHEMA=memory_xx \
 *   MEMORY_XX_QDRANT_BASE_URL=http://127.0.0.1:6333 \
 *   MEMORY_XX_QDRANT_COLLECTION=memory-xx \
 *   node --import tsx scripts/bulk-repair-approved-qdrant.ts
 */

import "./test-harness/config.js";
import { PostgresWriteDatabase } from "../app/db/adapters/postgres-write-database";
import { HttpQdrantPointWriter } from "../app/qdrant-sync/qdrant-point-writer";
import { QdrantProjectionSyncService } from "../app/qdrant-sync/projector";
import { loadMemoryXXPostgresConfig, loadMemoryXXQdrantConfig } from "../app";

const BATCH_SIZE = 50;

async function main() {
  const pgConfig = loadMemoryXXPostgresConfig();
  const qdrantConfig = loadMemoryXXQdrantConfig();

  const database = new PostgresWriteDatabase({ config: pgConfig });
  const pointWriter = new HttpQdrantPointWriter({ config: qdrantConfig });
  const syncService = new QdrantProjectionSyncService({ database, pointWriter });

  // Fetch all approved + is_current records with real content_embedding
  const result = await database.pool.query(
    `SELECT id FROM "${pgConfig.schema}".memory_records
     WHERE lifecycle_status = 'approved'
       AND is_current = true
       AND content_embedding IS NOT NULL
     ORDER BY created_at ASC`
  );

  const allIds = result.rows.map((row: { id: string }) => row.id);
  console.log(`Found ${allIds.length} approved records with content_embedding`);

  let totalUpsert = 0;
  let totalSkip = 0;
  let totalDelete = 0;
  let totalError = 0;

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batch = allIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batchStart = i + 1;
    const batchEnd = Math.min(i + BATCH_SIZE, allIds.length);

    process.stdout.write(`[batch ${batchNum}] records ${batchStart}-${batchEnd}... `);

    const syncResult = await syncService.syncMemoryIds(batch);

    const upserts = syncResult.items.filter((i: { operation: string }) => i.operation === "upsert").length;
    const skips = syncResult.items.filter((i: { operation: string }) => i.operation === "skip").length;
    const deletes = syncResult.items.filter((i: { operation: string }) => i.operation === "delete").length;
    const errors = syncResult.items.filter((i: { operation: string }) => i.operation === "error").length;

    totalUpsert += upserts;
    totalSkip += skips;
    totalDelete += deletes;
    totalError += errors;

    process.stdout.write(`upsert=${upserts} skip=${skips} delete=${deletes} error=${errors}\n`);

    // Log first skip for this batch if any
    if (skips > 0) {
      const skipItems = syncResult.items.filter((i: { operation: string }) => i.operation === "skip");
      skipItems.slice(0, 3).forEach((s: { memoryId: string; reason: string }) => {
        console.log(`  SKIP ${s.memoryId.slice(0, 16)}: ${s.reason}`);
      });
    }
    if (errors > 0) {
      const errItems = syncResult.items.filter((i: { operation: string }) => i.operation === "error");
      errItems.slice(0, 3).forEach((e: { memoryId: string; reason: string }) => {
        console.log(`  ERROR ${e.memoryId.slice(0, 16)}: ${e.reason}`);
      });
    }
  }

  console.log(`\n=== TOTALS ===`);
  console.log(`Total records: ${allIds.length}`);
  console.log(`Upsert: ${totalUpsert}`);
  console.log(`Skip:   ${totalSkip}`);
  console.log(`Delete: ${totalDelete}`);
  console.log(`Error:  ${totalError}`);

  // Final Qdrant count
  try {
    const r = await fetch(`${qdrantConfig.base_url}/collections/${qdrantConfig.collection_name}/points/count`, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    const d = await r.json() as { result?: { count: number } };
    console.log(`\nQdrant points final count: ${d.result?.count ?? "unknown"}`);
  } catch (e) {
    console.log(`Qdrant count failed: ${e}`);
  }

  await database.close();
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
