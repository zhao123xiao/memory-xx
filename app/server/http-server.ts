import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  loadMemoryXXQdrantConfig,
  resolveVectorRuntimeMode,
  buildQdrantDockerConfigHint
} from "../recall/qdrant-config";
import { loadMemoryRedisConfig } from "../cache";
import { createLogger } from "../shared/logger";
import type { MemoryOrchestratorAction } from "../orchestrator";
import { runtime, recallCache, writeDatabase, projectionSyncService, queryEmbeddingProvider } from "./runtime";
import { handleRecall, handleWrite, handleOrchestrator, handleReview, type HandlerDeps } from "./http-handlers";
import { handleIntelligenceExtract, handleIntelligenceSmartWrite, handleMcpSmartWrite, handleWriteTicket } from "../api/intelligence/handlers";
import { handleConversationEvents, handleConversationFlush, handleConversationIngest } from "../api/conversation/handlers";
import * as unified from "../api/unified/handlers";
import { handleKnowledgeIngest, handleKnowledgeSearch } from "../api/knowledge/handlers";
import { handleExecuteSkill, handleListSkills } from "../api/skills/handlers";
import { createPermissionChecker, extractAuthToken, inspectTokenSeparation, type AuthIdentity, type PermissionChecker } from "./permissions";
import {
  normalizeHttpPath,
  requiredPermissionForPath,
  routeLabelForPath
} from "./route-registry";
import { RateLimiter, loadRateLimiterConfig } from "./rate-limiter";
import { InMemoryRequestMetrics, metrics } from "./metrics";
import { initializeDomainMetrics, recordHttpDomainLatency, refreshScrapeDomainMetrics } from "../observability/domain-metrics";
import { getPostCommitDegradedSnapshot, type PostCommitDegradedSnapshot } from "../observability/post-commit-degraded";
import { getQdrantRuntimeSnapshot, type QdrantRuntimeSnapshot } from "../observability/qdrant-health";
import { recordMemoryClientActivity } from "../observability/client-connections";
import { createDefaultMcpServer } from "../mcp";
import { createMcpHttpHandler } from "../mcp/transport-http";
import { createDefaultSkillRegistry } from "../skills/default-registry";
import { inspectEmbeddingGenerationHealth, type EmbeddingGenerationHealth } from "../embedding";
import { buildFullStackCapabilitySnapshot, type FullStackCapabilitySnapshot } from "../full-stack-capabilities";
import { loadEmbeddingProviderRequestConfig, type EmbeddingProviderRequestConfig } from "./embedding-provider";
import { parseMemoryRuntimeProfile, type MemoryRuntimeProfile } from "../runtime-profiles";
import { buildRuntimeModuleSnapshot, type RuntimeModuleSnapshot } from "../runtime-modules";
import { validateRuntimeConfig, type RuntimeConfigValidationResult } from "../runtime-config-validator";
import { getIntelligenceLlmCircuitHealthSnapshot } from "../intelligence/llm-client";
import {
  buildHealthRuntimeIssues,
  deriveMemoryServiceStatus,
  readLatestRepairRunSummary,
  type MemoryRuntimeIssue,
  type MemoryServiceStatus,
  type RepairRunSummary,
} from "../ops";
import { withWriteTransaction } from "../db";

const log = createLogger("http-server");

const PORT = parseInt(process.env.MEMORY_XX_WRAPPER_PORT ?? "5100", 10);
const BIND_HOST = process.env.MEMORY_XX_BIND_HOST?.trim() || "127.0.0.1";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_CONNECTIONS = 50;

const skillRegistry = createDefaultSkillRegistry({
  baseUrl: `http://127.0.0.1:${PORT}`,
  apiToken: process.env.MEMORY_XX_API_TOKEN?.trim() || undefined,
});

export interface CorsConfig {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
}

export function loadCorsConfig(env: NodeJS.ProcessEnv): CorsConfig {
  const enabled = env.MEMORY_XX_CORS_ENABLED !== "false";
  const originsRaw = (env.MEMORY_XX_CORS_ORIGINS ?? "").trim();
  const allowedOrigins = originsRaw
    ? originsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  return { enabled, allowedOrigins };
}

function isLocalCorsOrigin(origin: string | undefined): origin is string {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function firstHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return typeof value === "string" ? value.trim() : "";
}

function clientActivityIdentity(req: IncomingMessage, identity: AuthIdentity | null, transport: "http" | "mcp"): {
  readonly agentId?: string;
  readonly identitySource?: string;
  readonly clientName?: string;
} {
  const headerAgentId = firstHeader(req, "x-memory-xx-agent-id");
  const headerClientName = firstHeader(req, "x-memory-xx-client-name");
  if (transport === "mcp" && headerAgentId) {
    return {
      agentId: headerAgentId,
      identitySource: identity ? `${identity.source}:via_${identity.agentId}` : "client_header",
      clientName: headerClientName || headerAgentId,
    };
  }
  return {
    agentId: identity?.agentId,
    identitySource: identity?.source,
    clientName: headerClientName,
  };
}

