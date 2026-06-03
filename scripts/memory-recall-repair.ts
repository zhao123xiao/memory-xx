import "./test-harness/config.js";
import {
  GovernanceRepository,
  HttpQdrantPointWriter,
  PostgresWriteDatabase,
  QdrantProjectionSyncService,
  RepairByMemoryIdService,
  defaultRecallRepairSuggestedAction,
  loadMemoryV2PostgresConfig,
  normalizeRecallRepairRootCauseType,
  resolveRecallRepairRootCauseType,
  withWriteTransaction,
  type JsonObject,
  type RecallRepairRootCauseType
} from "../app";
import { requireCliPermission } from "../app/server/permissions.js";

function readArg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function readLimit(): number {
  const value = Number(readArg("limit") || 20);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 20) : 20;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  await requireCliPermission(apply ? "memory:governance_apply" : "memory:governance_read");
  const limit = readLimit();
  const database = new PostgresWriteDatabase({ config: loadMemoryV2PostgresConfig(process.env) });
  const repairByMemoryId = new RepairByMemoryIdService({
    projectionSyncService: new QdrantProjectionSyncService({
      database,
      pointWriter: new HttpQdrantPointWriter()
    })
  });
  try {
    const result = await withWriteTransaction(database, async (tx) => {
      const governance = new GovernanceRepository();
      const run = await governance.tryBeginRun(tx, {
        jobType: "recall_repair",
        mode: apply ? "apply" : "report-only",
        policy: apply ? "high-confidence-only" : "report-only",
      });
      if (run.status === "skipped_lock_held") return { ok: false, governance_run: run, error: "governance lock already held" };

      const rows = await tx.query<{
        id: string;
        query_hash: string;
        recall_trace_id: string | null;
        issue_type: string;
        count: number;
        details: JsonObject;
        urgency: string;
        root_cause_type: string | null;
        root_cause: string | null;
        suggested_action: string | null;
      }>(
        `
          SELECT *
          FROM recall_repair_queue
          WHERE status IN ('open', 'suggested')
          ORDER BY
            CASE urgency WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
            count DESC,
            updated_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        `,
        [limit]
      );

      let applied = 0;
      let suggested = 0;
      let skippedFrozen = 0;
      const reported = [];
      for (const row of rows) {
        const details = row.details ?? {};
        const scopeType = typeof details.scope_type === "string" ? details.scope_type : null;
        const scopeId = typeof details.scope_id === "string" ? details.scope_id : null;
        if (apply && scopeType && scopeId && await governance.isScopeFrozen(tx, scopeType, scopeId, "recall_repair_apply")) {
          skippedFrozen += 1;
          await governance.recordAction(tx, {
            runId: run.id,
            actionType: "recall_repair_apply_skipped_frozen",
            scopeType,
            scopeId,
            selector: { repair_id: row.id, query_hash: row.query_hash },
            evidence: row as unknown as JsonObject,
            status: "skipped",
          });
          continue;
        }

        if (!apply) {
          reported.push(row);
          continue;
        }

        const memoryId = typeof details.memory_id === "string" ? details.memory_id : null;
        const rootCauseType = resolveRowRootCauseType(row.root_cause_type, row.root_cause, details, memoryId);
        const suggestedAction = row.suggested_action ??
          readString(details.suggested_action) ??
          defaultRecallRepairSuggestedAction(rootCauseType);
        const suggestedValues = readJsonObject(details.suggested_values) ?? {};
        const alias = readString(details.alias) ?? readString(suggestedValues.alias);

        let queueApplied = false;
        let actionId: string | null = null;
        if (rootCauseType === "projection_gap" && memoryId) {
          const projectionResult = await repairByMemoryId.execute({ memoryIds: [memoryId] });
          const action = await governance.recordAction(tx, {
            runId: run.id,
            actionType: "recall_repair_reproject",
            scopeType,
            scopeId,
            memoryId,
            selector: { repair_id: row.id, query_hash: row.query_hash },
            evidence: row as unknown as JsonObject,
            afterState: {
              root_cause_type: rootCauseType,
              suggested_action: suggestedAction,
              suggested_values: suggestedValues,
              projection_result: projectionResult as unknown as JsonObject
            } as JsonObject,
            status: "applied",
          });
          actionId = action.id;
          queueApplied = true;
          applied += 1;
        } else {
          const action = await governance.recordAction(tx, {
            runId: run.id,
            actionType: rootCauseType === "alias_missing"
              ? "recall_repair_alias_suggestion"
              : "recall_repair_suggestion",
            scopeType,
            scopeId,
            memoryId,
            selector: { repair_id: row.id, query_hash: row.query_hash },
            evidence: row as unknown as JsonObject,
            afterState: {
              root_cause_type: rootCauseType,
              suggested_action: suggestedAction,
              suggested_values: suggestedValues,
              alias
            } as JsonObject,
            status: "reported",
          });
          actionId = action.id;
          suggested += 1;
        }
        await tx.query(
          `
            UPDATE recall_repair_queue
            SET status = CASE WHEN $2::boolean THEN 'applied' ELSE 'suggested' END,
                governance_action_id = $3,
                root_cause_type = COALESCE(root_cause_type, $4),
                root_cause = COALESCE(root_cause, $4),
                suggested_action = COALESCE(suggested_action, $5),
                applied_at = CASE WHEN $2::boolean THEN $6::timestamptz ELSE applied_at END,
                updated_at = $6::timestamptz
            WHERE id = $1
          `,
          [row.id, queueApplied, actionId, rootCauseType, suggestedAction, tx.now()]
        );
      }

      await governance.finishRun(tx, run.id, "success", {
        scanned: rows.length,
        applied,
        suggested,
        skipped_frozen: skippedFrozen,
        reported: reported.length,
      });
      return { ok: true, governance_run_id: run.id, scanned: rows.length, applied, suggested, skipped_frozen: skippedFrozen, reported };
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    await database.close();
  }
}

function resolveRowRootCauseType(
  rootCauseType: string | null,
  rootCause: string | null,
  details: JsonObject,
  memoryId: string | null
): RecallRepairRootCauseType {
  return normalizeRecallRepairRootCauseType(rootCauseType) ??
    normalizeRecallRepairRootCauseType(details.root_cause_type) ??
    normalizeRecallRepairRootCauseType(rootCause) ??
    resolveRecallRepairRootCauseType({ details, memoryId });
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
