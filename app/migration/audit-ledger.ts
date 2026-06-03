import { createHash, randomUUID } from "node:crypto";

import type { JsonObject } from "../shared";
import {
  MigrationAuditStatus,
  type AppendMigrationAuditEntryInput,
  type MigrationAuditEntry,
  type MigrationAuditRepositoryPort,
  MigrationStage,
  MigrationJobType,
  MigrationSourceSystem
} from "./types";

function stableJson(input: JsonObject | undefined): string {
  return JSON.stringify(input ?? {}, Object.keys(input ?? {}).sort());
}

function nowIso(): string {
  return new Date().toISOString();
}

export class InMemoryMigrationAuditRepository
  implements MigrationAuditRepositoryPort
{
  private readonly entries: MigrationAuditEntry[] = [];

  async append(input: AppendMigrationAuditEntryInput): Promise<MigrationAuditEntry> {
    const metadata = input.metadata ?? {};
    const entry: MigrationAuditEntry = {
      auditId: randomUUID(),
      migrationRunId: input.migrationRunId,
      batchId: input.batchId,
      stage: input.stage,
      jobType: input.jobType,
      sourceSystem: input.sourceSystem,
      sourceLocator: input.sourceLocator,
      targetTableOrAsset: input.targetTableOrAsset,
      targetRecordId: input.targetRecordId ?? null,
      status: input.status,
      attempt: input.attempt ?? 1,
      checksumBefore: input.checksumBefore,
      checksumAfter:
        input.checksumAfter ??
        createHash("sha256").update(stableJson(metadata)).digest("hex"),
      rowCountExpected: input.rowCountExpected,
      rowCountLoaded: input.rowCountLoaded,
      diffSummary: input.diffSummary,
      errorCode: input.errorCode,
      errorDetailRef: input.errorDetailRef,
      operator: input.operator ?? "system",
      workerId: input.workerId ?? "migration-shadow-runtime",
      startedAt: input.startedAt ?? nowIso(),
      finishedAt:
        input.finishedAt ??
        (input.status === MigrationAuditStatus.Running ? undefined : nowIso()),
      metadata
    };

    this.entries.push(entry);
    return entry;
  }

  async listByRun(migrationRunId: string): Promise<MigrationAuditEntry[]> {
    return this.entries.filter((entry) => entry.migrationRunId === migrationRunId);
  }
}

export interface MigrationAuditLedgerSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<MigrationAuditStatus, number>>;
  readonly byStage: Readonly<Record<MigrationStage, number>>;
  readonly byJobType: Readonly<Record<MigrationJobType, number>>;
  readonly bySourceSystem: Readonly<Record<MigrationSourceSystem, number>>;
}

function countByEnumValue<TEnum extends string>(
  values: readonly TEnum[],
  items: readonly TEnum[]
): Record<TEnum, number> {
  const counts = Object.fromEntries(values.map((value) => [value, 0])) as Record<
    TEnum,
    number
  >;

  for (const item of items) {
    counts[item] += 1;
  }

  return counts;
}

export async function summarizeMigrationAuditRun(
  repository: MigrationAuditRepositoryPort,
  migrationRunId: string
): Promise<MigrationAuditLedgerSummary> {
  const entries = await repository.listByRun(migrationRunId);

  return {
    total: entries.length,
    byStatus: countByEnumValue(
      Object.values(MigrationAuditStatus),
      entries.map((entry) => entry.status)
    ),
    byStage: countByEnumValue(
      Object.values(MigrationStage),
      entries.map((entry) => entry.stage)
    ),
    byJobType: countByEnumValue(
      Object.values(MigrationJobType),
      entries.map((entry) => entry.jobType)
    ),
    bySourceSystem: countByEnumValue(
      Object.values(MigrationSourceSystem),
      entries.map((entry) => entry.sourceSystem)
    )
  };
}
