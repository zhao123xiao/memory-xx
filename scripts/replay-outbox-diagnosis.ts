/**
 * replay-outbox-diagnosis.ts
 * Re-play all 8 outbox events with the FIXED projector and report results.
 *
 * 用法：
 *   MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/memory_xx \
 *   MEMORY_XX_DATABASE_SCHEMA=memory_xx \
 *   MEMORY_XX_QDRANT_BASE_URL=http://127.0.0.1:6333 \
 *   MEMORY_XX_QDRANT_COLLECTION=memory-xx \
 *   node --import tsx scripts/replay-outbox-diagnosis.ts
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
  const pointWriter = new HttpQdrantPointWriter({ config: loadMemoryXXQdrantConfig() });
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
    console.log(`  dispatchStatus=${event.dispatchStatus} lifecycleCandidates=${event.eventType.includes("created") ? "check-PGs" : "N/A"}`);
    console.log(`  => upsert=${upserts.length} skip=${skips.length} delete=${deletes.length} error=${errors.length}`);
    if (skips.length > 0) {
      skips.forEach((s: { memoryId: string; reason: string }) => {
        console.log(`    SKIP ${s.memoryId.slice(0, 8)}: ${s.reason}`);
      });
    }
    if (errors.length > 0) {
      errors.forEach((e: { memoryId: string; reason: string }) => {
        console.log(`    ERROR ${e.memoryId.slice(0, 8)}: ${e.reason}`);
      });
    }
    console.log();
  }

  // Qdrant count after replay
  try {
    const r = await fetch("http://127.0.0.1:6333/collections/memory-xx/points/count", {
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
