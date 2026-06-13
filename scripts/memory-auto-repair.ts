#!/usr/bin/env tsx
import "./test-harness/config.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  evaluateMemoryAutoRepairPlan,
  HttpQdrantPointWriter,
  inspectEmbeddingGenerationHealth,
  normalizeAutoRepairPolicy,
  PostgresWriteDatabase,
  QdrantProjectionReconcileService,
  QdrantProjectionSyncService,
  loadMemoryXXPostgresConfig,
} from "../app";
import { ProjectorEmbeddingResolver } from "../app/qdrant-sync/projector-embedding-resolver.js";
import { QwenEmbeddingProviderWrapper } from "../app/server/embedding-provider.js";
import { requireCliPermission } from "../app/server/permissions.js";

function readArg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function readPositiveArg(name: string, fallback: number): number {
  const raw = readArg(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer.`);
  return parsed;
}

function runtimeDir(): string {
  return process.env.MEMORY_XX_RUNTIME_DIR?.trim() || path.join(process.cwd(), ".runtime");
}

function repairRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function summarizeDiff(result: Awaited<ReturnType<QdrantProjectionReconcileService["execute"]>>): Record<string, unknown> {
  return {
    ok: result.ok,
    qdrant_point_count: result.diff.qdrantPointCount,
    qdrant_memory_id_count: result.diff.qdrantMemoryIdCount,
    postgres_effective_recallable_count: result.diff.postgresEffectiveRecallableCount,
    stale_count: result.diff.staleMemoryIds.length,
    missing_count: result.diff.missingMemoryIds.length,
    orphan_count: result.diff.orphanPointIds.length,
    payload_drift_count: result.diff.payloadDriftMemoryIds.length,
    planned_memory_ids: result.plannedMemoryIds.length,
    planned_orphan_point_ids: result.plannedOrphanPointIds.length,
    applied_memory_ids: result.appliedMemoryIds.length,
    deleted_orphan_point_ids: result.deletedOrphanPointIds.length,
  };
}

function writeRepairArtifact(payload: Record<string, unknown>): string {
  const dir = path.join(runtimeDir(), "repair-runs");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(payload.run_id ?? repairRunId())}.json`);
  const body = JSON.stringify(payload, null, 2);
  writeFileSync(file, body + "\n");
  writeFileSync(path.join(dir, "latest.json"), body + "\n");
  return file;
}

function validateActiveManifest(generationId: string | null): Record<string, unknown> {
  if (!generationId) return { ok: false, skipped: true, reason: "active_generation_missing" };
  try {
    const stdout = execFileSync("npm", ["run", "memory:embedding-manifest", "--", "validate", `--generation-id=${generationId}`], {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: "/tmp" },
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: Number.parseInt(process.env.MEMORY_XX_AUTO_REPAIR_VALIDATE_TIMEOUT_MS || "300000", 10),
    });
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    return { ok: true, body: start >= 0 && end >= start ? JSON.parse(stdout.slice(start, end + 1)) : stdout.slice(-4000) };
  } catch (error: any) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stdout_tail: typeof error?.stdout === "string" ? error.stdout.slice(-4000) : undefined,
      stderr_tail: typeof error?.stderr === "string" ? error.stderr.slice(-4000) : undefined,
    };
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const json = process.argv.includes("--json");
  await requireCliPermission(apply ? "memory:governance_apply" : "memory:governance_read");

  const checkedAt = new Date().toISOString();
  const runId = repairRunId();
  const policy = normalizeAutoRepairPolicy({
    maxDrift: readPositiveArg("max-drift", 100),
    maxDelete: readPositiveArg("max-delete", 20),
    maxUpsert: readPositiveArg("max-upsert", 100),
  });

  const database = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(process.env) });
  const pointWriter = new HttpQdrantPointWriter();
  const projectionSyncService = new QdrantProjectionSyncService({
    database,
    pointWriter,
    embeddingResolver: new ProjectorEmbeddingResolver({
      provider: new QwenEmbeddingProviderWrapper(),
      database,
    }),
  });
  const reconcile = new QdrantProjectionReconcileService({ projectionSyncService, pointWriter });

  try {
    const embeddingHealth = await inspectEmbeddingGenerationHealth().catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    const activeGeneration = (embeddingHealth as any)?.active_generation?.generation_id ?? null;
    const before = await reconcile.execute({ apply: false, limit: policy.maxDrift });
    const plan = evaluateMemoryAutoRepairPlan({
      before,
      embeddingGenerationOk: (embeddingHealth as any)?.ok === true,
      embeddingGenerationEvidence: embeddingHealth as Record<string, unknown>,
      policy,
      checkedAt,
    });

    let applied = null as Awaited<ReturnType<QdrantProjectionReconcileService["execute"]>> | null;
    let after = null as Awaited<ReturnType<QdrantProjectionReconcileService["execute"]>> | null;
    let manifestValidation: Record<string, unknown> | null = null;
    let status: "ok" | "report" | "repairing" | "repaired" | "blocked" | "failed" = plan.ok ? "ok" : "report";

    if (apply) {
      if (!plan.can_apply) {
        status = plan.ok ? "ok" : "blocked";
      } else {
        status = "repairing";
        applied = await reconcile.execute({ apply: true, limit: policy.maxDrift });
        manifestValidation = validateActiveManifest(activeGeneration);
        after = await reconcile.execute({ apply: false, limit: policy.maxDrift });
        status = after.ok && manifestValidation.ok !== false ? "repaired" : "failed";
      }
    }

    const payload = {
      run_id: runId,
      action: "memory_auto_repair",
      mode: apply ? "apply" : "report",
      status,
      ok: status === "ok" || status === "repaired",
      checked_at: checkedAt,
      completed_at: new Date().toISOString(),
      policy,
      can_apply: plan.can_apply,
      blocked_reasons: plan.blocked_reasons,
      issues: plan.issues,
      before: summarizeDiff(before),
      applied: applied ? summarizeDiff(applied) : null,
      after: after ? summarizeDiff(after) : null,
      manifest_validation: manifestValidation,
      recommended_action: plan.recommended_action,
    };
    const artifact = writeRepairArtifact(payload);
    const output = { ...payload, artifact };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    if (status === "blocked" || status === "failed") process.exitCode = 1;
    if (!json && status === "report" && plan.issues.length > 0) process.exitCode = 1;
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  const payload = {
    run_id: repairRunId(),
    action: "memory_auto_repair",
    mode: process.argv.includes("--apply") ? "apply" : "report",
    status: "failed",
    ok: false,
    checked_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    issues: [{
      id: "memory_auto_repair_failed",
      severity: "critical",
      subsystem: "runtime",
      root_cause: "自动修复运行失败",
      evidence: { error: error instanceof Error ? error.message : String(error) },
      repairability: "manual_safe",
      recommended_action: "查看 memory-auto-repair 输出和 .runtime/repair-runs/latest.json，修复依赖后重跑。",
      last_checked_at: new Date().toISOString(),
    }],
  };
  const artifact = writeRepairArtifact(payload);
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.stdout.write(JSON.stringify({ ...payload, artifact }, null, 2) + "\n");
  process.exitCode = 1;
});
