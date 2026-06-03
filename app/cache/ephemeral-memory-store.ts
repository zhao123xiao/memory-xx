import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

import { loadMemoryRedisConfig } from "./config";
import type { MemoryRedisConfig } from "./types";
import type { JsonObject, JsonValue } from "../shared";

export interface EphemeralRedisLike {
  connect(): Promise<unknown>;
  quit?(): Promise<unknown>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  ping?(): Promise<string>;
  isOpen?: boolean;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface EphemeralMemoryStoreOptions {
  readonly config?: MemoryRedisConfig;
  readonly client?: EphemeralRedisLike;
  readonly now?: () => Date;
}

export interface RememberEphemeralMemoryInput {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly content: string;
  readonly ttlSeconds: number;
  readonly metadata?: JsonObject;
}

export interface RememberEphemeralMemoryResult {
  readonly status: "stored" | "skipped" | "fallback";
  readonly key?: string;
  readonly reason?: string;
  readonly ttl_seconds: number;
  readonly expires_at: string;
}

export class EphemeralMemoryStore {
  private readonly config: MemoryRedisConfig;
  private readonly client?: EphemeralRedisLike;
  private readonly now: () => Date;

  constructor(options: EphemeralMemoryStoreOptions = {}) {
    this.config = options.config ?? loadMemoryRedisConfig();
    this.client = options.client ?? (this.config.url ? this.createDefaultClient(this.config) : undefined);
    this.now = options.now ?? (() => new Date());
  }

  private createDefaultClient(config: MemoryRedisConfig): RedisClientType {
    return createClient({
      url: config.url,
      socket: {
        connectTimeout: config.connect_timeout_ms,
        reconnectStrategy: (retries: number) => retries > 10 ? new Error("Redis 最大重连次数已超过限制") : Math.min(retries * 200, 5000),
      },
    });
  }

  async remember(input: RememberEphemeralMemoryInput): Promise<RememberEphemeralMemoryResult> {
    const ttlSeconds = Math.max(1, Math.floor(input.ttlSeconds));
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const key = this.buildKey(input);
    if (!this.config.url || !this.client) {
      return {
        status: "skipped",
        key,
        reason: "redis_not_configured",
        ttl_seconds: ttlSeconds,
        expires_at: expiresAt,
      };
    }

    try {
      if (!this.client.isOpen) {
        await this.client.connect();
      }
      if (this.client.ping) {
        await this.client.ping();
      }
      await this.client.set(key, JSON.stringify({
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        content: input.content,
        metadata: input.metadata ?? {},
        created_at: now.toISOString(),
        expires_at: expiresAt,
        ttl_seconds: ttlSeconds,
      } satisfies Record<string, JsonValue>), { EX: ttlSeconds });
      return {
        status: "stored",
        key,
        ttl_seconds: ttlSeconds,
        expires_at: expiresAt,
      };
    } catch (error) {
      return {
        status: "fallback",
        key,
        reason: error instanceof Error ? error.message : String(error),
        ttl_seconds: ttlSeconds,
        expires_at: expiresAt,
      };
    }
  }

  private buildKey(input: RememberEphemeralMemoryInput): string {
    const hash = createHash("sha256")
      .update(JSON.stringify({
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        content: input.content,
        metadata: input.metadata ?? {},
      }))
      .digest("hex")
      .slice(0, 16);
    return `${this.config.prefix}:ephemeral-memory:${input.scopeType}:${input.scopeId}:${hash}`;
  }
}
