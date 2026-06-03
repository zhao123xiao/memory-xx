import { createClient, type RedisClientType } from "redis";
import { createHash } from "node:crypto";

import type {
  QueryEmbeddingSharedCache,
  QueryEmbeddingSharedCacheResult,
} from "./query-embedding-resilience";

export interface RedisQueryEmbeddingCacheOptions {
  readonly url?: string;
  readonly prefix: string;
  readonly connect_timeout_ms: number;
  readonly client?: RedisLike;
}

interface RedisLike {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  ping(): Promise<string>;
  isOpen?: boolean;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface CachePayload {
  readonly embedding: readonly number[];
  readonly cached_at: string;
}

function cacheKey(prefix: string, keyMaterial: string): string {
  const digest = createHash("sha256").update(keyMaterial).digest("hex");
  return [prefix, "cache", "query-embedding", digest].join(":");
}

function staleCacheKey(prefix: string, keyMaterial: string): string {
  const digest = createHash("sha256").update(keyMaterial).digest("hex");
  return [prefix, "cache", "query-embedding-stale", digest].join(":");
}

export class RedisQueryEmbeddingCache implements QueryEmbeddingSharedCache {
  private readonly client: RedisLike;
  private readonly prefix: string;
  private readonly configured: boolean;
  private available = false;
  private lastError: string | undefined;
  private circuitState: "closed" | "open" | "half_open" = "open";
  private nextProbeAt = 0;
  private readonly resetAfterMs = 30_000;
  private stats = {
    hits: 0,
    misses: 0,
    stores: 0,
    fallbacks: 0,
  };

  constructor(options: RedisQueryEmbeddingCacheOptions) {
    this.prefix = options.prefix;
    this.configured = Boolean(options.url);
    this.client = options.client ?? this.createDefaultClient(options);
    if ("on" in this.client && typeof this.client.on === "function") {
      this.client.on("error", (error) => {
        this.openCircuit(error);
      });
      this.client.on("ready", () => {
        this.closeCircuit();
      });
    }
  }

  private createDefaultClient(options: RedisQueryEmbeddingCacheOptions): RedisClientType {
    return createClient({
      url: options.url,
      socket: {
        connectTimeout: options.connect_timeout_ms,
        reconnectStrategy: (retries: number) => {
          if (retries > 10) return new Error("Redis 最大重连次数已超过限制");
          return Math.min(retries * 200, 5000);
        },
      },
    });
  }

  private openCircuit(error: unknown): void {
    this.available = false;
    this.circuitState = "open";
    this.nextProbeAt = Date.now() + this.resetAfterMs;
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  private closeCircuit(): void {
    this.available = true;
    this.circuitState = "closed";
    this.nextProbeAt = 0;
    this.lastError = undefined;
  }

  private async ensureAvailable(): Promise<boolean> {
    if (!this.configured) {
      this.available = false;
      this.circuitState = "open";
      this.lastError = "redis_not_configured";
      return false;
    }
    if (this.circuitState === "open" && Date.now() < this.nextProbeAt) {
      return false;
    }
    try {
      if (!(this.client as { isOpen?: boolean }).isOpen) {
        await this.client.connect();
      }
      if (this.circuitState === "open") {
        this.circuitState = "half_open";
      }
      await this.client.ping();
      this.closeCircuit();
      return true;
    } catch (error) {
      this.openCircuit(error);
      return false;
    }
  }

  async connect(): Promise<void> {
    if (!this.configured) {
      this.available = false;
      this.lastError = "redis_not_configured";
      return;
    }
    try {
      if (!(this.client as { isOpen?: boolean }).isOpen) {
        await this.client.connect();
      }
      await this.client.ping();
      this.closeCircuit();
    } catch (error) {
      this.openCircuit(error);
    }
  }

  async get(keyMaterial: string): Promise<QueryEmbeddingSharedCacheResult> {
    if (!(await this.ensureAvailable())) {
      this.stats.fallbacks += 1;
      return {
        status: this.configured ? "fallback" : "skipped",
        error: this.lastError ?? (this.configured ? "redis_unavailable" : "redis_not_configured"),
      };
    }
    try {
      const primaryKey = cacheKey(this.prefix, keyMaterial);
      const raw = await this.client.get(primaryKey) ?? await this.client.get(staleCacheKey(this.prefix, keyMaterial));
      if (!raw) {
        this.stats.misses += 1;
        return { status: "miss" };
      }
      const parsed = JSON.parse(raw) as CachePayload;
      if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) {
        this.stats.fallbacks += 1;
        return { status: "fallback", error: "invalid_cached_embedding" };
      }
      this.stats.hits += 1;
      return { status: "hit", embedding: parsed.embedding };
    } catch (error) {
      this.openCircuit(error);
      this.stats.fallbacks += 1;
      return { status: "fallback", error: this.lastError };
    }
  }

  async set(keyMaterial: string, embedding: readonly number[], ttlSeconds: number): Promise<QueryEmbeddingSharedCacheResult> {
    if (!(await this.ensureAvailable())) {
      this.stats.fallbacks += 1;
      return {
        status: this.configured ? "fallback" : "skipped",
        error: this.lastError ?? (this.configured ? "redis_unavailable" : "redis_not_configured"),
      };
    }
    try {
      const payload = JSON.stringify({
        embedding,
        cached_at: new Date().toISOString(),
      } satisfies CachePayload);
      await this.client.set(cacheKey(this.prefix, keyMaterial), payload, { EX: ttlSeconds });
      await this.client.set(staleCacheKey(this.prefix, keyMaterial), payload, { EX: Math.max(ttlSeconds * 6, ttlSeconds + 300) });
      this.stats.stores += 1;
      return { status: "miss" };
    } catch (error) {
      this.openCircuit(error);
      this.stats.fallbacks += 1;
      return { status: "fallback", error: this.lastError };
    }
  }

  getHealthSnapshot(): Record<string, unknown> {
    return {
      configured: this.configured,
      available: this.available,
      circuit_state: this.circuitState,
      next_probe_at: this.nextProbeAt > 0 ? new Date(this.nextProbeAt).toISOString() : null,
      prefix: this.prefix,
      last_error: this.lastError,
      stats: { ...this.stats },
    };
  }

  async close(): Promise<void> {
    if ((this.client as { isOpen?: boolean }).isOpen) {
      await this.client.quit();
    }
  }
}
