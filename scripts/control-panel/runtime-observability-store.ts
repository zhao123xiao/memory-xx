import { randomUUID } from "node:crypto";

import { closePool, createPool, query } from "../test-harness/lib/db-helpers.js";
import type { RuntimeSnapshot } from "./runtime-snapshot.js";
import {
  buildRuntimeObservabilityRows,
  runtimeObsNumberValue,
  runtimeObsStableId,
  runtimeObsText,
} from "./runtime-observability-rows.js";
import {
  buildRuntimeObservabilityRetentionPlan,
  type RuntimeObservabilityRetentionPlan,
  type RuntimeObservabilityRetentionPolicy,
  type RuntimeObservabilityRetentionResult,
} from "./runtime-observability-retention.js";
import { stringValue, tableName } from "./utils.js";

export { buildRuntimeObservabilityRetentionPlan };
export type {
  RuntimeObservabilityRetentionPlan,
  RuntimeObservabilityRetentionPolicy,
  RuntimeObservabilityRetentionResult,
};

async function countRetentionCandidates(schema: string, policy: RuntimeObservabilityRetentionPolicy): Promise<number> {
  const pool = createPool();
  try {
    if (policy.table === "code_graph_project_snapshots") {
      const result = await query(pool, `
        WITH ranked AS (
          SELECT snapshot_id,
            row_number() OVER (PARTITION BY project_id ORDER BY generated_at DESC) AS project_rank
          FROM ${tableName(schema, policy.table)}
        )
        SELECT count(*)::int AS count
        FROM ${tableName(schema, policy.table)} snapshots
        JOIN ranked USING (snapshot_id)
        WHERE snapshots.generated_at < now() - ($1::int * interval '1 day')
          AND ranked.project_rank > $2::int
      `, [policy.retention_days, policy.keep_latest_per_project ?? 20]);
      return Number(result.rows[0]?.count ?? 0);
    }
    const result = await query(pool, `
      SELECT count(*)::int AS count
      FROM ${tableName(schema, policy.table)}
      WHERE ${policy.timestamp_column} < now() - ($1::int * interval '1 day')
    `, [policy.retention_days]);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await closePool(pool);
  }
}

async function deleteRetentionCandidates(schema: string, policy: RuntimeObservabilityRetentionPolicy): Promise<number> {
  const pool = createPool();
  try {
    if (policy.table === "code_graph_project_snapshots") {
      const result = await query(pool, `
        WITH ranked AS (
          SELECT snapshot_id,
            row_number() OVER (PARTITION BY project_id ORDER BY generated_at DESC) AS project_rank
          FROM ${tableName(schema, policy.table)}
        ),
        deleted AS (
          DELETE FROM ${tableName(schema, policy.table)} snapshots
          USING ranked
          WHERE snapshots.snapshot_id = ranked.snapshot_id
            AND snapshots.generated_at < now() - ($1::int * interval '1 day')
            AND ranked.project_rank > $2::int
          RETURNING snapshots.snapshot_id
        )
        SELECT count(*)::int AS count FROM deleted
      `, [policy.retention_days, policy.keep_latest_per_project ?? 20]);
      return Number(result.rows[0]?.count ?? 0);
    }
    const result = await query(pool, `
      WITH deleted AS (
        DELETE FROM ${tableName(schema, policy.table)}
        WHERE ${policy.timestamp_column} < now() - ($1::int * interval '1 day')
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `, [policy.retention_days]);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await closePool(pool);
  }
}

