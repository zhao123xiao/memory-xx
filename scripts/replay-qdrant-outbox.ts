/**
 * Minimal manual replay/repair entrypoint for qdrant sync.
 *
 * Default behavior is explicit and non-destructive:
 * - replay exactly one outbox event by --event-id
 * - OR replay a bounded batch of pending/failed events by exporter/status
 * - re-sync only the affected memory ids into Qdrant
 * - do NOT mutate outbox/cursor unless --mark-dispatched is provided
 *
 * Usage:
 *   MEMORY_V2_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/memory_xx \
 *   MEMORY_V2_DATABASE_SCHEMA=public \
 *   MEMORY_V2_QDRANT_BASE_URL=http://127.0.0.1:6333 \
 *   MEMORY_V2_QDRANT_COLLECTION=memory-xx \
 *   node --import tsx scripts/replay-qdrant-outbox.ts --event-id outbox_event_xxx
 *
 *   # Replay up to 20 failed/pending items for one exporter without moving cursor/state:
 *   node --import tsx scripts/replay-qdrant-outbox.ts \
 *     --exporter-name qdrant_projector \
 *     --status failed --status pending \
 *     --limit 20
 *
 *   # Only if you explicitly want to mark successful replays as dispatched:
 *   node --import tsx scripts/replay-qdrant-outbox.ts \
 *     --exporter-name qdrant_projector \
 *     --status failed \
 *     --limit 10 \
 *     --mark-dispatched
 *
 *   # Repair a single memory directly without touching outbox/cursor state:
 *   node --import tsx scripts/replay-qdrant-outbox.ts --memory-id memory_xxx
 */

import {
  DatabaseQdrantSyncOutboxRepository,
  HttpQdrantPointWriter,
  PostgresWriteDatabase,
  QdrantProjectionSyncService,
  RepairByMemoryIdService,
  ReplayQdrantExporterEventsService,
  ReplayQdrantOutboxEventService,
  SnapshotQdrantReplayRepairRepository,
  loadMemoryV2PostgresConfig,
  OutboxDispatchStatus
} from "../app";
import { ProjectorEmbeddingResolver } from "../app/qdrant-sync/projector-embedding-resolver.js";
import { QwenEmbeddingProviderWrapper } from "../app/server/embedding-provider.js";

interface ReplayCliArgs {
  readonly eventId?: string;
  readonly memoryId?: string;
  readonly exporterName?: string;
  readonly statuses: readonly OutboxDispatchStatus[];
  readonly limit?: number;
  readonly markDispatched: boolean;
}

function parseCliArgs(argv: string[]): ReplayCliArgs {
  const args = argv.slice(2);
  const get = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const getAll = (flag: string): string[] => {
    const values: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === flag && args[index + 1]) {
        values.push(args[index + 1]);
      }
    }
    return values;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const eventId = get("--event-id");
  const memoryId = get("--memory-id");
  const exporterName = get("--exporter-name");
  const statuses = getAll("--status").map(parseOutboxStatus);
  const limitRaw = get("--limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const markDispatched = has("--mark-dispatched");

  const modesSelected = [Boolean(eventId), Boolean(memoryId), Boolean(exporterName)].filter(Boolean).length;
  if (modesSelected !== 1) {
    throw new Error(
      "Usage: node --import tsx scripts/replay-qdrant-outbox.ts --event-id <outbox_event_id> [--mark-dispatched] OR --exporter-name <name> [--status pending|failed] [--limit <n>] [--mark-dispatched] OR --memory-id <memory_id>"
    );
  }
  if (memoryId && markDispatched) {
    throw new Error("--mark-dispatched is only supported with --event-id or --exporter-name replay modes.");
  }
  if (memoryId && statuses.length > 0) {
    throw new Error("--status is only supported with --exporter-name replay mode.");
  }
  if (memoryId && limit !== undefined) {
    throw new Error("--limit is only supported with --exporter-name replay mode.");
  }
  if (eventId && statuses.length > 0) {
    throw new Error("--status is only supported with --exporter-name replay mode.");
  }
  if (eventId && limit !== undefined) {
    throw new Error("--limit is only supported with --exporter-name replay mode.");
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer when provided.");
  }

  return {
    eventId,
    memoryId,
    exporterName,
    statuses,
    limit,
    markDispatched
  };
}

function parseOutboxStatus(raw: string): OutboxDispatchStatus {
  if (raw === OutboxDispatchStatus.Pending) {
    return OutboxDispatchStatus.Pending;
  }
  if (raw === OutboxDispatchStatus.Failed) {
    return OutboxDispatchStatus.Failed;
  }
  throw new Error(`Unsupported --status value: ${raw}. Use pending or failed.`);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);
  const config = loadMemoryV2PostgresConfig();
  const database = new PostgresWriteDatabase({ config });
  const outboxRepository = new DatabaseQdrantSyncOutboxRepository(database);
  const replayRepository = new SnapshotQdrantReplayRepairRepository(database);
  const embeddingResolver = new ProjectorEmbeddingResolver({
    provider: new QwenEmbeddingProviderWrapper(),
    database
  });
  const projectionSyncService = new QdrantProjectionSyncService({
    database,
    pointWriter: new HttpQdrantPointWriter(),
    embeddingResolver
  });
  const replayService = new ReplayQdrantOutboxEventService({
    projectionSyncService,
    replayRepository,
    outboxRepository,
    exporterName: args.exporterName
  });
  const exporterReplayService = new ReplayQdrantExporterEventsService({
    projectionSyncService,
    replayRepository,
    outboxRepository,
    exporterName: args.exporterName
  });
  const memoryRepairService = new RepairByMemoryIdService({
    projectionSyncService
  });

  try {
    const result = args.memoryId
      ? await memoryRepairService.execute({
          memoryIds: [args.memoryId]
        })
      : args.eventId
      ? await replayService.execute({
          eventId: args.eventId,
          markDispatched: args.markDispatched
        })
      : await exporterReplayService.execute({
          statuses: args.statuses,
          limit: args.limit,
          markDispatched: args.markDispatched
        });

    console.log(
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          action: "qdrant_outbox_replay",
          ...result,
          note: result.mutatedOutboxState
            ? "replay succeeded and selected outbox rows were marked dispatched"
            : "replay succeeded without changing outbox/cursor state"
        },
        null,
        2
      )
    );
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
