import { randomUUID } from "node:crypto";
import { loadMemoryXXPostgresConfig } from "../db/adapters/postgres-config";
import { loadMemoryRedisConfig } from "../cache";
import { RedisRecallCache, NoopRecallCache } from "../cache";
import { createConfiguredRecallRuntime } from "../recall/postgres-runtime";
import { ResilientQueryEmbeddingProvider } from "../recall/query-embedding-resilience";
import { loadMemoryXXQdrantConfig } from "../recall/qdrant-config";
import { DEFAULT_AGENT_ID, ScopeType, FilterMode, LifecycleStatus, ReviewState } from "../shared";
import type { PostgresRecallRuntime } from "../recall/postgres-runtime";
import type { RecallRequest, RecallResponse } from "../recall/types";
import { CreateMemoryService } from "../write/services/create-memory-service";
import { PostgresWriteDatabase } from "../db/adapters/postgres-write-database";
import { RecallRuntimeCacheInvalidator } from "../cache";
import { createLogger } from "../shared/logger";
import { QwenEmbeddingProviderWrapper } from "./embedding-provider";
import type { RecallCliArgs, WriteCliArgs, CliArgs } from "./types";
import type { CreateMemoryCommand } from "../shared/contracts/write";

const log = createLogger("cli");

function resolveScopeType(raw: string): ScopeType {
  const map: Record<string, ScopeType> = {
    personal: ScopeType.User, shared: ScopeType.Workspace, execution: ScopeType.Run,
    user: ScopeType.User, workspace: ScopeType.Workspace, run: ScopeType.Run,
    project: ScopeType.Project, global: ScopeType.Global, task: ScopeType.Task,
  };
  const resolved = map[raw.toLowerCase()];
  if (!resolved) throw new Error(`未知 scope-type（作用域类型）"${raw}"`);
  return resolved;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const action = args[0] as "recall" | "write";
  if (!action) throw new Error("用法：<recall|write> [args...]");
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const getList = (flag: string): string[] | undefined => {
    const val = get(flag);
    return val ? val.split(",") : undefined;
  };
  if (action === "recall") {
    return {
      action: "recall",
      query: get("--query") ?? "",
      userId: get("--user-id"),
      workspaceId: get("--workspace-id"),
      projectIds: getList("--project-ids"),
      includeGlobal: args.includes("--include-global"),
      runtime: get("--run-id") ? { runId: get("--run-id"), taskId: get("--task-id") } : undefined,
      limit: get("--limit") ? parseInt(get("--limit")!) : 5,
      offset: get("--offset") ? parseInt(get("--offset")!) : 0,
    };
  }
  return {
    action: "write",
    scopeType: get("--scope-type") ?? "personal",
    scopeId: get("--scope-id") ?? "",
    content: get("--content") ?? "",
    title: get("--title"),
    author: get("--author") ?? DEFAULT_AGENT_ID,
    tags: getList("--tags"),
    lifecycleStatus: get("--lifecycle-status"),
    reviewState: get("--review-state"),
  };
}

export async function runRecall(args: RecallCliArgs): Promise<void> {
  const config = loadMemoryXXPostgresConfig();
  const redisConfig = loadMemoryRedisConfig();
  const embeddingProvider = new ResilientQueryEmbeddingProvider(
    new QwenEmbeddingProviderWrapper(),
    { max_retries: 2, retry_delay_ms: 250, retry_backoff_multiplier: 2, cache_ttl_ms: 600_000, allow_stale_on_error: true }
  );
  const redisCache = redisConfig.url ? new RedisRecallCache({ config: redisConfig }) : new NoopRecallCache();
  if ("connect" in redisCache && typeof (redisCache as RedisRecallCache).connect === "function") {
    await (redisCache as RedisRecallCache).connect();
  }
  const qdrantConfig = loadMemoryXXQdrantConfig();
  const runtime: PostgresRecallRuntime = createConfiguredRecallRuntime({
    config, recall_cache: redisCache, query_embedding_provider: embeddingProvider,
    vector_column_name: "content_embedding", qdrant: qdrantConfig
  }).runtime;
  try {
    const request: RecallRequest = {
      query: args.query,
      scope_context: {
        user_id: args.userId ?? "current-instance-owner",
        workspace_id: args.workspaceId ?? "current-instance",
        project_ids: args.projectIds,
        include_global: args.includeGlobal ?? true,
        runtime: args.runtime ? { run_id: args.runtime.runId, task_id: args.runtime.taskId } : undefined,
      },
      filter_mode: FilterMode.All,
      debug: { allow_privileged_filter_modes: true },
      limit: args.limit ?? 5,
      offset: args.offset ?? 0,
    };
    const response = await runtime.orchestrator.execute(request);
    const output: RecallResponse & { _meta: { audit_ref: string; degraded?: boolean } } = {
      ...response,
      _meta: { audit_ref: response.audit_ref, degraded: response.degraded },
    };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await runtime.close();
    await redisCache.close();
  }
}

export async function runWrite(args: WriteCliArgs): Promise<void> {
  const scopeType = resolveScopeType(args.scopeType);
  const lifecycleStatus = args.lifecycleStatus === LifecycleStatus.Approved ? LifecycleStatus.Approved : LifecycleStatus.Candidate;
  const reviewState = args.reviewState === ReviewState.Approved || args.reviewState === ReviewState.NotRequired
    ? args.reviewState : ReviewState.Pending;
  const command: CreateMemoryCommand = {
    requestId: randomUUID(), actorId: args.author, scopeType, scopeId: args.scopeId,
    content: args.content, title: args.title ?? null, summary: null, metadata: {},
    dedupeKey: null, lifecycleStatus, reviewState, sources: [], relations: [],
  };
  const config = loadMemoryXXPostgresConfig();
  const writeDb = new PostgresWriteDatabase({ config });
  const redisConfig = loadMemoryRedisConfig();
  const redisCache = redisConfig.url ? new RedisRecallCache({ config: redisConfig }) : new NoopRecallCache();
  const service = new CreateMemoryService({ database: writeDb, cacheInvalidator: new RecallRuntimeCacheInvalidator(redisCache, { database: writeDb }) });
  try {
    const result = await service.execute(command);
    console.log(JSON.stringify({
      memoryId: result.memoryId, requestId: result.requestId,
      lifecycleStatus: result.lifecycleStatus, reviewState: result.reviewState,
      replayed: (result as unknown as { replayed?: boolean }).replayed ?? false,
    }, null, 2));
  } finally {
    await writeDb.close();
    await redisCache.close();
  }
}
