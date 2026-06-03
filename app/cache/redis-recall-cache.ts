import { createClient, type RedisClientType } from "redis";

import { QueryType, type QueryClassification, type RecallRequest, type RecallResponse, type RecallScopeRef } from "../recall/types";
import type { ScopeType } from "../shared";
import { SlidingWindowCircuitBreaker } from "../shared/circuit-breaker";
import { buildRecentCacheKey, buildScopeIndexKey, buildSearchCacheKey, buildSessionCacheKey, buildStartupContextCacheKey } from "./keys";
import { loadMemoryRedisConfig } from "./config";
import { RecallCacheInvalidationError, type CacheOpResult, type RecallCacheRuntime, type MemoryRedisConfig, type RecentCacheEntry, type SessionCacheEntry } from "./types";

interface RedisLike {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(keys: string | string[]): Promise<number>;
  sAdd(key: string, members: string | string[]): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<boolean | number>;
  multi?(): RedisMultiLike;
  ping(): Promise<string>;
  isOpen?: boolean;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface RedisMultiLike {
  sAdd(key: string, members: string | string[]): RedisMultiLike;
  expire(key: string, seconds: number): RedisMultiLike;
  exec(): Promise<unknown>;
}

function isStartupContextQuery(request: RecallRequest, classification: QueryClassification): boolean {
  if (classification.query_type === QueryType.ProjectContext) {
    return true;
  }

  const normalized = request.query.trim().toLowerCase();
  return normalized.includes("startup") || normalized.includes("boot") || normalized.includes("context");
}

function shouldUseRecentCache(classification: QueryClassification): boolean {
  return classification.query_type === QueryType.TimelineHistory || classification.query_type === QueryType.TodoCommitment;
}

function asCacheResult(status: CacheOpResult["status"], reason?: string, key?: string): CacheOpResult {
  return { status, reason, key };
}

export class NoopRecallCache implements RecallCacheRuntime {
  async getSearch(): Promise<null> { return null; }
  async setSearch(): Promise<CacheOpResult> { return asCacheResult("skipped", "redis_not_configured"); }
  async getStartupContext(): Promise<null> { return null; }
  async setStartupContext(): Promise<CacheOpResult> { return asCacheResult("skipped", "redis_not_configured"); }
  async getSession(): Promise<null> { return null; }
  async rememberSession(): Promise<CacheOpResult> { return asCacheResult("skipped", "redis_not_configured"); }
  async getRecent(): Promise<null> { return null; }
  async rememberRecent(): Promise<CacheOpResult> { return asCacheResult("skipped", "redis_not_configured"); }
  async invalidateScopes(): Promise<void> { }
  async getHealthSnapshot(): Promise<Record<string, unknown>> { return { configured: false, available: false, reason: "redis_not_configured" }; }
  async close(): Promise<void> { }
}

export interface RedisRecallCacheOptions {
  readonly config: MemoryRedisConfig;
  readonly client?: RedisLike;
}

export class RedisRecallCache implements RecallCacheRuntime {
  private readonly client: RedisLike;
  private readonly config: MemoryRedisConfig;
  private readonly circuitBreaker: SlidingWindowCircuitBreaker;
  private available = false;
  private lastError: string | undefined;

  constructor(options: RedisRecallCacheOptions) {
    this.config = options.config;
    this.client = options.client ?? this.createDefaultClient(options.config);
    this.circuitBreaker = new SlidingWindowCircuitBreaker({
      windowMs: readRangedInt("MEMORY_V2_REDIS_CIRCUIT_WINDOW_MS", 60_000, 1_000, 600_000),
      minCalls: readRangedInt("MEMORY_V2_REDIS_CIRCUIT_MIN_CALLS", 1, 1, 100),
      failureRate: readRangedFloat("MEMORY_V2_REDIS_CIRCUIT_FAILURE_RATE", 0.5, 0, 1),
      cooldownMs: readRangedInt(
        "MEMORY_V2_REDIS_CIRCUIT_COOLDOWN_MS",
        this.resetTimeoutMs(),
        1,
        600_000
      ),
    });
    if ("on" in this.client && typeof this.client.on === "function") {
      this.client.on("error", (error) => {
        this.available = false;
        this.circuitBreaker.recordFailure();
        this.lastError = error instanceof Error ? error.message : String(error);
      });
      this.client.on("ready", () => {
        this.available = true;
        this.circuitBreaker.recordSuccess();
        this.lastError = undefined;
      });
    }
  }

  private createDefaultClient(config: MemoryRedisConfig): RedisClientType {
    return createClient({
      url: config.url,
      socket: {
        connectTimeout: config.connect_timeout_ms,
        reconnectStrategy: (retries: number) => {
          if (retries > 10) return new Error("Redis 最大重连次数已超过限制");
          const delay = Math.min(retries * 200, 5000);
          return delay;
        }
      }
    });
  }

