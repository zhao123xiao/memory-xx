import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  readAutoApprovalRuntimeControlsSync,
} from "../../app/governance/auto-approval-runtime-controls.js";
import { config } from "../test-harness/config.js";
import { closePool, createPool, query } from "../test-harness/lib/db-helpers.js";
import { objectValue, safeText, tableName } from "./utils.js";

interface FlowStep {
  readonly name: string;
  readonly status: "complete" | "waiting" | "degraded" | "failed";
  readonly detail?: string;
  readonly data?: unknown;
}

function table(name: string): string {
  return tableName(config.dbSchema, name);
}

function flowStep(name: string, condition: boolean, detail?: string, data?: unknown): FlowStep {
  return { name, status: condition ? "complete" : "waiting", detail, data };
}

async function qdrantMemoryProjectionStatus(memoryId: string): Promise<Record<string, unknown>> {
  const baseUrl = config.qdrantUrl.replace(/\/+$/, "");
  const collection = config.qdrantCollection;
  if (!baseUrl || !collection || !memoryId) {
    return { configured: false, found: false, reason: "qdrant_not_configured" };
  }
  try {
    const response = await fetch(`${baseUrl}/collections/${encodeURIComponent(collection)}/points/scroll`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.MEMORY_XX_QDRANT_API_KEY?.trim() ? { "api-key": process.env.MEMORY_XX_QDRANT_API_KEY.trim() } : {}),
      },
      body: JSON.stringify({
        limit: 1,
        with_payload: true,
        with_vector: false,
        filter: { must: [{ key: "memory_id", match: { value: memoryId } }] },
      }),
      signal: AbortSignal.timeout(3000),
    });
    const body = await response.json().catch(() => ({}));
    const points = Array.isArray((body as any).result?.points) ? (body as any).result.points : [];
    return {
      configured: true,
      ok: response.ok,
      status: response.status,
      found: points.length > 0,
      point: points[0] ?? null,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      found: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readRuntimeJson(filename: string): Promise<Record<string, unknown> | null> {
  const runtimeDir = process.env.MEMORY_XX_RUNTIME_DIR?.trim() || path.join(process.cwd(), ".runtime");
  try {
    return JSON.parse(await readFile(path.join(runtimeDir, filename), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readLatestJsonReport(relativeDir: string): Promise<Record<string, unknown> | null> {
  const dir = path.join(process.cwd(), "reports", relativeDir);
  try {
    const entries = await readdir(dir);
    const candidates = await Promise.all(entries
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const fullPath = path.join(dir, name);
        const info = await stat(fullPath);
        return { fullPath, name, mtimeMs: info.mtimeMs };
      }));
    const latest = candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
    if (!latest) return null;
    const parsed = JSON.parse(await readFile(latest.fullPath, "utf8")) as Record<string, unknown>;
    return { ...parsed, report_path: latest.fullPath, report_name: latest.name };
  } catch {
    return null;
  }
}

export async function buildRecentFlows(limit: number, filters: { type?: string; priority?: string; status?: string } = {}): Promise<Record<string, unknown>> {
  const pool = createPool();
  try {
    const capped = Math.max(1, Math.min(100, limit));
    const writes = await query(pool, `
      SELECT mr.id AS memory_id, mr.request_id, mr.title, mr.scope_type, mr.scope_id,
             mr.lifecycle_status, mr.review_state, mr.updated_at, ir.actor_id, ir.status AS ingest_status
      FROM ${table("memory_records")} mr
      LEFT JOIN ${table("ingest_requests")} ir ON ir.request_id = mr.request_id
      ORDER BY mr.updated_at DESC
      LIMIT $1
    `, [capped]);
    const recalls = await query(pool, `
      SELECT id AS trace_id, query_excerpt, query_type, strategy, degrade_level, created_at,
             audit -> 'rerank' AS rerank, audit ->> 'primary_backend' AS primary_backend
      FROM ${table("recall_traces")}
      ORDER BY created_at DESC
      LIMIT $1
    `, [capped]);
    const opsWhere: string[] = [
      "scope_type = 'project'",
      "scope_id = 'memory-xx-self-improvement'",
      "is_current IS TRUE",
    ];
    const opsParams: unknown[] = [Math.min(capped, 20)];
    if (filters.type) {
      opsParams.push(filters.type);
      opsWhere.push(`metadata #>> '{self_improvement,type}' = $${opsParams.length}`);
    }
    if (filters.priority) {
      opsParams.push(filters.priority);
      opsWhere.push(`metadata #>> '{self_improvement,priority}' = $${opsParams.length}`);
    }
    if (filters.status) {
      opsParams.push(filters.status);
      opsWhere.push(`metadata #>> '{self_improvement,status}' = $${opsParams.length}`);
    }
    const ops = await query(pool, `
      SELECT id AS memory_id, title, content, lifecycle_status, review_state, updated_at,
             metadata #> '{self_improvement}' AS self_improvement,
             metadata #>> '{self_improvement,type}' AS self_improvement_type,
             metadata #>> '{self_improvement,priority}' AS self_improvement_priority,
             metadata #>> '{self_improvement,status}' AS self_improvement_status,
             metadata #>> '{self_improvement,pattern_key}' AS self_improvement_pattern_key,
             metadata #>> '{self_improvement,recurrence_count}' AS self_improvement_recurrence_count,
             metadata #>> '{self_improvement,promotion_candidate}' AS self_improvement_promotion_candidate
      FROM ${table("memory_records")}
      WHERE ${opsWhere.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $1
    `, opsParams);
    const autoApproval = await query(pool, `
      SELECT id, candidate_memory_id, approved_memory_id, decision, policy_version, score,
             reasons, blocked_reasons, agent_id, scope_type, scope_id, metadata,
             rollback_memory_event_id, created_at
      FROM ${table("auto_approval_decisions")}
      ORDER BY created_at DESC
      LIMIT $1
    `, [Math.min(capped, 30)]).catch(async () => {
      const fallback = await query(pool, `
        SELECT id, memory_id AS approved_memory_id, evidence ->> 'decision' AS decision,
               evidence ->> 'policy_version' AS policy_version,
               (evidence ->> 'score')::float AS score,
               evidence -> 'reasons' AS reasons,
               evidence -> 'blocked_reasons' AS blocked_reasons,
               selector ->> 'agent_id' AS agent_id,
               scope_type, scope_id, evidence AS metadata, created_at
        FROM ${table("memory_governance_actions")}
        WHERE action_type = 'auto_approval_decision'
        ORDER BY created_at DESC
        LIMIT $1
      `, [Math.min(capped, 30)]).catch((error) => ({ rows: [], error: error instanceof Error ? error.message : String(error) }));
      return fallback;
    });
    const autoApprovalSummary = await query(pool, `
      SELECT
        count(*) FILTER (WHERE decision = 'approve')::int AS approved_24h,
        count(*) FILTER (WHERE decision <> 'approve')::int AS blocked_24h,
        count(*) FILTER (WHERE rollback_memory_event_id IS NOT NULL)::int AS rollback_count_24h
      FROM ${table("auto_approval_decisions")}
      WHERE created_at >= now() - interval '24 hours'
    `).catch(() => ({ rows: [{ approved_24h: 0, blocked_24h: 0, rollback_count_24h: 0 }] }));
    const frozenCohorts = await query(pool, `
      SELECT selector, metadata, expires_at, updated_at
      FROM ${table("governance_policy_overrides")}
      WHERE policy_type = 'silent_approve'
        AND auto_approve_enabled IS FALSE
        AND expires_at > now()
      ORDER BY updated_at DESC
      LIMIT 20
    `).catch(() => ({ rows: [] }));
    const feedbackMetrics = await query(pool, `
      SELECT selector,
             metadata->>'freeze_trigger' AS freeze_trigger,
             metadata->'freeze_triggered_by' AS freeze_triggered_by,
             (metadata->>'approval_rate')::float AS approval_rate,
             (metadata->>'false_positive_rate')::float AS false_positive_rate,
             (metadata->>'rollback_rate')::float AS rollback_rate,
             (metadata->>'manual_archive_delete_rate')::float AS manual_archive_delete_rate,
             (metadata->>'recall_negative_feedback_rate')::float AS recall_negative_feedback_rate,
             (metadata->>'clean_run_count')::int AS clean_run_count,
             metadata,
             updated_at
      FROM ${table("governance_policy_overrides")}
      WHERE policy_type = 'silent_approve'
      ORDER BY updated_at DESC
      LIMIT 20
    `).catch(() => ({ rows: [] }));
    const healthSnapshots = await query(pool, `
      SELECT metadata->'auto_approval_health_snapshot' AS health_snapshot,
             metadata #> '{auto_approval_policy,operational_blockers}' AS operational_blockers,
             created_at
      FROM ${table("auto_approval_decisions")}
      WHERE metadata ? 'auto_approval_health_snapshot'
      ORDER BY created_at DESC
      LIMIT 20
    `).catch(() => ({ rows: [] }));
    const healthBlockers = healthSnapshots.rows.flatMap((row: Record<string, unknown>) => {
      const snapshot = row.health_snapshot as Record<string, unknown> | null;
      const blockers = Array.isArray(snapshot?.blockers) ? snapshot.blockers : Array.isArray(row.operational_blockers) ? row.operational_blockers : [];
      return blockers.map((blocker) => String(blocker));
    });
    const healthWarnings = healthSnapshots.rows.flatMap((row: Record<string, unknown>) => {
      const snapshot = row.health_snapshot as Record<string, unknown> | null;
      return Array.isArray(snapshot?.warnings) ? snapshot.warnings.map((warning) => String(warning)) : [];
    });
    return {
      writes: writes.rows,
      recalls: recalls.rows,
      ops_intelligence: ops.rows,
      auto_approval: autoApproval.rows,
      auto_approval_summary: {
        ...(autoApprovalSummary.rows[0] ?? {}),
        runtime_controls: readAutoApprovalRuntimeControlsSync(),
        canary: await readRuntimeJson("auto-approval-canary.json"),
        candidate_only_flag: await readRuntimeJson("intelligence-candidate-only.json"),
        feedback_metrics: feedbackMetrics.rows,
        health_blockers: [...new Set(healthBlockers)],
        health_warnings: [...new Set(healthWarnings)],
        latest_health_snapshots: healthSnapshots.rows,
        frozen_cohorts: frozenCohorts.rows,
        latest_random_corpus_report: await readLatestJsonReport("auto-approval-random-corpus"),
        latest_test_scope_e2e_report: await readLatestJsonReport("auto-approval-test-scope-e2e"),
        latest_canary_e2e_report: await readLatestJsonReport("auto-approval-canary-e2e"),
        latest_feedback_freeze_report: await readLatestJsonReport("auto-approval-feedback-freeze"),
        latest_scope_matrix_report: await readLatestJsonReport("auto-approval-scope-matrix"),
        latest_privacy_corpus_report: await readLatestJsonReport("auto-approval-privacy-corpus"),
        latest_temporal_corpus_report: await readLatestJsonReport("auto-approval-temporal-corpus"),
        latest_auto_update_report: await readLatestJsonReport("auto-update-corpus"),
        latest_auto_update_real_project_guarded_report: await readLatestJsonReport("auto-update-real-project-guarded-e2e"),
        latest_production_closure_report: await readLatestJsonReport("auto-approval-production-closure"),
      },
    };
  } finally {
    await closePool(pool);
  }
}

export async function buildWriteFlow(url: URL): Promise<Record<string, unknown>> {
  const memoryId = safeText(url.searchParams.get("memoryId"), 220);
  const requestId = safeText(url.searchParams.get("requestId"), 220);
  if (!memoryId && !requestId) return { error: "缺少必填字段：memoryId（记忆 ID）或 requestId（请求 ID）" };
  const pool = createPool();
  try {
    const records = await query(pool, `
      SELECT mr.*, ir.actor_id, ir.status AS ingest_status, ir.payload_json, ir.result_json,
             ir.error_code, ir.error_message, ir.first_seen_at, ir.completed_at
      FROM ${table("memory_records")} mr
      LEFT JOIN ${table("ingest_requests")} ir ON ir.request_id = mr.request_id
      WHERE ($1::text <> '' AND mr.id = $1)
         OR ($2::text <> '' AND mr.request_id = $2)
      ORDER BY mr.updated_at DESC
      LIMIT 5
    `, [memoryId, requestId]);
    const record = records.rows[0] ?? null;
    const effectiveMemoryId = String(record?.id ?? memoryId);
    const effectiveRequestId = String(record?.request_id ?? requestId);
    const [events, outbox, tickets] = await Promise.all([
      query(pool, `SELECT * FROM ${table("memory_events")} WHERE ($1::text <> '' AND memory_id = $1) OR ($2::text <> '' AND request_id = $2) ORDER BY created_at ASC`, [effectiveMemoryId, effectiveRequestId]),
      query(pool, `SELECT * FROM ${table("outbox_events")} WHERE ($1::text <> '' AND aggregate_id = $1) OR ($2::text <> '' AND request_id = $2) ORDER BY created_at ASC`, [effectiveMemoryId, effectiveRequestId]),
      query(pool, `SELECT * FROM ${table("write_tickets")} WHERE ($1::text = '' OR created_memory_id = $1 OR candidate_memory_id = $1 OR duplicate_of_memory_id = $1) ORDER BY created_at DESC LIMIT 5`, [effectiveMemoryId]).catch(() => ({ rows: [] })),
    ]);
    const qdrant = effectiveMemoryId ? await qdrantMemoryProjectionStatus(effectiveMemoryId) : { found: false, reason: "memory_id_missing" };
    const steps: FlowStep[] = [
      flowStep("智能写入/MCP 请求（smart_write/MCP request）", Boolean(record?.request_id), record?.request_id, record?.payload_json),
      flowStep("记忆抽取（mem0/native extraction）", Boolean(record?.metadata), String(record?.metadata?.source ?? "unknown"), record?.metadata),
      flowStep("候选记忆记录（candidate record）", Boolean(record), record ? `${record.lifecycle_status}/${record.review_state}` : undefined, record),
      flowStep("审批状态（approval state）", record?.lifecycle_status === "approved", record ? `${record.lifecycle_status}/${record.review_state}` : undefined),
      flowStep("记忆事件（memory events）", events.rows.length > 0, `${events.rows.length} events`, events.rows),
      flowStep("投影队列/投影器（outbox/projector）", outbox.rows.length > 0, `${outbox.rows.length} outbox events`, outbox.rows),
      {
        name: "向量库投影（Qdrant projection）",
        status: (qdrant as any).found ? "complete" : "waiting",
        detail: (qdrant as any).found ? "projected" : String((qdrant as any).reason ?? (qdrant as any).error ?? "not_found"),
        data: qdrant,
      },
      flowStep("可召回状态（recallable）", record?.lifecycle_status === "approved" && record?.is_current === true, record ? `${record.scope_type}:${record.scope_id}` : undefined),
    ];
    return { record, events: events.rows, outbox: outbox.rows, tickets: tickets.rows, qdrant, steps };
  } finally {
    await closePool(pool);
  }
}

export async function buildRecallFlow(url: URL): Promise<Record<string, unknown>> {
  const traceId = safeText(url.searchParams.get("traceId"), 220);
  if (!traceId) return { error: "缺少必填字段：traceId（召回轨迹 ID）" };
  const pool = createPool();
  try {
    const traces = await query(pool, `SELECT * FROM ${table("recall_traces")} WHERE id = $1 LIMIT 1`, [traceId]);
    const trace = traces.rows[0] ?? null;
    const audit = objectValue(trace?.audit);
    const results = objectValue(trace?.results);
    const retrieval = objectValue(audit.fusion);
    const steps: FlowStep[] = [
      flowStep("scope resolution", Boolean(trace?.scope_context), undefined, trace?.scope_context),
      flowStep("query classification", Boolean(trace?.query_type), String(trace?.query_type), { strategy: trace?.strategy }),
      flowStep("lexical/vector/graph recall", true, `lexical=${audit.lexical_hits ?? 0}, vector=${audit.vector_hits ?? 0}, graph=${audit.graph_hits ?? 0}`, audit),
      flowStep("RRF fusion", Boolean(audit.fusion), `merged=${audit.merged_hits ?? "?"}`, retrieval),
      flowStep("local rerank", Boolean(audit.rerank), String(objectValue(audit.rerank).backend ?? "unknown"), audit.rerank),
      {
        name: "model rerank",
        status: objectValue(audit.rerank).model_used === true ? "complete" : "degraded",
        detail: String(objectValue(audit.rerank).reason ?? objectValue(audit.rerank).backend ?? "unknown"),
        data: audit.rerank,
      },
      flowStep("confidence/null guard", Boolean(audit.confidence_gate ?? audit.null_guard), undefined, audit.confidence_gate ?? audit.null_guard),
      flowStep("final top results", Boolean(results), `returned=${audit.returned_hits ?? "?"}`, results),
    ];
    return { trace, steps };
  } finally {
    await closePool(pool);
  }
}
