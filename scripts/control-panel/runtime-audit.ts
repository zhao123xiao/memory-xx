import { randomUUID } from "node:crypto";

import { closePool, createPool, query } from "../test-harness/lib/db-helpers.js";
import { tableName } from "./utils.js";
import type { SettingsPreview } from "./settings.js";

export async function recordRuntimeSettingsAudit(input: {
  readonly schema: string;
  readonly actionType: "runtime_settings_update" | "runtime_settings_reset";
  readonly actor?: string;
  readonly preview?: SettingsPreview;
  readonly keys?: readonly string[];
  readonly status?: "reported" | "applied" | "skipped" | "reverted" | "failed";
  readonly error?: string;
}): Promise<void> {
  const pool = createPool();
  const now = new Date().toISOString();
  const changes = input.preview?.changes ?? [];
  try {
    await query(pool, `
      INSERT INTO ${tableName(input.schema, "memory_governance_actions")} (
        id,
        action_type,
        selector,
        evidence,
        before_state,
        after_state,
        status,
        created_by,
        created_at
      )
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)
    `, [
      `runtime_settings_${randomUUID()}`,
      input.actionType,
      JSON.stringify({
        category: "runtime_control_plane",
        keys: input.keys ?? changes.map((change) => change.key),
      }),
      JSON.stringify({
        generated_at: now,
        preview: input.preview ?? null,
        high_risk_count: input.preview?.high_risk_count ?? 0,
        restart_required_count: input.preview?.restart_required_count ?? 0,
        services_to_restart: input.preview?.services_to_restart ?? [],
        error: input.error ?? null,
      }),
      JSON.stringify(Object.fromEntries(changes.map((change) => [change.key, change.before]))),
      JSON.stringify(Object.fromEntries(changes.map((change) => [change.key, change.after]))),
      input.status ?? "applied",
      input.actor ?? "memory-control-panel",
      now,
    ]);
  } finally {
    await closePool(pool);
  }
}