export async function pruneRuntimeObservabilityRetention(input: {
  readonly schema: string;
  readonly apply?: boolean;
  readonly plan?: RuntimeObservabilityRetentionPlan;
}): Promise<RuntimeObservabilityRetentionResult> {
  const plan = input.plan ?? buildRuntimeObservabilityRetentionPlan();
  const candidates: {
    table: string;
    candidate_count: number;
    retention_days: number;
    deleted?: number;
  }[] = [];
  for (const policy of plan.policies) {
    const candidateCount = await countRetentionCandidates(input.schema, policy);
    const deleted = input.apply ? await deleteRetentionCandidates(input.schema, policy) : undefined;
    candidates.push({
      table: policy.table,
      candidate_count: candidateCount,
      retention_days: policy.retention_days,
      ...(deleted === undefined ? {} : { deleted }),
    });
  }
  return {
    ok: true,
    mode: input.apply ? "apply" : "dry_run",
    plan,
    candidates,
  };
}

export async function persistRuntimeObservabilitySnapshot(snapshot: RuntimeSnapshot, schema: string): Promise<void> {
  const rows = buildRuntimeObservabilityRows(snapshot);
  const pool = createPool();
  try {
    for (const row of rows.agents) {
      await query(pool, `
        INSERT INTO ${tableName(schema, "runtime_agent_connections")} (
          connection_id, agent_id, identity_source, transport, endpoint, first_seen_at, last_seen_at,
          request_count, methods, permissions, remote_address, user_agent, client_name, last_status,
          last_error, metadata, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::text[],$11,$12,$13,$14,$15,$16::jsonb,now())
        ON CONFLICT (connection_id) DO UPDATE SET
          agent_id = EXCLUDED.agent_id,
          identity_source = EXCLUDED.identity_source,
          transport = EXCLUDED.transport,
          endpoint = EXCLUDED.endpoint,
          first_seen_at = LEAST(${tableName(schema, "runtime_agent_connections")}.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(${tableName(schema, "runtime_agent_connections")}.last_seen_at, EXCLUDED.last_seen_at),
          request_count = GREATEST(${tableName(schema, "runtime_agent_connections")}.request_count, EXCLUDED.request_count),
          methods = EXCLUDED.methods,
          permissions = EXCLUDED.permissions,
          remote_address = EXCLUDED.remote_address,
          user_agent = EXCLUDED.user_agent,
          client_name = EXCLUDED.client_name,
          last_status = EXCLUDED.last_status,
          last_error = EXCLUDED.last_error,
          metadata = EXCLUDED.metadata,
          updated_at = now()
      `, [
        row.connection_id,
        row.agent_id,
        row.identity_source,
        row.transport,
        row.endpoint,
        row.first_seen_at,
        row.last_seen_at,
        row.request_count,
        row.methods,
        row.permissions,
        row.remote_address ?? null,
        row.user_agent ?? null,
        row.client_name ?? null,
        row.last_status ?? null,
        row.last_error ?? null,
        JSON.stringify(row.metadata),
      ]);
    }
    for (const row of rows.tools) {
      await query(pool, `
        INSERT INTO ${tableName(schema, "runtime_tool_invocations")} (
          tool_name, call_count, success_count, failure_count, latency_total_ms, latency_max_ms,
          last_latency_ms, last_seen_at, last_error, agents, metadata, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11::jsonb,now())
        ON CONFLICT (tool_name) DO UPDATE SET
          call_count = GREATEST(${tableName(schema, "runtime_tool_invocations")}.call_count, EXCLUDED.call_count),
          success_count = GREATEST(${tableName(schema, "runtime_tool_invocations")}.success_count, EXCLUDED.success_count),
          failure_count = GREATEST(${tableName(schema, "runtime_tool_invocations")}.failure_count, EXCLUDED.failure_count),
          latency_total_ms = GREATEST(${tableName(schema, "runtime_tool_invocations")}.latency_total_ms, EXCLUDED.latency_total_ms),
          latency_max_ms = GREATEST(${tableName(schema, "runtime_tool_invocations")}.latency_max_ms, EXCLUDED.latency_max_ms),
          last_latency_ms = EXCLUDED.last_latency_ms,
          last_seen_at = GREATEST(${tableName(schema, "runtime_tool_invocations")}.last_seen_at, EXCLUDED.last_seen_at),
          last_error = COALESCE(EXCLUDED.last_error, ${tableName(schema, "runtime_tool_invocations")}.last_error),
          agents = EXCLUDED.agents,
          metadata = EXCLUDED.metadata,
          updated_at = now()
      `, [
        row.tool_name,
        row.call_count,
        row.success_count,
        row.failure_count,
        row.latency_total_ms,
        row.latency_max_ms,
        row.last_latency_ms,
        row.last_seen_at,
        row.last_error ?? null,
        row.agents,
        JSON.stringify(row.metadata),
      ]);
    }
    for (const row of rows.components) {
      await query(pool, `
        INSERT INTO ${tableName(schema, "runtime_component_snapshots")} (
          component_snapshot_id, snapshot_id, collected_at, component_name, label, status,
          detail, source, remediation, metadata
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        ON CONFLICT (component_snapshot_id) DO NOTHING
      `, [
        row.component_snapshot_id,
        row.snapshot_id,
        row.collected_at,
        row.component_name,
        row.label,
        row.status,
        row.detail,
        row.source,
        row.remediation ?? null,
        JSON.stringify(row.metadata),
      ]);
    }
    for (const row of rows.settings) {
      await query(pool, `
        INSERT INTO ${tableName(schema, "runtime_setting_effective_values")} (
          setting_key, category, label, effective_value, default_value, source, effect_status,
          safety, service, unit, writable, last_observed_at, metadata
        )
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT (setting_key) DO UPDATE SET
          category = EXCLUDED.category,
          label = EXCLUDED.label,
          effective_value = EXCLUDED.effective_value,
          default_value = EXCLUDED.default_value,
          source = EXCLUDED.source,
          effect_status = EXCLUDED.effect_status,
          safety = EXCLUDED.safety,
          service = EXCLUDED.service,
          unit = EXCLUDED.unit,
          writable = EXCLUDED.writable,
          last_observed_at = EXCLUDED.last_observed_at,
          metadata = EXCLUDED.metadata
      `, [
        row.setting_key,
        row.category,
        row.label,
        JSON.stringify(row.effective_value),
        JSON.stringify(row.default_value),
        row.source,
        row.effect_status,
        row.safety,
        row.service ?? null,
        row.unit ?? null,
        row.writable,
        row.last_observed_at,
        JSON.stringify(row.metadata),
      ]);
    }
  } finally {
    await closePool(pool);
  }
}