export interface RequestHandlerDeps {
  permissions: PermissionChecker;
  rateLimiter: RateLimiter;
  corsConfig: CorsConfig;
  handlerDeps: Partial<HandlerDeps>;
  metrics: InMemoryRequestMetrics;
}

interface WrapperHealthSnapshot {
  readonly status: "ok" | "degraded";
  readonly service_status: MemoryServiceStatus;
  readonly runtime_initialised: boolean;
  readonly runtime_profile: MemoryRuntimeProfile;
  readonly wrapper_mode: string;
  readonly runtime_selection: "postgres-primary" | "qdrant-primary";
  readonly vector: {
    readonly available: boolean;
    readonly reason?: string;
    readonly backend?: string;
    readonly primary_backend?: string;
    readonly fallback_backend?: string;
    readonly fallback_available?: boolean;
  };
  readonly qdrant: {
    readonly docker_managed: boolean;
    readonly configured: boolean;
    readonly base_url?: string;
    readonly collection_name?: string;
    readonly runtime: QdrantRuntimeSnapshot;
  };
  readonly redis: Record<string, unknown>;
  readonly query_embedding_cache: Record<string, unknown>;
  readonly post_commit_degraded: PostCommitDegradedSnapshot;
  readonly cache_invalidation: Record<string, unknown>;
  readonly governance: Record<string, unknown>;
  readonly embedding_generation: EmbeddingGenerationHealth | { readonly configured: false; readonly error: string };
  readonly embedding_provider: EmbeddingProviderRequestConfig & {
    readonly matches_active_generation: boolean | null;
  };
  readonly dependency_profile: {
    readonly mode: MemoryRuntimeProfile;
    readonly required_components: readonly string[];
    readonly expected_components: readonly string[];
    readonly optional_components: readonly string[];
  };
  readonly runtime_modules: RuntimeModuleSnapshot;
  readonly full_stack_capabilities: FullStackCapabilitySnapshot;
  readonly security: {
    readonly token_separation: ReturnType<typeof inspectTokenSeparation>;
  };
  readonly cutover_gate: Record<string, unknown>;
  readonly maintenance: Record<string, unknown>;
  readonly graph_health: Record<string, unknown>;
  readonly decay_health: Record<string, unknown>;
  readonly temporal_health: Record<string, unknown>;
  readonly intelligence_quality: Record<string, unknown>;
  readonly intelligence_llm: Record<string, unknown>;
  readonly dlq_recovery: Record<string, unknown>;
  readonly config_validation: RuntimeConfigValidationResult;
  readonly issues: readonly MemoryRuntimeIssue[];
  readonly repair_summary: RepairRunSummary | null;
  readonly config: {
    readonly database_url_configured: boolean;
    readonly database_schema: string;
    readonly openai_api_key_configured: boolean;
    readonly embedding_api_base: string;
    readonly redis_url_configured: boolean;
    readonly redis_prefix: string;
  };
}

