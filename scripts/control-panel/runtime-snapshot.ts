import { randomUUID } from "node:crypto";

import { closePool, createPool, query } from "../test-harness/lib/db-helpers.js";
import { config } from "../test-harness/config.js";
import { readMemoryClientConnections } from "../../app/observability/client-connections.js";
import { readMcpToolInvocationMetrics } from "../../app/observability/mcp-tool-invocations.js";
import { buildDatabaseMaintenanceSummary } from "./database-maintenance.js";
import { persistRuntimeObservabilitySnapshot } from "./runtime-observability-store.js";
import { serviceControls } from "./service-controls.js";
import { buildRuntimeRegistry, restartPlan } from "./settings.js";
import { buildRuntimeModuleSnapshot } from "../../app/runtime-modules.js";
import { parseMemoryRuntimeProfile } from "../../app/runtime-profiles.js";
import { buildComponentStatusesFromRuntimeModules } from "../../app/runtime-module-components.js";

export interface RuntimeSnapshot {
  readonly snapshot_id: string;
  readonly collected_at: string;
  readonly status: "ok" | "degraded" | "blocked" | "unknown";
  readonly summary: Record<string, unknown>;
  readonly metrics: Record<string, unknown>;
  readonly registry: readonly unknown[];
}

interface ComponentStatus {
  readonly name: string;
  readonly label: string;
  readonly status: "ok" | "degraded" | "blocked" | "unknown";
  readonly detail: string;
  readonly source: string;
  readonly remediation?: string;
}