export async function loadRuntimeAgentConnections(schema: string): Promise<Record<string, unknown> | null> {
  const pool = createPool();
  try {
    const result = await query(pool, `
      SELECT *
      FROM ${tableName(schema, "runtime_agent_connections")}
      ORDER BY last_seen_at DESC
      LIMIT 200
    `);
    return {
      updated_at: result.rows[0]?.updated_at ?? null,
      connections: result.rows,
    };
  } catch {
    return null;
  } finally {
    await closePool(pool);
  }
}

export async function loadRuntimeToolInvocations(schema: string): Promise<Record<string, unknown> | null> {
  const pool = createPool();
  try {
    const result = await query(pool, `
      SELECT *
      FROM ${tableName(schema, "runtime_tool_invocations")}
      ORDER BY last_seen_at DESC
      LIMIT 200
    `);
    return {
      updated_at: result.rows[0]?.updated_at ?? null,
      tools: result.rows,
    };
  } catch {
    return null;
  } finally {
    await closePool(pool);
  }
}

export async function loadRuntimeComponentSnapshots(schema: string): Promise<readonly Record<string, unknown>[] | null> {
  const pool = createPool();
  try {
    const result = await query(pool, `
      SELECT DISTINCT ON (component_name)
        component_name AS name,
        label,
        status,
        detail,
        source,
        remediation,
        collected_at
      FROM ${tableName(schema, "runtime_component_snapshots")}
      ORDER BY component_name, collected_at DESC
    `);
    return result.rows;
  } catch {
    return null;
  } finally {
    await closePool(pool);
  }
}