async function readCacheInvalidationWorkerStatus(): Promise<Record<string, unknown> | null> {
  const file = process.env.MEMORY_XX_CACHE_INVALIDATION_STATUS_FILE?.trim() ||
    `${process.cwd()}/.runtime/cache-invalidation-worker.status.json`;
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function buildCacheInvalidationHealth(): Promise<Record<string, unknown>> {
  if (!writeDatabase) {
    return { configured: true, available: false, reason: "write_database_not_initialised" };
  }
  const worker = await readCacheInvalidationWorkerStatus();
  try {
    const rows = await withWriteTransaction(writeDatabase, async (tx) => {
      if (tx.backend !== "postgres") throw new Error("postgres_required");
      return tx.query<{
        status: string;
        count: string | number;
        oldest_created_at: Date | string | null;
        newest_updated_at: Date | string | null;
      }>(
      `
        SELECT status, COUNT(*) AS count, MIN(created_at) AS oldest_created_at, MAX(updated_at) AS newest_updated_at
        FROM cache_invalidation_requests
        GROUP BY status
        ORDER BY status
      `
      );
    });
    const byStatus = Object.fromEntries(rows.map((row) => [row.status, Number(row.count ?? 0)]));
    const pendingLike = await withWriteTransaction(writeDatabase, async (tx) => {
      if (tx.backend !== "postgres") throw new Error("postgres_required");
      return tx.query<{
        oldest_pending_at: Date | string | null;
        latest_error: string | null;
      }>(
      `
        SELECT
          MIN(created_at) FILTER (WHERE completed_at IS NULL AND status IN ('pending', 'failed', 'processing')) AS oldest_pending_at,
          (ARRAY_REMOVE(ARRAY_AGG(last_error ORDER BY updated_at DESC), NULL))[1] AS latest_error
        FROM cache_invalidation_requests
      `
      );
    });
    const oldestPendingAt = pendingLike[0]?.oldest_pending_at ?? null;
    const oldestPendingAgeMs = oldestPendingAt
      ? Date.now() - Date.parse(String(oldestPendingAt))
      : null;
    return {
      configured: true,
      available: true,
      counts: byStatus,
      pending_like_count: Number(byStatus.pending ?? 0) + Number(byStatus.failed ?? 0) + Number(byStatus.processing ?? 0),
      oldest_pending_at: oldestPendingAt ? new Date(oldestPendingAt).toISOString() : null,
      oldest_pending_age_ms: oldestPendingAgeMs,
      latest_error: pendingLike[0]?.latest_error ?? null,
      worker
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      worker
    };
  }
}

async function buildGovernanceHealth(): Promise<Record<string, unknown>> {
  if (!writeDatabase) {
    return { configured: true, available: false, reason: "write_database_not_initialised" };
  }
  const timeoutMinutes = Number.parseInt(
    process.env.MEMORY_XX_GOVERNANCE_STUCK_TIMEOUT_MINUTES?.trim() || "30",
    10
  );
  try {
    const rows = await withWriteTransaction(writeDatabase, async (tx) => {
      if (tx.backend !== "postgres") throw new Error("postgres_required");
      return tx.query<{
        running_count: string | number;
        stuck_count: string | number;
        oldest_running_started_at: Date | string | null;
        oldest_stuck_started_at: Date | string | null;
        latest_stuck_error: string | null;
      }>(
      `
        SELECT
          COUNT(*) FILTER (WHERE status = 'running') AS running_count,
          COUNT(*) FILTER (
            WHERE status = 'running'
              AND (
                (lease_expires_at IS NOT NULL AND lease_expires_at < now())
                OR (heartbeat_at IS NOT NULL AND heartbeat_at < now() - ($1::int * interval '1 minute'))
                OR (heartbeat_at IS NULL AND started_at < now() - ($1::int * interval '1 minute'))
              )
          ) AS stuck_count,
          MIN(started_at) FILTER (WHERE status = 'running') AS oldest_running_started_at,
          MIN(started_at) FILTER (
            WHERE status = 'running'
              AND (
                (lease_expires_at IS NOT NULL AND lease_expires_at < now())
                OR (heartbeat_at IS NOT NULL AND heartbeat_at < now() - ($1::int * interval '1 minute'))
                OR (heartbeat_at IS NULL AND started_at < now() - ($1::int * interval '1 minute'))
              )
          ) AS oldest_stuck_started_at,
          (ARRAY_REMOVE(ARRAY_AGG(error ORDER BY updated_at DESC), NULL))[1] AS latest_stuck_error
        FROM memory_governance_runs
      `,
      [timeoutMinutes]
      );
    });
    const row = rows[0];
    const oldestRunningStartedAt = row?.oldest_running_started_at ?? null;
    const oldestStuckStartedAt = row?.oldest_stuck_started_at ?? null;
    return {
      configured: true,
      available: true,
      timeout_minutes: timeoutMinutes,
      running_count: Number(row?.running_count ?? 0),
      stuck_count: Number(row?.stuck_count ?? 0),
      oldest_running_started_at: oldestRunningStartedAt ? new Date(oldestRunningStartedAt).toISOString() : null,
      oldest_running_age_ms: oldestRunningStartedAt ? Date.now() - Date.parse(String(oldestRunningStartedAt)) : null,
      oldest_stuck_started_at: oldestStuckStartedAt ? new Date(oldestStuckStartedAt).toISOString() : null,
      oldest_stuck_age_ms: oldestStuckStartedAt ? Date.now() - Date.parse(String(oldestStuckStartedAt)) : null,
      latest_stuck_error: row?.latest_stuck_error ?? null
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildP1HealthSummaries(configValidation: RuntimeConfigValidationResult): Pick<
  WrapperHealthSnapshot,
  | "cutover_gate"
  | "maintenance"
  | "graph_health"
  | "decay_health"
  | "temporal_health"
  | "intelligence_quality"
  | "intelligence_llm"
  | "dlq_recovery"
> {
  const runtimeDir = process.env.MEMORY_XX_RUNTIME_DIR?.trim() || `${process.cwd()}/.runtime`;
  return {
    cutover_gate: {
      evidence_dir: "reports/memory-xx-cutover",
      m4_command: "npm run memory:cutover-gate -- --stage m4 --json",
      m5_command: "npm run memory:cutover-gate -- --stage m5 --json"
    },
    maintenance: {
      orchestrator: "memory:maintenance",
      default_mode: "report",
      auto_command: "npm run memory:maintenance -- run --mode auto --json",
      single_instance_lease: true
    },
    graph_health: {
      latest_report: `${runtimeDir}/graph-health-latest.json`,
      guard_enabled: process.env.MEMORY_XX_GRAPH_GUARD_DISABLED !== "true",
      guard_requires_health: process.env.MEMORY_XX_GRAPH_GUARD_REQUIRE_HEALTH === "true"
    },
    decay_health: {
      command: "npm run memory:decay -- run --mode report --json",
      mutation_mode: "soft_archive_only"
    },
    temporal_health: {
      command: "npm run memory:temporal-sweep -- --json",
      expires_at_sweep_apply_required: true
    },
    intelligence_quality: {
      command: "npm run memory:intelligence-quality -- --json",
      candidate_only_flag: `${runtimeDir}/intelligence-candidate-only.json`
    },
    intelligence_llm: {
      circuit_breaker: getIntelligenceLlmCircuitHealthSnapshot() ?? { state: "not_initialised" }
    },
    dlq_recovery: {
      command: "npm run memory:dlq-recovery -- scan --json",
      replay_requires_apply: true,
      config_ok: configValidation.ok
    }
  };
}

async function buildHealthSnapshot(): Promise<WrapperHealthSnapshot> {
  const qdrantConfig = loadMemoryXXQdrantConfig();
  const redisConfig = loadMemoryRedisConfig();
  const runtimeSelection = resolveVectorRuntimeMode(qdrantConfig);
  const vectorStatus = runtime
    ? await runtime.vector_retriever.get_backend_status()
    : {
        name: "vector",
        available: false,
        reason: "runtime_not_initialised" as const,
        backend: runtimeSelection === "qdrant-primary" ? "qdrant" : "pgvector",
        primary_backend: runtimeSelection === "qdrant-primary" ? "qdrant" : "pgvector",
        fallback_backend: runtimeSelection === "qdrant-primary" ? "pgvector" : undefined,
        fallback_available: false
      };

  const databaseUrl = process.env.MEMORY_XX_DATABASE_URL?.trim() ?? "";
  const databaseSchema = process.env.MEMORY_XX_DATABASE_SCHEMA?.trim() ?? "public";
  const openAiApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const embeddingApiBase = process.env.EMBEDDING_API_BASE?.trim() ?? "https://api.scnet.cn/api/llm/v1";
  const redisHealth = await recallCache.getHealthSnapshot();
  const embeddingProviderConfig = loadEmbeddingProviderRequestConfig();
  let embeddingGeneration: WrapperHealthSnapshot["embedding_generation"];
  try {
    embeddingGeneration = await inspectEmbeddingGenerationHealth();
  } catch (error) {
    embeddingGeneration = {
      configured: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  const generationOk = "ok" in embeddingGeneration ? embeddingGeneration.ok : false;
  const activeGeneration = "active_generation" in embeddingGeneration ? embeddingGeneration.active_generation : null;
  const providerMatchesActiveGeneration = activeGeneration
    ? embeddingProviderConfig.model === activeGeneration.model &&
      embeddingProviderConfig.dims === activeGeneration.dims &&
      embeddingProviderConfig.generation_id === activeGeneration.generation_id
    : null;
  const runtimeProfile = parseMemoryRuntimeProfile();
  const runtimeModules = buildRuntimeModuleSnapshot(runtimeProfile);
  const fullStackCapabilities = buildFullStackCapabilitySnapshot();

  const tokenSeparation = inspectTokenSeparation(process.env);
  const configValidation = validateRuntimeConfig(process.env);
  const p1Health = buildP1HealthSummaries(configValidation);
  const cacheInvalidation = await buildCacheInvalidationHealth();
  const governanceHealth = await buildGovernanceHealth();
  const baseOk = runtime !== null &&
    vectorStatus.available &&
    generationOk &&
    providerMatchesActiveGeneration !== false &&
    tokenSeparation.ok &&
    configValidation.ok;
  const issues = buildHealthRuntimeIssues({
    runtimeInitialised: runtime !== null,
    vectorAvailable: vectorStatus.available,
    vectorReason: vectorStatus.reason,
    generationOk,
    providerMatchesActiveGeneration,
    tokenSeparationOk: tokenSeparation.ok,
    configValidationOk: configValidation.ok,
  });
  if (
    "manifest_count_stale" in embeddingGeneration &&
    embeddingGeneration.manifest_count_stale === true
  ) {
    issues.push({
      id: "embedding_manifest_count_stale",
      severity: "warning",
      subsystem: "embedding",
      root_cause: "当前激活的 embedding manifest（嵌入版本清单）里的 record_count/point_count 统计已过期，但 PostgreSQL 有效可召回数量与 Qdrant 向量点数量一致。",
      evidence: {
        manifest_record_count: embeddingGeneration.active_generation?.record_count ?? null,
        manifest_point_count: embeddingGeneration.active_generation?.point_count ?? null,
        postgres_effective_recallable_count: embeddingGeneration.postgres_effective_recallable_count,
        qdrant_point_count: embeddingGeneration.qdrant_point_count,
        last_reconciled_at: embeddingGeneration.last_reconciled_at,
      },
      repairability: "auto_safe",
      recommended_action: "运行 TMPDIR=/tmp npm run memory:embedding-manifest -- refresh --force-reconcile 刷新过期的 manifest 计数字段。",
      repair_command: "TMPDIR=/tmp npm run memory:embedding-manifest -- refresh --force-reconcile",
      last_checked_at: new Date().toISOString(),
    });
  }
  if (Number(governanceHealth.stuck_count ?? 0) > 0) {
    issues.push({
      id: "governance_run_stuck",
      severity: "warning",
      subsystem: "governance",
      root_cause: "一个或多个治理任务在租约或心跳超时后仍被标记为运行中。",
      evidence: governanceHealth,
      repairability: "auto_safe",
      recommended_action: "先检查 dry-run 输出，确认无误后运行 TMPDIR=/tmp npm run memory:governance-stuck-runs -- --apply --json。",
      repair_command: "TMPDIR=/tmp npm run memory:governance-stuck-runs -- --dry-run --json",
      last_checked_at: new Date().toISOString(),
    });
  }
  const repairSummary = readLatestRepairRunSummary();
  const surfacedIssues = [
    ...issues,
    ...(repairSummary?.issues ?? []),
  ];

  return {
    status: baseOk ? "ok" : "degraded",
    service_status: deriveMemoryServiceStatus({ baseOk, issues: surfacedIssues, repairSummary }),
    runtime_initialised: runtime !== null,
    runtime_profile: runtimeProfile,
    wrapper_mode: process.env.MEMORY_XX_WRAPPER_MODE ?? "recall-only",
    runtime_selection: runtimeSelection,
    vector: {
      available: vectorStatus.available,
      reason: vectorStatus.reason,
      backend: vectorStatus.backend,
      primary_backend: vectorStatus.primary_backend,
      fallback_backend: vectorStatus.fallback_backend,
      fallback_available: vectorStatus.fallback_available
    },
    qdrant: {
      ...buildQdrantDockerConfigHint(qdrantConfig),
      runtime: getQdrantRuntimeSnapshot({
        queryTimeoutMs: Number.parseInt(process.env.MEMORY_XX_QDRANT_QUERY_TIMEOUT_MS?.trim() || "1200", 10),
        writeTimeoutMs: Number.parseInt(process.env.MEMORY_XX_QDRANT_WRITE_TIMEOUT_MS?.trim() || "5000", 10),
      })
    },
    redis: redisHealth,
    query_embedding_cache: queryEmbeddingProvider?.getCacheHealthSnapshot?.() ?? { configured: false },
    post_commit_degraded: getPostCommitDegradedSnapshot(),
    cache_invalidation: cacheInvalidation,
    governance: governanceHealth,
    embedding_generation: embeddingGeneration,
    embedding_provider: {
      ...embeddingProviderConfig,
      matches_active_generation: providerMatchesActiveGeneration
    },
    dependency_profile: {
      mode: runtimeProfile,
      required_components: runtimeModules.required_modules,
      expected_components: runtimeModules.expected_modules,
      optional_components: runtimeModules.optional_modules,
    },
    runtime_modules: runtimeModules,
    full_stack_capabilities: fullStackCapabilities,
    security: {
      token_separation: tokenSeparation,
    },
    ...p1Health,
    config_validation: configValidation,
    issues: surfacedIssues,
    repair_summary: repairSummary,
    config: {
      database_url_configured: databaseUrl.length > 0,
      database_schema: databaseSchema,
      openai_api_key_configured: openAiApiKey.length > 0,
      embedding_api_base: embeddingApiBase,
      redis_url_configured: Boolean(redisConfig.url),
      redis_prefix: redisConfig.prefix
    }
  };
}

export function createRequestHandler(deps: RequestHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const traceId = randomUUID();
    const start = Date.now();

    // CORS
    if (deps.corsConfig.enabled) {
      if (deps.corsConfig.allowedOrigins.length === 0) {
        const origin = req.headers.origin;
        if (typeof origin === "string" && isLocalCorsOrigin(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Vary", "Origin");
        }
      } else {
        const origin = req.headers.origin;
        if (origin && deps.corsConfig.allowedOrigins.includes(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Vary", "Origin");
        }
      }
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Rate limiting
    const clientIp = req.socket.remoteAddress ?? "unknown";
    if (!deps.rateLimiter.isAllowed(clientIp)) {
      const retryAfter = deps.rateLimiter.getRetryAfterSeconds(clientIp);
      log.warn("请求速率超过限制", { traceId, clientIp });
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfter) });
      res.end(JSON.stringify({ error: "请求速率超过限制", retry_after_seconds: retryAfter }));
      return;
    }

    const pathname = normalizeHttpPath(req.url ?? "");
    const routeLabel = routeLabelForPath(pathname);
    let requestIdentity: AuthIdentity | null = null;

    // Wrap response to capture status for logging/metrics
    let responseStatus = 0;
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = ((statusCode: number, headersOrMessage?: Record<string, string> | string) => {
      responseStatus = statusCode;
      return originalWriteHead(statusCode, headersOrMessage as any);
    }) as typeof res.writeHead;

    // Request completion logging (registered early so it fires for all routes)
    res.on("close", () => {
      const duration = Date.now() - start;
      const status = responseStatus || 404;
      deps.metrics.incrementCounter("http_requests_total", { method: req.method ?? "GET", route: routeLabel, status: String(status) });
      deps.metrics.observeHistogram("http_request_duration_ms", duration, { route: routeLabel });
      recordHttpDomainLatency(routeLabel, duration, deps.metrics);
      if (requestIdentity) {
        try {
          const clientIdentity = clientActivityIdentity(req, requestIdentity, pathname === "/mcp" ? "mcp" : "http");
          recordMemoryClientActivity({
            agentId: clientIdentity.agentId,
            identitySource: clientIdentity.identitySource,
            transport: pathname === "/mcp" ? "mcp" : "http",
            endpoint: routeLabel,
            method: req.method ?? "UNKNOWN",
            remoteAddress: req.socket.remoteAddress,
            userAgent: Array.isArray(req.headers["user-agent"]) ? req.headers["user-agent"].join(",") : req.headers["user-agent"],
            status,
            permissions: requestIdentity.permissions,
            clientName: clientIdentity.clientName,
          });
        } catch (error) {
          log.warn("记录客户端连接状态失败", { traceId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      log.info("Request completed", { traceId, method: req.method, route: routeLabel, status, duration_ms: duration });
    });

    const hd = deps.handlerDeps;
    const requiredPermission = requiredPermissionForPath(pathname);
    if (requiredPermission) {
      const authz = await deps.permissions.authorizeRequest(req, requiredPermission);
      if (!authz.authenticated) {
        log.warn("认证失败", { traceId, route: routeLabel, required: requiredPermission });
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized", required: requiredPermission }));
        return;
      }
      if (!authz.allowed) {
        log.warn("权限不足", {
          traceId,
          route: routeLabel,
          required: requiredPermission,
          agent_id: authz.identity?.agentId,
        });
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "forbidden",
          required: requiredPermission,
          agent_id: authz.identity?.agentId ?? "unknown",
        }));
        return;
      }
      requestIdentity = authz.identity;
    }

    if (pathname === "/api/memory/xx/recall/query" || pathname === "/api/memory/xx/recall" || pathname === "/recall") {
      await handleRecall(req, res, hd);
      return;
    }
    if (pathname.startsWith("/api/memory/xx/write") || pathname === "/write") {
      await handleWrite(req, res, hd);
      return;
    }
    if (pathname.startsWith("/api/memory/xx/review/memories/")) {
      await handleReview(req, res, hd);
      return;
    }
    if (pathname === "/api/memory/xx/orchestrator/resolve-scope-plan") {
      await handleOrchestrator(req, res, "resolve_scope_plan", hd);
      return;
    }
    if (pathname === "/api/memory/xx/orchestrator/write-memory") {
      await handleOrchestrator(req, res, "write_memory", hd);
      return;
    }
    if (pathname === "/api/memory/xx/orchestrator/recall-memory") {
      await handleOrchestrator(req, res, "recall_memory", hd);
      return;
    }
    if (pathname === "/api/memory/xx/orchestrator/recall-memory-legacy") {
      await handleOrchestrator(req, res, "recall_memory_legacy", hd);
      return;
    }
    if (pathname === "/api/memory/xx/orchestrator/summarize-memory") {
      await handleOrchestrator(req, res, "summarize_memory", hd);
      return;
    }
    if (pathname === "/api/memory/xx/orchestrator/memory-counts") {
      await handleOrchestrator(req, res, "memory_counts", hd);
      return;
    }
    if (pathname === "/api/memory/xx/orchestrator/forget-memory") {
      await handleOrchestrator(req, res, "forget_memory", hd);
      return;
    }
    if (pathname === "/api/memory/xx/orchestrator/read-memory") {
      await handleOrchestrator(req, res, "read_memory" satisfies MemoryOrchestratorAction, hd);
      return;
    }
    if (pathname === "/api/memory/xx/orchestrator/audit-memory-consistency") {
      await handleOrchestrator(req, res, "audit_memory_consistency", hd);
      return;
    }
    if (pathname === "/api/memory/xx/orchestrator/repair-memory-consistency") {
      await handleOrchestrator(req, res, "repair_memory_consistency", hd);
      return;
    }
    const authContext = {
      permissions: deps.permissions,
      env: hd.env ?? process.env,
      writeDatabase: hd.writeDatabase ?? writeDatabase,
    };

    // Intelligence API routes
    if (pathname === "/api/memory/xx/intelligence/extract") {
      await handleIntelligenceExtract(req, res, authContext);
      return;
    }
    if (pathname === "/api/memory/xx/intelligence/smart-write") {
      await handleIntelligenceSmartWrite(req, res, authContext);
      return;
    }
    {
      const match = pathname.match(/^\/api\/memory\/xx\/intelligence\/write-tickets\/([^/]+)$/);
      if (match) {
        await handleWriteTicket(req, res, decodeURIComponent(match[1] ?? ""), authContext);
        return;
      }
    }
    if (pathname === "/api/memory/xx/mcp/list-pending") {
      await handleOrchestrator(req, res, "list_pending_memories" satisfies MemoryOrchestratorAction, hd);
      return;
    }
    if (pathname === "/api/memory/xx/mcp/approve") {
      await handleOrchestrator(req, res, "mcp_approve_memory" satisfies MemoryOrchestratorAction, hd);
      return;
    }
    if (pathname === "/api/memory/xx/mcp/reject") {
      await handleOrchestrator(req, res, "mcp_reject_memory" satisfies MemoryOrchestratorAction, hd);
      return;
    }
    if (pathname === "/api/memory/xx/mcp/smart-write") {
      await handleMcpSmartWrite(req, res, authContext);
      return;
    }

    // Conversation listener API routes.
    if (pathname === "/api/memory/xx/conversation/events") {
      await handleConversationEvents(req, res, authContext);
      return;
    }
    if (pathname === "/api/memory/xx/conversation/ingest") {
      await handleConversationIngest(req, res, authContext);
      return;
    }
    if (pathname === "/api/memory/xx/conversation/flush") {
      await handleConversationFlush(req, res, authContext);
      return;
    }

    // Unified Agent API routes (P5)
    if (pathname === "/api/memory/xx/unified/remember") {
      await unified.handleRemember(req, res, authContext);
      return;
    }
    if (pathname === "/api/memory/xx/unified/recall") {
      await unified.handleRecall(req, res, authContext);
      return;
    }
    if (pathname === "/api/memory/xx/unified/reflect") {
      await unified.handleReflect(req, res, authContext);
      return;
    }
    if (pathname === "/api/memory/xx/unified/forget") {
      await unified.handleForget(req, res, authContext);
      return;
    }
    if (pathname === "/api/memory/xx/unified/audit") {
      await unified.handleAudit(req, res, authContext);
      return;
    }
    if (pathname === "/api/memory/xx/unified/feedback") {
      await unified.handleFeedback(req, res, authContext);
      return;
    }
    {
      const feedbackAlias = pathname.match(/^\/api\/memory\/xx\/feedback\/memories\/([^/]+)\/([^/]+)$/);
      if (feedbackAlias) {
        await unified.handleFeedbackAlias(
          req,
          res,
          decodeURIComponent(feedbackAlias[1] ?? ""),
          decodeURIComponent(feedbackAlias[2] ?? ""),
          authContext
        );
        return;
      }
    }
    if (pathname === "/api/memory/xx/unified/recall-feedback") {
      await unified.handleRecallFeedback(req, res, authContext);
      return;
    }

    // Knowledge-v1 API routes. Knowledge is opt-in and does not enter default memory recall.
    if (pathname === "/api/memory/xx/knowledge/ingest") {
      await handleKnowledgeIngest(req, res, authContext);
      return;
    }
    if (pathname === "/api/memory/xx/knowledge/search") {
      await handleKnowledgeSearch(req, res, authContext);
      return;
    }

    // Built-in high-level memory skills.
    if (pathname === "/api/memory/xx/skills") {
      await handleListSkills(req, res, skillRegistry);
      return;
    }
    if (pathname === "/api/memory/xx/skills/execute") {
      const requestToken = extractAuthToken(req) || undefined;
      const requestSkillRegistry = createDefaultSkillRegistry({
        baseUrl: `http://127.0.0.1:${PORT}`,
        apiToken: requestToken,
      });
      await handleExecuteSkill(
        req,
        res,
        requestSkillRegistry,
        requestIdentity?.permissions.map((action) => ({ action })) ?? []
      );
      return;
    }

    if (pathname === "/mcp") {
      const requestToken = extractAuthToken(req) || process.env.MEMORY_XX_MCP_TOKEN?.trim() || process.env.MEMORY_XX_API_TOKEN?.trim() || undefined;
      const requestMcpServer = createDefaultMcpServer({
        baseUrl: `http://127.0.0.1:${PORT}`,
        apiToken: requestToken,
      });
      const mcpHandler = createMcpHttpHandler(async (msg) => {
        try {
          const clientIdentity = clientActivityIdentity(req, requestIdentity, "mcp");
          recordMemoryClientActivity({
            agentId: clientIdentity.agentId,
            identitySource: clientIdentity.identitySource,
            transport: "mcp",
            endpoint: "/mcp",
            method: "method" in msg && typeof msg.method === "string" ? msg.method : "response",
            remoteAddress: req.socket.remoteAddress,
            userAgent: Array.isArray(req.headers["user-agent"]) ? req.headers["user-agent"].join(",") : req.headers["user-agent"],
            permissions: requestIdentity?.permissions,
            clientName: clientIdentity.clientName,
          });
        } catch (error) {
          log.warn("记录 MCP 方法活动失败", { traceId, error: error instanceof Error ? error.message : String(error) });
        }
        return requestMcpServer.handleMessage(msg);
      }, {
        authorize: async (mcpReq) => {
          const decision = await deps.permissions.authorizeToken(extractAuthToken(mcpReq), "memory:write");
          return decision.authenticated && decision.allowed;
        },
      });
      await mcpHandler(req, res);
      return;
    }

    if (pathname === "/live") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "memory-xx" }));
      return;
    }

    if (pathname === "/health") {
      const health = await buildHealthSnapshot();
      res.writeHead(health.status === "ok" ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health));
      return;
    }
    if (pathname === "/metrics/prometheus") {
      await refreshScrapeDomainMetrics(writeDatabase, deps.metrics);
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(deps.metrics.getPrometheusSnapshot());
      return;
    }
    if (pathname === "/metrics") {
      await refreshScrapeDomainMetrics(writeDatabase, deps.metrics);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(deps.metrics.getSnapshot()));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "路由不存在" }));
  };
}

