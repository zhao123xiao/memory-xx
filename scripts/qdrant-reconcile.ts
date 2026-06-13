import "./test-harness/config.js";
import {
  HttpQdrantPointWriter,
  PostgresWriteDatabase,
  QdrantProjectionReconcileService,
  QdrantProjectionSyncService,
  loadMemoryXXPostgresConfig,
} from "../app";
import { ProjectorEmbeddingResolver } from "../app/qdrant-sync/projector-embedding-resolver.js";
import { OpenAICompatibleEmbeddingProvider } from "../app/server/embedding-provider.js";
import { requireCliPermission } from "../app/server/permissions.js";
import { buildQdrantProjectionIssue, normalizeAutoRepairPolicy } from "../app/ops";

function readArg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function readLimit(): number | undefined {
  const raw = readArg("limit");
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--limit must be a positive integer.");
  }
  return parsed;
}

function readPositiveArg(name: string, fallback: number): number {
  const raw = readArg(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  await requireCliPermission(apply ? "memory:governance_apply" : "memory:governance_read");

  const database = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(process.env) });
  const pointWriter = new HttpQdrantPointWriter();
  const projectionSyncService = new QdrantProjectionSyncService({
    database,
    pointWriter,
    embeddingResolver: new ProjectorEmbeddingResolver({
      provider: new OpenAICompatibleEmbeddingProvider(),
      database,
    }),
  });
  const reconcile = new QdrantProjectionReconcileService({
    projectionSyncService,
    pointWriter,
  });

  try {
    const result = await reconcile.execute({
      apply,
      limit: readLimit(),
    });
    const checkedAt = new Date().toISOString();
    const policy = normalizeAutoRepairPolicy({
      maxDrift: readPositiveArg("max-drift", 100),
      maxDelete: readPositiveArg("max-delete", 20),
      maxUpsert: readPositiveArg("max-upsert", 100),
    });
    const issue = buildQdrantProjectionIssue(result.diff, { policy, checkedAt });
    process.stdout.write(JSON.stringify({
      timestamp: checkedAt,
      action: "qdrant_projection_reconcile",
      issues: issue ? [issue] : [],
      ...result,
      note: apply
        ? "Applied PG truth-source reconciliation to Qdrant."
        : "Report-only. Re-run with --apply to delete stale points and upsert missing/drifted approved memories.",
    }, null, 2) + "\n");
    if (!result.ok && !apply) {
      process.exitCode = 1;
    }
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
