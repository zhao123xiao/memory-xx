import "./test-harness/config.js";
import {
  CreateMemoryService,
  LifecycleStatus,
  ReviewState,
  ScopeType,
  loadMemoryXXPostgresConfig,
  PostgresWriteDatabase
} from "../app";
import { IntelligenceService } from "../app/intelligence/service";
import type { ExtractedMemory } from "../app/intelligence/types";
import { withWriteTransaction } from "../app/db/tx/write-transaction";
import { LowConfidenceBufferRepository } from "../app/db/repositories/low-confidence-buffer-repository";
import { GovernanceRepository } from "../app/db/repositories/governance-repository";
import type { LowConfidenceBufferRow } from "../app/db/schema/tables";

function resolveScopeType(raw: string): ScopeType {
  const map: Record<string, ScopeType> = {
    personal: ScopeType.User,
    user: ScopeType.User,
    shared: ScopeType.Workspace,
    workspace: ScopeType.Workspace,
    project: ScopeType.Project,
    global: ScopeType.Global,
    run: ScopeType.Run,
    task: ScopeType.Task,
  };
  return map[raw.toLowerCase()] ?? ScopeType.Project;
}

function firstPromotableMemory(memories: readonly ExtractedMemory[]): ExtractedMemory | null {
  return memories.find((memory) => (memory.quality_gate?.score ?? memory.confidence) >= 0.60) ?? null;
}

async function retryBufferRow(
  db: PostgresWriteDatabase,
  repo: LowConfidenceBufferRepository,
  row: LowConfidenceBufferRow,
): Promise<"promoted" | "retried"> {
  const service = new IntelligenceService();
  const extraction = await service.extract({
    text: row.inputText,
    agent_id: row.actorId,
    scope_hint: { scope_type: row.scopeType, scope_id: row.scopeId },
    mode: "write",
  });
  const memory = extraction.ok && extraction.should_write ? firstPromotableMemory(extraction.memories) : null;
  if (!memory) {
    await withWriteTransaction(db, (tx) => repo.markRetried(tx, row.id));
    return "retried";
  }

  const write = await new CreateMemoryService({ database: db }).execute({
    requestId: `${row.requestId}:low-confidence-retry:${row.retryCount + 1}`,
    actorId: row.actorId,
    scopeType: resolveScopeType(row.scopeType),
    scopeId: row.scopeId,
    content: memory.canonical_content,
    title: memory.title,
    summary: null,
    metadata: {
      source: "low_confidence_buffer_retry",
      low_confidence_buffer_id: row.id,
      memory_type: memory.memory_type,
      topic: memory.topic,
      confidence: memory.confidence,
      quality_gate: memory.quality_gate ?? extraction.quality_gate ?? {},
      review_reason: "low_confidence_retry_promoted",
    },
    dedupeKey: memory.dedupe_key,
    memoryType: memory.memory_type,
    lifecycleStatus: LifecycleStatus.Candidate,
    reviewState: ReviewState.Pending,
    sources: [],
    relations: [],
  });
  await withWriteTransaction(db, (tx) => repo.markPromoted(tx, row.id, write.memoryId));
  return "promoted";
}

async function main(): Promise<void> {
  const db = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(process.env) });
  const repo = new LowConfidenceBufferRepository();
  try {
    const now = new Date();
    const abandonCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const due = await withWriteTransaction(db, (tx) => repo.listDueForRetry(tx, 20));
    let retried = 0;
    let promoted = 0;
    let failed = 0;
    let skippedFrozen = 0;
    for (const row of due) {
      try {
        const frozen = await withWriteTransaction(db, (tx) =>
          new GovernanceRepository().isScopeFrozen(tx, row.scopeType, row.scopeId, "low_confidence_promote")
        );
        if (frozen) {
          skippedFrozen += 1;
          continue;
        }
        const result = await retryBufferRow(db, repo, row);
        if (result === "promoted") promoted += 1;
        else retried += 1;
      } catch {
        failed += 1;
        await withWriteTransaction(db, (tx) => repo.markRetried(tx, row.id)).catch(() => undefined);
      }
    }
    const abandoned = await withWriteTransaction(db, (tx) =>
      repo.markAbandonedOlderThan(tx, abandonCutoff)
    );
    process.stdout.write(JSON.stringify({ ok: true, scanned: due.length, promoted, retried, failed, skipped_frozen: skippedFrozen, abandoned }) + "\n");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