  async connect(): Promise<void> {
    if (!this.config.url) {
      this.available = false;
      this.lastError = "redis_not_configured";
      return;
    }

    try {
      const maybeOpen = (this.client as { isOpen?: boolean }).isOpen;
      if (!maybeOpen) {
        await this.client.connect();
      }
      this.available = true;
      this.circuitBreaker.recordSuccess();
      this.lastError = undefined;
    } catch (error) {
      this.available = false;
      this.markUnavailable(error);
    }
  }

  private resetTimeoutMs(): number {
    const parsed = Number.parseInt(process.env.MEMORY_V2_REDIS_CACHE_RESET_TIMEOUT_MS ?? "5000", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
  }

  private currentConfig(): MemoryRedisConfig {
    const latest = loadMemoryRedisConfig();
    return {
      ...latest,
      url: this.config.url,
      prefix: this.config.prefix,
      connect_timeout_ms: this.config.connect_timeout_ms,
    };
  }

  private markUnavailable(error: unknown): void {
    this.available = false;
    this.circuitBreaker.recordFailure();
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  private async ensureAvailable(): Promise<boolean> {
    if (!this.config.url) {
      this.lastError = "redis_not_configured";
      return false;
    }
    if (!this.circuitBreaker.canExecute()) {
      this.circuitBreaker.recordFallback();
      return false;
    }
    if (this.available && (this.client as { isOpen?: boolean }).isOpen) return true;
    try {
      const maybeOpen = (this.client as { isOpen?: boolean }).isOpen;
      if (!maybeOpen) {
        await this.client.connect();
      }
      await this.client.ping();
      this.available = true;
      this.circuitBreaker.recordSuccess();
      this.lastError = undefined;
      return true;
    } catch (error) {
      this.markUnavailable(error);
      return false;
    }
  }

  private async safeGet<T>(key: string): Promise<T | null> {
    if (!(await this.ensureAvailable())) {
      return null;
    }

    try {
      const raw = await this.client.get(key);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as T;
    } catch (error) {
      this.markUnavailable(error);
      return null;
    }
  }

  private async safeSet(key: string, value: unknown, ttlSeconds: number): Promise<CacheOpResult> {
    if (!(await this.ensureAvailable())) {
      return asCacheResult(this.config.url ? "fallback" : "skipped", this.lastError ?? "redis_unavailable", key);
    }

    try {
      await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds });
      return asCacheResult("stored", undefined, key);
    } catch (error) {
      this.markUnavailable(error);
      return asCacheResult("fallback", this.lastError, key);
    }
  }

  private async indexKey(scope: RecallScopeRef, key: string, ttlSeconds: number): Promise<void> {
    if (!(await this.ensureAvailable())) {
      return;
    }

    const indexKey = buildScopeIndexKey(this.config.prefix, scope);
    try {
      if (typeof this.client.multi === "function") {
        await this.client.multi()
          .sAdd(indexKey, key)
          .expire(indexKey, ttlSeconds)
          .exec();
      } else {
        await this.client.sAdd(indexKey, key);
        await this.client.expire(indexKey, ttlSeconds);
      }
    } catch (error) {
      this.markUnavailable(error);
    }
  }

  async getSearch(request: RecallRequest): Promise<{ response: RecallResponse; key: string } | null> {
    const key = buildSearchCacheKey(this.config.prefix, request);
    const value = await this.safeGet<RecallResponse>(key);
    return value ? { response: value, key } : null;
  }

  async setSearch(request: RecallRequest, response: RecallResponse): Promise<CacheOpResult> {
    const key = buildSearchCacheKey(this.config.prefix, request);
    const isEmptyResult = !response.results || response.results.length === 0;
    const config = this.currentConfig();
    const searchTtl = isEmptyResult ? config.empty_recall_ttl_seconds : config.ttl_seconds.search;
    const result = await this.safeSet(key, response, searchTtl);
    for (const scope of response.allowed_scope_set) {
      await this.indexKey(scope, key, config.ttl_seconds.search);
    }
    return result;
  }

  async getStartupContext(request: RecallRequest, classification: QueryClassification): Promise<{ response: RecallResponse; key: string } | null> {
    if (!isStartupContextQuery(request, classification)) {
      return null;
    }

    const key = buildStartupContextCacheKey(this.config.prefix, request, classification);
    const value = await this.safeGet<RecallResponse>(key);
    return value ? { response: value, key } : null;
  }

