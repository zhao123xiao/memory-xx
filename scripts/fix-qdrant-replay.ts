/**
 * fix-qdrant-replay.ts
 *
 * 使用修复后的 projector 对 8 条 outbox 事件逐条 replay，
 * 确认 upsert/skip/delete 行为是否符合修复预期。
 *
 * 用法：
 *   cd <project-root>
 *   MEMORY_V2_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/memory_xx \
 *   MEMORY_V2_DATABASE_SCHEMA=shadow_r3_20260414 \
 *   MEMORY_V2_QDRANT_BASE_URL=http://127.0.0.1:6333 \
 *   MEMORY_V2_QDRANT_COLLECTION=memory-xx \
 *   node --import tsx scripts/fix-qdrant-replay.ts
 */

import { PostgresWriteDatabase } from "../app/db/adapters/postgres-write-database";
import { DatabaseQdrantSyncOutboxRepository } from "../app/qdrant-sync/outbox-worker";
import { HttpQdrantPointWriter } from "../app/qdrant-sync/qdrant-point-writer";
import { QdrantProjectionSyncService, EXPECTED_VECTOR_DIMENSION } from "../app/qdrant-sync/projector";
import { loadMemoryV2PostgresConfig, loadMemoryV2QdrantConfig } from "../app";

async function main() {
  const pgConfig = loadMemoryV2PostgresConfig();
  const qdrantConfig = loadMemoryV2QdrantConfig();

  console.log("Qdrant config:", JSON.stringify(qdrantConfig));
  console.log("Expected vector dimension:", EXPECTED_VECTOR_DIMENSION);

  const database = new PostgresWriteDatabase({ config: pgConfig });
  const outboxRepo = new DatabaseQdrantSyncOutboxRepository(database);
  const pointWriter = new HttpQdrantPointWriter({ config: qdrantConfig });
  const syncService = new QdrantProjectionSyncService({ database, pointWriter });

  const snapshot = await database.snapshot();
  const allRows = snapshot.outboxEvents;

  console.log(`Total outbox events: ${allRows.length}\n`);

  for (const event of allRows) {
    const memoryIds = [event.aggregateId];
    const payloadMemId = (event.payload as Record<string, unknown>).memoryId as string | undefined;
    if (payloadMemId && payloadMemId !== event.aggregateId) memoryIds.push(payloadMemId);
    const uniqueIds = [...new Set(memoryIds)];

    let syncResult;
    try {
      syncResult = await syncService.syncMemoryIds(uniqueIds);
    } catch (err) {
      syncResult = { items: [{ memoryId: event.aggregateId, operation: "error", reason: String(err) }] };
    }

    const upserts = syncResult.items.filter((i: { operation: string }) => i.operation === "upsert");
    const skips = syncResult.items.filter((i: { operation: string }) => i.operation === "skip");
    const deletes = syncResult.items.filter((i: { operation: string }) => i.operation === "delete");
    const errors = syncResult.items.filter((i: { operation: string }) => i.operation === "error");

    console.log(`[${event.id.slice(0, 8)}] ${event.eventType} ${event.aggregateId.slice(0, 8)}`);
    console.log(`  => upsert=${upserts.length} skip=${skips.length} delete=${deletes.length} error=${errors.length}`);
    if (skips.length > 0) {
      skips.forEach((s: { memoryId: string; reason: string }) => {
        console.log(`    SKIP ${s.memoryId.slice(0, 8)}: ${s.reason}`);
      });
    }
    if (errors.length > 0) {
      errors.forEach((e: { memoryId: string; reason: string }) => {
        console.log(`    ERROR: ${e.reason}`);
      });
    }
    console.log();
  }

  // Qdrant count after replay
  try {
    const r = await fetch(`${qdrantConfig.base_url}/collections/${qdrantConfig.collection_name}/points/count`, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    const d = await r.json() as { result?: { count: number } };
    console.log(`Qdrant points after replay: ${d.result?.count ?? "unknown"}`);
  } catch (e) {
    console.log(`Qdrant count failed: ${e}`);
  }

  await database.close();
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