export async function persistCodeGraphProjectSnapshot(input: {
  readonly schema: string;
  readonly summary: Record<string, unknown>;
  readonly diff?: Record<string, unknown>;
  readonly dryRun?: boolean;
}): Promise<void> {
  const summary = input.summary;
  const projectId = runtimeObsText(summary.project_id ?? summary.code_graph_project_id, "current");
  const snapshotId = runtimeObsText(summary.snapshot_id, `code_graph_snapshot_${randomUUID()}`);
  const root = runtimeObsText(summary.root, process.cwd());
  const generatedAt = runtimeObsText(summary.generated_at, new Date().toISOString());
  const pool = createPool();
  try {
    await query(pool, `
      INSERT INTO ${tableName(input.schema, "code_graph_project_snapshots")} (
        snapshot_id, project_id, root, commit_hash, generated_at, file_count, symbol_count,
        edge_count, code_graph_scope, summary, diff, dry_run, writes_global
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)
      ON CONFLICT (snapshot_id) DO UPDATE SET
        generated_at = EXCLUDED.generated_at,
        file_count = EXCLUDED.file_count,
        symbol_count = EXCLUDED.symbol_count,
        edge_count = EXCLUDED.edge_count,
        summary = EXCLUDED.summary,
        diff = EXCLUDED.diff,
        dry_run = EXCLUDED.dry_run,
        writes_global = EXCLUDED.writes_global
    `, [
      snapshotId,
      projectId,
      root,
      stringValue(summary.commit_hash ?? summary.commit) || null,
      generatedAt,
      runtimeObsNumberValue(summary.file_count),
      runtimeObsNumberValue(summary.symbol_count),
      runtimeObsNumberValue(summary.edge_count),
      runtimeObsText(summary.code_graph_scope, `project:${projectId}:code-graph`),
      JSON.stringify(summary),
      JSON.stringify(input.diff ?? {}),
      input.dryRun !== false,
      false,
    ]);
  } finally {
    await closePool(pool);
  }
}

export async function loadCodeGraphProjectSnapshots(schema: string, projectId: string): Promise<readonly Record<string, unknown>[] | null> {
  const pool = createPool();
  try {
    const result = await query(pool, `
      SELECT *
      FROM ${tableName(schema, "code_graph_project_snapshots")}
      WHERE project_id = $1
      ORDER BY generated_at DESC
      LIMIT 20
    `, [projectId]);
    return result.rows;
  } catch {
    return null;
  } finally {
    await closePool(pool);
  }
}

export async function persistOpsAdvisorReport(input: {
  readonly schema: string;
  readonly advisorType: string;
  readonly report: Record<string, unknown>;
}): Promise<void> {
  const report = input.report;
  const recommendations = Array.isArray(report.recommendations) ? report.recommendations as readonly Record<string, unknown>[] : [];
  const reportId = runtimeObsText(report.run_id ?? report.report_id, `ops_advisor_${runtimeObsStableId(input.advisorType, report.generated_at, JSON.stringify(recommendations))}`);
  const pool = createPool();
  try {
    await query(pool, `
      INSERT INTO ${tableName(input.schema, "ops_advisor_reports")} (
        report_id, generated_at, advisor_type, mode, status, recommendation_count, high_risk_count, report
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT (report_id) DO UPDATE SET
        generated_at = EXCLUDED.generated_at,
        mode = EXCLUDED.mode,
        status = EXCLUDED.status,
        recommendation_count = EXCLUDED.recommendation_count,
        high_risk_count = EXCLUDED.high_risk_count,
        report = EXCLUDED.report
    `, [
      reportId,
      runtimeObsText(report.generated_at, new Date().toISOString()),
      input.advisorType,
      runtimeObsText(report.mode, "report_only"),
      runtimeObsText(report.status, "reported"),
      recommendations.length,
      recommendations.filter((item) => item.severity === "high-risk" || item.risk === "high-risk").length,
      JSON.stringify(report),
    ]);
  } finally {
    await closePool(pool);
  }
}