  async setStartupContext(request: RecallRequest, classification: QueryClassification, response: RecallResponse): Promise<CacheOpResult> {
    if (!isStartupContextQuery(request, classification)) {
      return asCacheResult("skipped", "startup_context_not_applicable");
    }

    const key = buildStartupContextCacheKey(this.config.prefix, request, classification);
    const config = this.currentConfig();
    const result = await this.safeSet(key, response, config.ttl_seconds.startup_context);
    for (const scope of response.allowed_scope_set) {
      await this.indexKey(scope, key, config.ttl_seconds.startup_context);
    }
    return result;
  }

  async rememberSession(request: RecallRequest, response: RecallResponse): Promise<CacheOpResult> {
    if (!response.results || response.results.length === 0) {
      return asCacheResult("skipped", "empty_recall_not_session_anchor");
    }
    const key = buildSessionCacheKey(this.config.prefix, request);
    if (!key) {
      return asCacheResult("skipped", "runtime_session_missing");
    }

    const entry: SessionCacheEntry = {
      query: request.query,
      audit_ref: response.audit_ref,
      result_memory_ids: response.results.map((item) => item.memory_id),
      cached_at: new Date().toISOString()
    };
    return await this.safeSet(key, entry, this.currentConfig().ttl_seconds.session);
  }

  async getSession(request: RecallRequest): Promise<{ entry: SessionCacheEntry; key: string } | null> {
    const key = buildSessionCacheKey(this.config.prefix, request);
    if (!key) return null;
    const entry = await this.safeGet<SessionCacheEntry>(key);
    return entry ? { entry, key } : null;
  }

  async rememberRecent(scopes: readonly RecallScopeRef[], response: RecallResponse): Promise<CacheOpResult> {
    if (scopes.length === 0) {
      return asCacheResult("skipped", "no_scopes");
    }

    const key = buildRecentCacheKey(this.config.prefix, scopes);
    if (!key) {
      return asCacheResult("skipped", "no_scopes");
    }

    const entries: RecentCacheEntry[] = response.results.slice(0, 10).map((item) => ({
      memory_id: item.memory_id,
      scope_type: item.scope.type as ScopeType,
      scope_id: item.scope.id,
      title: item.title,
      score: item.score,
      cached_at: new Date().toISOString()
    }));
    const config = this.currentConfig();
    const result = await this.safeSet(key, entries, config.ttl_seconds.recent);
    for (const scope of scopes) {
      await this.indexKey(scope, key, config.ttl_seconds.recent);
    }
    return result;
  }

  async getRecent(scopes: readonly RecallScopeRef[]): Promise<{ entries: readonly RecentCacheEntry[]; key: string } | null> {
    const key = buildRecentCacheKey(this.config.prefix, scopes);
    if (!key) return null;
    const entries = await this.safeGet<RecentCacheEntry[]>(key);
    return entries ? { entries, key } : null;
  }

  async invalidateScopes(scopes: readonly RecallScopeRef[]): Promise<void> {
    if (!(await this.ensureAvailable())) {
      throw new RecallCacheInvalidationError(this.lastError ?? "redis_unavailable");
    }

    for (const scope of scopes) {
      const indexKey = buildScopeIndexKey(this.config.prefix, scope);
      try {
        const keys = await this.client.sMembers(indexKey);
        if (keys.length > 0) {
          await this.client.del(keys);
        }
        await this.client.del(indexKey);
      } catch (error) {
        this.markUnavailable(error);
        throw new RecallCacheInvalidationError(this.lastError ?? "redis_invalidation_failed");
      }
    }
  }

  async getHealthSnapshot(): Promise<Record<string, unknown>> {
    let ping: string | undefined;
    if (await this.ensureAvailable()) {
      try {
        ping = await this.client.ping();
        this.circuitBreaker.recordSuccess();
      } catch (error) {
        this.markUnavailable(error);
      }
    }

    return {
      configured: Boolean(this.config.url),
      available: this.available,
      circuit_state: this.circuitBreaker.snapshot().state,
      circuit_breaker: this.circuitBreaker.snapshot(),
      prefix: this.config.prefix,
      url_configured: Boolean(this.config.url),
      ping,
      last_error: this.lastError,
      ttl_seconds: this.currentConfig().ttl_seconds
    };
  }

  async close(): Promise<void> {
    const maybeOpen = (this.client as { isOpen?: boolean }).isOpen;
    if (maybeOpen) {
      await this.client.quit();
    }
  }
}

export function shouldReadRecentCache(classification: QueryClassification): boolean {
  return shouldUseRecentCache(classification);
}

function readRangedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be in range ${min}-${max}.`);
  }
  return parsed;
}

function readRangedFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  const parsed = raw ? Number.parseFloat(raw) : fallback;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be in range ${min}-${max}.`);
  }
  return parsed;
}
