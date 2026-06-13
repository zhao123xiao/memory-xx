import { createHash } from "node:crypto";

import "./test-harness/config.js";
import { MemoryEventRepository, OutboxEventRepository, OutboxEventType, PostgresWriteDatabase, loadMemoryXXPostgresConfig, withWriteTransaction, type JsonObject } from "../app";
import { requireCliPermission } from "../app/server/permissions.js";

function readArg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main(): Promise<void> {
  await requireCliPermission("memory:governance_revert");
  const actionId = readArg("action-id");
  const token = readArg("token");
  if (!actionId || !token) throw new Error("--action-id and --token are required");
  const database = new PostgresWriteDatabase({ config: loadMemoryXXPostgresConfig(process.env) });
  try {
    const result = await withWriteTransaction(database, async (tx) => {
      const [action] = await tx.query<{
        id: string;
        memory_id: string | null;
        action_type: string;
        before_state: JsonObject;
        revert_expires_at: Date | string | null;
        reverted_at: Date | string | null;
        revert_token_hash: string | null;
      }>(
        `
          SELECT *
          FROM memory_governance_actions
          WHERE id = $1
          FOR UPDATE
        `,
        [actionId]
      );
      if (!action) throw new Error("governance_action_not_found");
      if (!action.memory_id) throw new Error("governance_action_has_no_memory");
      if (action.reverted_at) throw new Error("governance_action_already_reverted");
      if (!action.revert_token_hash || action.revert_token_hash !== sha256(token)) throw new Error("invalid_revert_token");
      if (!action.revert_expires_at || new Date(action.revert_expires_at).getTime() < Date.now()) throw new Error("revert_token_expired");

      const before = action.before_state ?? {};
      const lifecycleStatus = typeof before.lifecycle_status === "string" ? before.lifecycle_status : "approved";
      const reviewState = typeof before.review_state === "string" ? before.review_state : "not_required";
      const isCurrent = typeof before.is_current === "boolean" ? before.is_current : true;
      const [memory] = await tx.query<{ id: string; request_id: string; scope_type: string; scope_id: string }>(
        `
          UPDATE memory_records
          SET lifecycle_status = $2,
              review_state = $3,
              is_current = $4,
              updated_at = $5::timestamptz,
              updated_by = 'memory-governance-revert'
          WHERE id = $1
          RETURNING id, request_id, scope_type, scope_id
        `,
        [action.memory_id, lifecycleStatus, reviewState, isCurrent, tx.now()]
      );
      if (!memory) throw new Error("memory_not_found");

      const payload = {
        memoryId: memory.id,
        requestId: memory.request_id,
        revertedGovernanceActionId: action.id,
        previousGovernanceActionType: action.action_type,
        lifecycleStatus,
        reviewState,
        isCurrent,
        scopeType: memory.scope_type,
        scopeId: memory.scope_id,
      } as const;
      const memoryEvent = await new MemoryEventRepository().append(tx, {
        memoryId: memory.id,
        requestId: memory.request_id,
        eventType: OutboxEventType.MemoryLifecycleChanged,
        actorId: "memory-governance-revert",
        payload,
      });
      const outboxEvent = await new OutboxEventRepository().append(tx, {
        aggregateId: memory.id,
        requestId: memory.request_id,
        eventType: OutboxEventType.MemoryLifecycleChanged,
        payload,
      });
      await tx.query(
        `
          UPDATE memory_governance_actions
          SET reverted_at = $2::timestamptz,
              status = 'reverted',
              after_state = after_state || $3::jsonb,
              outbox_event_ids = outbox_event_ids || $4::jsonb
          WHERE id = $1
        `,
        [
          action.id,
          tx.now(),
          JSON.stringify({ reverted_memory_event_id: memoryEvent.id }),
          JSON.stringify([outboxEvent.id]),
        ]
      );
      return { ok: true, action_id: action.id, memory_id: memory.id, memory_event_id: memoryEvent.id, outbox_event_id: outboxEvent.id };
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