async function wrapperHealth(): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (config.wrapperToken) {
    headers.Authorization = `Bearer ${config.wrapperToken}`;
    headers["X-API-Key"] = config.wrapperToken;
  }
  const response = await fetch(`${config.wrapperUrl}/health`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  return await response.json() as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function embeddingApiBase(health: Record<string, unknown>): string {
  const provider = objectValue(health.embedding_provider);
  return (stringValue(provider.api_base) || process.env.EMBEDDING_API_BASE?.trim() || "http://127.0.0.1:5221/v1").replace(/\/+$/, "");
}

async function embeddingUpstreamProbe(health: Record<string, unknown>): Promise<ComponentStatus> {
  const provider = objectValue(health.embedding_provider);
  const model = stringValue(provider.model) || process.env.EMBEDDING_MODEL?.trim() || "Qwen3-Embedding-8B";
  const expectedDims = numberValue(provider.dims);
  const started = Date.now();
  try {
    const response = await fetch(`${embeddingApiBase(health)}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.EMBEDDING_API_KEY ? { authorization: `Bearer ${process.env.EMBEDDING_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model, input: `memory-xx runtime snapshot embedding probe ${Date.now()}` }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    const first = Array.isArray(objectValue(body).data) ? objectValue((objectValue(body).data as unknown[])[0]) : {};
    const dims = Array.isArray(first.embedding) ? first.embedding.length : null;
    const ok = response.ok && dims !== null && (expectedDims === null || dims === expectedDims);
    return {
      name: "ovms_upstream",
      label: "本地 OVMS embedding 上游",
      status: ok ? "ok" : "blocked",
      detail: ok ? `embedding smoke dims=${dims} latency=${Date.now() - started}ms` : `HTTP ${response.status} dims=${dims ?? "n/a"}`,
      source: `${embeddingApiBase(health)}/embeddings`,
      remediation: ok ? undefined : "启动 memory-xx-embedding-upstream.service；它会在 Windows GPU 上拉起 <windows-drive>\\ovms\\run-embedding.bat，并验证 127.0.0.1:8082/v3/embeddings。",
    };
  } catch (error) {
    return {
      name: "ovms_upstream",
      label: "本地 OVMS embedding 上游",
      status: "blocked",
      detail: error instanceof Error ? error.message : String(error),
      source: `${embeddingApiBase(health)}/embeddings`,
      remediation: "启动 memory-xx-embedding-upstream.service；它会在 Windows GPU 上拉起 <windows-drive>\\ovms\\run-embedding.bat，并验证 127.0.0.1:8082/v3/embeddings。",
    };
  }
}

async function rerankerUpstreamProbe(): Promise<ComponentStatus> {
  const url = process.env.MEMORY_XX_RERANKER_UPSTREAM_MODELS_URL?.trim() || "http://127.0.0.1:8084/v3/models";
  const model = process.env.MEMORY_XX_RERANKER_MODEL?.trim() || "qwen3-reranker";
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const body = await response.text();
    const ok = response.ok && body.includes(model);
    return {
      name: "reranker_upstream",
      label: "本地 Qwen3 reranker 上游",
      status: ok ? "ok" : "blocked",
      detail: ok ? `models contains ${model} latency=${Date.now() - started}ms` : `HTTP ${response.status} missing model=${model}`,
      source: url,
      remediation: ok ? undefined : "启动 memory-xx-reranker-upstream.service，确认 Windows GPU 上的 <windows-drive>\\ovms\\run-reranker.bat 正常。",
    };
  } catch (error) {
    return {
      name: "reranker_upstream",
      label: "本地 Qwen3 reranker 上游",
      status: "blocked",
      detail: error instanceof Error ? error.message : String(error),
      source: url,
      remediation: "启动 memory-xx-reranker-upstream.service，确认 Windows GPU 上的 <windows-drive>\\ovms\\run-reranker.bat 正常。",
    };
  }
}

async function qdrantProjectionSummary(schema: string): Promise<Record<string, unknown>> {
  const pool = createPool();
  try {
    const [records, outbox, cache, autoApproval, feedback, recall, writes, freezes, qdrant] = await Promise.all([
      query(pool, `
        SELECT
          count(*) FILTER (WHERE lifecycle_status = 'approved' AND is_current = true)::int AS approved_current,
          count(*) FILTER (WHERE lifecycle_status = 'candidate' AND review_state = 'pending' AND is_current = true)::int AS candidate_current,
          count(*) FILTER (WHERE lifecycle_status = 'tombstone')::int AS tombstone_total
        FROM ${schema}.memory_records
      `),
      query(pool, `
        SELECT
          count(*) FILTER (WHERE dispatch_status = 'pending')::int AS pending,
          count(*) FILTER (WHERE dispatch_status = 'failed')::int AS failed,
          count(*) FILTER (WHERE dispatch_status = 'dead_letter')::int AS dead_letter
        FROM ${schema}.outbox_events
      `),
      query(pool, `
        SELECT
          count(*) FILTER (WHERE status = 'pending')::int AS pending,
          count(*) FILTER (WHERE status = 'failed')::int AS failed,
          count(*) FILTER (WHERE status = 'completed')::int AS completed
        FROM ${schema}.cache_invalidation_requests
      `).catch(() => ({ rows: [{ pending: 0, failed: 0, completed: 0 }] })),
      query(pool, `
        SELECT
          count(*) FILTER (WHERE created_at >= now() - interval '1 hour')::int AS decisions_1h,
          count(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS decisions_24h,
          count(*) FILTER (WHERE decision = 'approve' AND created_at >= now() - interval '1 hour')::int AS approved_1h,
          count(*) FILTER (WHERE decision = 'approve' AND created_at >= now() - interval '24 hours')::int AS approved_24h,
          count(*) FILTER (WHERE decision <> 'approve' AND created_at >= now() - interval '1 hour')::int AS blocked_1h,
          count(*) FILTER (WHERE decision <> 'approve' AND created_at >= now() - interval '24 hours')::int AS blocked_24h
        FROM ${schema}.auto_approval_decisions
      `).catch(() => ({ rows: [{ decisions_1h: 0, approved_1h: 0, blocked_1h: 0 }] })),
      query(pool, `
        SELECT count(*) FILTER (WHERE created_at >= now() - interval '1 hour')::int AS feedback_1h
        FROM ${schema}.memory_feedback_events
      `).catch(() => ({ rows: [{ feedback_1h: 0 }] })),
      query(pool, `
        SELECT
          count(*) FILTER (WHERE created_at >= now() - interval '1 hour')::int AS recall_traces_1h,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE created_at >= now() - interval '1 hour') AS recall_p95_ms,
          percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE created_at >= now() - interval '1 hour') AS recall_p99_ms
        FROM ${schema}.recall_traces
      `).catch(() => ({ rows: [{ recall_traces_1h: 0, recall_p95_ms: null }] })),
      query(pool, `
        SELECT count(*) FILTER (WHERE completed_at >= now() - interval '1 hour')::int AS completed_1h
        FROM ${schema}.ingest_requests
        WHERE command_type LIKE 'memory.%'
      `).catch(() => ({ rows: [{ completed_1h: 0 }] })),
      query(pool, `
        SELECT count(*) FILTER (WHERE auto_approve_enabled = false AND expires_at > now())::int AS frozen_active
        FROM ${schema}.governance_policy_overrides
      `).catch(() => ({ rows: [{ frozen_active: 0 }] })),
      fetch(`${config.qdrantUrl}/collections/${config.qdrantCollection}`, { signal: AbortSignal.timeout(8000) })
        .then((response) => response.json() as Promise<Record<string, unknown>>)
        .then((body) => {
          const result = body.result && typeof body.result === "object" ? body.result as Record<string, unknown> : {};
          return {
            status: result.status ?? "unknown",
            points_count: result.points_count ?? null,
            indexed_vectors_count: result.indexed_vectors_count ?? null,
          };
        })
        .catch((error) => ({ status: "unknown", error: error instanceof Error ? error.message : String(error) })),
    ]);
    const approvedCurrent = Number(records.rows[0]?.approved_current ?? 0);
    const qdrantPointCount = Number((qdrant as Record<string, unknown>).points_count ?? Number.NaN);
    return {
      memory_records: records.rows[0] ?? {},
      outbox: outbox.rows[0] ?? {},
      cache_invalidation: cache.rows[0] ?? {},
      auto_approval: autoApproval.rows[0] ?? {},
      feedback: feedback.rows[0] ?? {},
      recall: recall.rows[0] ?? {},
      write_throughput: {
        completed_1h: writes.rows[0]?.completed_1h ?? 0,
        per_minute_1h: Math.round((Number(writes.rows[0]?.completed_1h ?? 0) / 60) * 100) / 100,
      },
      frozen_cohorts: freezes.rows[0] ?? {},
      qdrant,
      qdrant_pg_diff: Number.isFinite(qdrantPointCount)
        ? {
          postgres_effective_recallable: approvedCurrent,
          qdrant_points: qdrantPointCount,
          diff: qdrantPointCount - approvedCurrent,
        }
        : { postgres_effective_recallable: approvedCurrent, qdrant_points: null, diff: null },
    };
  } finally {
    await closePool(pool);
  }
}

function closureReasons(registry: readonly { readonly key?: unknown; readonly effective_value?: unknown }[], metrics: Record<string, unknown>): Record<string, unknown> {
  const byKey = new Map(registry.map((item) => [String(item.key ?? ""), item.effective_value]));
  const records = metrics.memory_records as Record<string, unknown> | undefined;
  return {
    global_manual_reason: "global scope 默认保持人工审批，污染半径最大；只参与随机测试和 dry-run。",
    real_update_apply_scope: byKey.get("auto_approval.update_apply.real_project_apply") === true
      ? "仅 project:memory-xx guarded single-item trial 可用"
      : "真实长期 scope update apply 当前关闭；测试 scope apply 仍可用。",
    user_update_apply_reason: "user/global/workspace update apply 仍由代码层硬阻断，避免覆盖长期偏好或全局规则。",
    candidate_only_reason: "candidate-only 作为全局 kill switch 保留；已开启真实 add-only scope 使用 scoped bypass。",
    pending_candidate_backlog: records?.candidate_current ?? 0,
  };
}

function statusFromInputs(health: Record<string, unknown>, services: readonly Record<string, unknown>[], metrics: Record<string, unknown>): RuntimeSnapshot["status"] {
  const outbox = metrics.outbox as Record<string, unknown> | undefined;
  const cache = metrics.cache_invalidation as Record<string, unknown> | undefined;
  const components = Array.isArray(metrics.component_statuses) ? metrics.component_statuses as ComponentStatus[] : [];
  if (health.status === "blocked" || Number(outbox?.dead_letter ?? 0) > 0 || components.some((component) => component.status === "blocked")) return "blocked";
  if (health.status === "degraded" || services.some((service) => service.active === false) || Number(outbox?.pending ?? 0) > 0 || Number(cache?.pending ?? 0) > 0) return "degraded";
  if (health.ok === true || health.status === "ok" || health.runtime_initialised === true) return "ok";
  return "unknown";
}

function componentStatusFromInputs(
  health: Record<string, unknown>,
  services: readonly Record<string, unknown>[],
  metrics: Record<string, unknown>,
  embeddingComponent: ComponentStatus,
  rerankerUpstreamComponent: ComponentStatus
): readonly ComponentStatus[] {
  const serviceByUnit = new Map(services.map((service) => [String(service.unit ?? ""), service]));
  const qdrant = objectValue(health.qdrant);
  const redis = objectValue(health.redis);
  const cache = objectValue(metrics.cache_invalidation);
  const outbox = objectValue(metrics.outbox);
  const projectionDiff = objectValue(metrics.qdrant_pg_diff);
  const metricsError = stringValue(metrics.error);
  const generation = objectValue(health.embedding_generation);
  const moduleStatuses = buildComponentStatusesFromRuntimeModules(objectValue(health.runtime_modules));
  if (moduleStatuses.length > 0) {
    return [
      ...moduleStatuses,
      {
        name: "outbox",
        label: "Outbox（投影事件队列）",
        status: metricsError ? "blocked" : Number(outbox.dead_letter ?? 0) > 0 ? "blocked" : Number(outbox.pending ?? 0) > 0 ? "degraded" : "ok",
        detail: metricsError ? `runtime metrics query failed: ${metricsError}` : `pending=${outbox.pending ?? 0} failed=${outbox.failed ?? 0} dead=${outbox.dead_letter ?? 0}`,
        source: "PostgreSQL outbox_events",
      },
      {
        name: "cache_invalidation",
        label: "Cache invalidation（缓存失效队列）",
        status: Number(cache.pending ?? 0) > 0 || Number(cache.failed ?? 0) > 0 ? "degraded" : "ok",
        detail: `pending=${cache.pending ?? 0} failed=${cache.failed ?? 0} completed=${cache.completed ?? 0}`,
        source: "PostgreSQL cache_invalidation_requests",
      },
      {
        name: "qdrant_pg_diff",
        label: "Qdrant/PG diff（向量库与数据库数量差）",
        status: metricsError ? "blocked" : Number(projectionDiff.diff ?? 0) === 0 ? "ok" : "blocked",
        detail: metricsError ? `runtime metrics query failed: ${metricsError}` : `PG=${projectionDiff.postgres_effective_recallable ?? "n/a"} Qdrant=${projectionDiff.qdrant_points ?? "n/a"} diff=${projectionDiff.diff ?? "n/a"}`,
        source: "runtime snapshot reconcile",
      },
      {
        name: "embedding_manifest",
        label: "Embedding manifest（嵌入清单）",
        status: generation.ok === true ? "ok" : "blocked",
        detail: generation.ok === true ? `active=${objectValue(generation.active_generation).generation_id ?? "unknown"}` : stringValue(generation.status) || "manifest unhealthy",
        source: "wrapper /health",
      },
    ];
  }
  const serviceComponent = (name: string, label: string, unit: string): ComponentStatus => {
    const service = serviceByUnit.get(unit);
    const active = service?.active === true;
    return {
      name,
      label,
      status: active ? "ok" : "blocked",
      detail: service ? `${service.active_state ?? "unknown"} / ${service.sub_state ?? "unknown"}` : "service status missing",
      source: unit,
      remediation: active ? undefined : `检查或启动 ${unit}`,
    };
  };
  return [
    serviceComponent("wrapper", "记忆主服务（HTTP/MCP）", "memory-xx-wrapper.service"),
    {
      name: "postgres",
      label: "PostgreSQL（关系数据库）",
      status: health.runtime_initialised === true ? "ok" : "blocked",
      detail: health.runtime_initialised === true ? "runtime initialised" : "runtime not initialised",
      source: "wrapper /health",
    },
    {
      name: "redis",
      label: "Redis（缓存服务）",
      status: redis.available === true ? "ok" : "degraded",
      detail: redis.available === true ? `PONG · prefix=${redis.prefix ?? "unknown"}` : stringValue(redis.error) || "redis unavailable",
      source: "wrapper /health",
    },
    {
      name: "qdrant",
      label: "Qdrant（向量库）",
      status: qdrant.configured === true ? "ok" : "blocked",
      detail: qdrant.configured === true ? `collection=${qdrant.collection_name ?? "unknown"}` : "qdrant not configured",
      source: "wrapper /health",
    },
    serviceComponent("embedding_upstream_manager", "Embedding upstream manager（Windows GPU 模型守护）", "memory-xx-embedding-upstream.service"),
    serviceComponent("embedding_proxy", "Embedding proxy（向量生成代理）", "memory-xx-embedding-proxy-next.service"),
    embeddingComponent,
    serviceComponent("projector", "Qdrant projector（向量投影后台任务）", "memory-xx-qdrant-projector-worker.service"),
    serviceComponent("fastpath", "Fastpath（快速召回路径）", "memory-xx-fastpath.service"),
    serviceComponent("lexical", "Lexical sidecar（关键词召回侧车）", "memory-xx-lexical-sidecar.service"),
    serviceComponent("reranker_upstream_manager", "Reranker upstream manager（Windows GPU 模型守护）", "memory-xx-reranker-upstream.service"),
    rerankerUpstreamComponent,
    serviceComponent("reranker", "Reranker adapter（重排序适配器）", "memory-xx-reranker-adapter-next.service"),
    {
      name: "outbox",
      label: "Outbox（投影事件队列）",
      status: metricsError ? "blocked" : Number(outbox.dead_letter ?? 0) > 0 ? "blocked" : Number(outbox.pending ?? 0) > 0 ? "degraded" : "ok",
      detail: metricsError ? `runtime metrics query failed: ${metricsError}` : `pending=${outbox.pending ?? 0} failed=${outbox.failed ?? 0} dead=${outbox.dead_letter ?? 0}`,
      source: "PostgreSQL outbox_events",
    },
    {
      name: "cache_invalidation",
      label: "Cache invalidation（缓存失效队列）",
      status: Number(cache.pending ?? 0) > 0 || Number(cache.failed ?? 0) > 0 ? "degraded" : "ok",
      detail: `pending=${cache.pending ?? 0} failed=${cache.failed ?? 0} completed=${cache.completed ?? 0}`,
      source: "PostgreSQL cache_invalidation_requests",
    },
    {
      name: "qdrant_pg_diff",
      label: "Qdrant/PG diff（向量库与数据库数量差）",
      status: metricsError ? "blocked" : Number(projectionDiff.diff ?? 0) === 0 ? "ok" : "blocked",
      detail: metricsError ? `runtime metrics query failed: ${metricsError}` : `PG=${projectionDiff.postgres_effective_recallable ?? "n/a"} Qdrant=${projectionDiff.qdrant_points ?? "n/a"} diff=${projectionDiff.diff ?? "n/a"}`,
      source: "runtime snapshot reconcile",
    },
    {
      name: "embedding_manifest",
      label: "Embedding manifest（嵌入清单）",
      status: generation.ok === true ? "ok" : "blocked",
      detail: generation.ok === true ? `active=${objectValue(generation.active_generation).generation_id ?? "unknown"}` : stringValue(generation.status) || "manifest unhealthy",
      source: "wrapper /health",
    },
  ];
}

async function persistRuntimeSnapshot(snapshot: RuntimeSnapshot, schema: string): Promise<void> {
  const pool = createPool();
  try {
    await query(pool, `
      INSERT INTO ${schema}.runtime_snapshots (snapshot_id, collected_at, status, summary, metrics, registry)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
      ON CONFLICT (snapshot_id) DO NOTHING
    `, [
      snapshot.snapshot_id,
      snapshot.collected_at,
      snapshot.status,
      JSON.stringify(snapshot.summary),
      JSON.stringify(snapshot.metrics),
      JSON.stringify(snapshot.registry),
    ]);
    await query(pool, `
      DELETE FROM ${schema}.runtime_snapshots
      WHERE collected_at < now() - interval '7 days'
    `);
    await persistRuntimeObservabilitySnapshot(snapshot, schema);
  } catch {
    // Snapshot persistence is best-effort; the live API should still return runtime truth.
  } finally {
    await closePool(pool);
  }
}

export async function collectRuntimeSnapshot(options: { readonly persist?: boolean; readonly schema?: string } = {}): Promise<RuntimeSnapshot> {
  const schema = options.schema ?? config.dbSchema;
  const [health, services, database, metrics] = await Promise.all([
    wrapperHealth().catch((error) => ({ status: "unknown", error: error instanceof Error ? error.message : String(error) })),
    serviceControls().catch(() => []),
    buildDatabaseMaintenanceSummary(schema).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    qdrantProjectionSummary(schema).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
  ]);
  const embeddingComponent = await embeddingUpstreamProbe(health).catch((error) => ({
    name: "ovms_upstream",
    label: "本地 OVMS embedding 上游",
    status: "blocked" as const,
    detail: error instanceof Error ? error.message : String(error),
    source: "embedding probe",
  }));
  const rerankerUpstreamComponent = await rerankerUpstreamProbe().catch((error) => ({
    name: "reranker_upstream",
    label: "本地 Qwen3 reranker 上游",
    status: "blocked" as const,
    detail: error instanceof Error ? error.message : String(error),
    source: "reranker probe",
  }));
  const registry = buildRuntimeRegistry();
  const serviceObjects = services as readonly Record<string, unknown>[];
  const healthObject = objectValue(health);
  const healthRuntimeModules = objectValue(healthObject.runtime_modules);
  const healthWithRuntimeModules = {
    ...healthObject,
    runtime_modules: objectValue(healthRuntimeModules.states)
      ? healthRuntimeModules
      : buildRuntimeModuleSnapshot(parseMemoryRuntimeProfile(stringValue(healthObject.runtime_profile))),
  };
  const metricsObject = {
    ...(metrics as Record<string, unknown>),
    database,
    component_statuses: componentStatusFromInputs(healthWithRuntimeModules, serviceObjects, metrics as Record<string, unknown>, embeddingComponent, rerankerUpstreamComponent),
    client_connections: readMemoryClientConnections(),
    mcp_tool_invocations: readMcpToolInvocationMetrics(),
    writable_runtime_items: registry.filter((item) => item.writable).length,
    pending_restart_items: registry.filter((item) => item.source === "restart_pending").length,
    effect_matrix: {
      hot_reload: registry.filter((item) => item.effect_status === "hot_reload").length,
      pending_restart: registry.filter((item) => item.effect_status === "pending_restart").length,
      read_only_env: registry.filter((item) => item.effect_status === "read_only_env").length,
      external_service_owned: registry.filter((item) => item.effect_status === "external_service_owned").length,
    },
  };
  const snapshot: RuntimeSnapshot = {
    snapshot_id: `runtime_snapshot_${randomUUID()}`,
    collected_at: new Date().toISOString(),
    status: statusFromInputs(health, serviceObjects, metricsObject),
    summary: {
      wrapper_health: healthWithRuntimeModules,
      services: serviceObjects,
      restart_plan: restartPlan(),
      closure_reasons: closureReasons(registry, metricsObject),
    },
    metrics: metricsObject,
    registry,
  };
  if (options.persist !== false) await persistRuntimeSnapshot(snapshot, schema);
  return snapshot;
}

export async function loadRuntimeSnapshotHistory(window: "1h" | "24h" | "7d", schema = config.dbSchema): Promise<Record<string, unknown>> {
  const interval = window === "1h" ? "1 hour" : window === "24h" ? "24 hours" : "7 days";
  const pool = createPool();
  try {
    const rows = await query(pool, `
      SELECT snapshot_id, collected_at, status, summary, metrics
      FROM ${schema}.runtime_snapshots
      WHERE collected_at >= now() - ($1::interval)
      ORDER BY collected_at DESC
      LIMIT 500
    `, [interval]);
    return {
      ok: true,
      window,
      count: rows.rows.length,
      snapshots: rows.rows,
    };
  } catch (error) {
    return {
      ok: false,
      window,
      count: 0,
      snapshots: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await closePool(pool);
  }
}
