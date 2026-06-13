/**
 * diagnose-qdrant-projector-gap.ts
 * 
 * 诊断目标：8条outbox事件全部dispatched，但Qdrant只有1个点（无vector）。
 * 对每条事件跑syncMemoryIds，看是upsert/skip/delete，找7/8静默失败的根因。
 * 
 * 用法：
 *   MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/memory_xx \
 *   MEMORY_XX_DATABASE_SCHEMA=memory_xx \
 *   MEMORY_XX_QDRANT_BASE_URL=http://127.0.0.1:6333 \
 *   MEMORY_XX_QDRANT_COLLECTION=memory-xx \
 *   node --import tsx scripts/diagnose-qdrant-projector-gap.ts
 */

import { PostgresWriteDatabase } from "../app/db/adapters/postgres-write-database";
import { DatabaseQdrantSyncOutboxRepository } from "../app/qdrant-sync/outbox-worker";
import { HttpQdrantPointWriter } from "../app/qdrant-sync/qdrant-point-writer";
import { QdrantProjectionSyncService } from "../app/qdrant-sync/projector";
import { loadMemoryXXPostgresConfig, loadMemoryXXQdrantConfig } from "../app";

async function main() {
  const pgConfig = loadMemoryXXPostgresConfig();
  const database = new PostgresWriteDatabase({ config: pgConfig });
  
  const outboxRepo = new DatabaseQdrantSyncOutboxRepository(database);
  
  // 从snapshot直接读所有事件（包括已dispatched的）
  const snapshot = await database.snapshot();
  const allRows = snapshot.outboxEvents;
  
  const processableEvents = await outboxRepo.listProcessableEvents({
    exporterName: "qdrant_projector",
    limit: 100,
    maxAttempts: 999
  });
  const processableIds = new Set(processableEvents.map(e => e.id));
  
  console.log(`Total outbox events in DB: ${allRows.length}`);
  console.log(`Processable (non-dispatched, non-max-attempt): ${processableEvents.length}`);
  console.log();
  
  // 对每条事件单独跑 syncMemoryIds
  const pointWriter = new HttpQdrantPointWriter({ config: loadMemoryXXQdrantConfig() });
  const syncService = new QdrantProjectionSyncService({ database, pointWriter });
  
  console.log("=== Per-event syncMemoryIds diagnosis ===\n");
  
  for (const event of allRows) {
    const memoryIds = [event.aggregateId];
    const payloadMemId = (event.payload as Record<string, unknown>).memoryId as string | undefined;
    if (payloadMemId && payloadMemId !== event.aggregateId) {
      memoryIds.push(payloadMemId);
    }
    const uniqueIds = [...new Set(memoryIds)];
    
    let result: string;
    try {
      const syncResult = await syncService.syncMemoryIds(uniqueIds);
      const upserts = syncResult.items.filter(i => i.operation === "upsert");
      const skips = syncResult.items.filter(i => i.operation === "skip");
      const deletes = syncResult.items.filter(i => i.operation === "delete");
      result = `upsert=${upserts.length} skip=${skips.length} delete=${deletes.length}`;
      if (skips.length > 0) {
        result += ` | skip reasons: ${skips.map(s => `${s.memoryId}:${s.reason}`).join(", ")}`;
      }
      if (deletes.length > 0) {
        result += ` | delete reasons: ${deletes.map(d => `${d.memoryId}:${d.reason}`).join(", ")}`;
      }
    } catch (err) {
      result = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    
    console.log(`[${event.id}]`);
    console.log(`  event_type: ${event.eventType}`);
    console.log(`  aggregateId: ${event.aggregateId}`);
    console.log(`  dispatchStatus: ${event.dispatchStatus}`);
    console.log(`  attempts: ${event.attempts}`);
    console.log(`  isProcessable: ${processableIds.has(event.id)}`);
    console.log(`  memoryIds: ${uniqueIds.join(", ")}`);
    console.log(`  syncMemoryIds result: ${result}`);
    console.log();
  }
  
  // 额外检查：Qdrant里实际有几个点
  try {
    const qdrantResp = await fetch(`http://127.0.0.1:6333/collections/memory-xx/points/count`, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    const qdrantData = await qdrantResp.json() as { result?: { count: number } };
    console.log(`=== Qdrant collection status ===`);
    console.log(`points_count: ${qdrantData.result?.count ?? "unknown"}`);
  } catch (e) {
    console.log(`Qdrant count query failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  
  await database.close();
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