export { requiredPermissionForPath, routeLabelForPath } from "./route-registry";

function isLoopbackBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function assertSafeBindHost(env: NodeJS.ProcessEnv): void {
  const host = env.MEMORY_XX_BIND_HOST?.trim() || "127.0.0.1";
  if (isLoopbackBindHost(host)) return;
  const hasStaticToken = Boolean(env.MEMORY_XX_API_TOKEN?.trim() || env.MEMORY_XX_ADMIN_TOKEN?.trim());
  if (!hasStaticToken) {
    throw new Error("只有配置 MEMORY_XX_API_TOKEN 或 MEMORY_XX_ADMIN_TOKEN 后，MEMORY_XX_BIND_HOST 才允许绑定到非本机回环地址。");
  }
}

export function startHttpServer(): void {
  assertSafeBindHost(process.env);
  const permissions = createPermissionChecker(process.env);
  const rateLimiter = new RateLimiter(loadRateLimiterConfig(process.env));
  const corsConfig = loadCorsConfig(process.env);
  initializeDomainMetrics(metrics);

  log.info("API permission checks enabled");

  const handlerDeps: Partial<HandlerDeps> = {
    permissions,
    env: process.env,
  };

  const handler = createRequestHandler({
    permissions,
    rateLimiter,
    corsConfig,
    handlerDeps,
    metrics,
  });

  const server = createServer(handler);

  server.timeout = REQUEST_TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;

  server.listen(PORT, BIND_HOST, () => {
    log.info("HTTP server listening", { port: PORT, host: BIND_HOST });
    log.info("Endpoints", {
      recall: `POST http://${BIND_HOST}:${PORT}/api/memory/xx/recall/query`,
      health: `GET http://${BIND_HOST}:${PORT}/health`
    });
  });

  const shutdown = async (): Promise<void> => {
    log.info("Shutting down");
    server.close();
    const { closeRuntime } = await import("./runtime.js");
    await permissions.close();
    await closeRuntime();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
