import type { MemoryRedisConfig } from "./types";
import { createLogger } from "../shared/logger";
import { readRuntimeControlNumberSync } from "../runtime-control-settings";

const log = createLogger("redis-config");

function parsePositiveInt(value: string | undefined, fallback: number, name = "env"): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (value !== undefined && value.trim() !== "") {
    log.warn("Invalid environment value; using fallback", { name, value, fallback });
  }
  return fallback;
}

function runtimePositiveInt(key: string, envValue: string | undefined, fallback: number, name: string): number {
  const envParsed = parsePositiveInt(envValue, fallback, name);
  const runtimeParsed = readRuntimeControlNumberSync(key, envParsed);
  return Number.isFinite(runtimeParsed) && runtimeParsed > 0 ? runtimeParsed : envParsed;
}

export function loadMemoryRedisConfig(env: NodeJS.ProcessEnv = process.env): MemoryRedisConfig {
  return {
    url: env.MEMORY_V2_REDIS_URL?.trim() || undefined,
    prefix: env.MEMORY_V2_REDIS_PREFIX?.trim() || "memory-xx",
    connect_timeout_ms: runtimePositiveInt("cache.redis.connect_timeout_ms", env.MEMORY_V2_REDIS_CONNECT_TIMEOUT_MS, 2000, "MEMORY_V2_REDIS_CONNECT_TIMEOUT_MS"),
    empty_recall_ttl_seconds: runtimePositiveInt("cache.redis.empty_recall_ttl_seconds", env.MEMORY_V2_EMPTY_RECALL_CACHE_TTL_SECONDS, 15, "MEMORY_V2_EMPTY_RECALL_CACHE_TTL_SECONDS"),
    ttl_seconds: {
      search: runtimePositiveInt("cache.redis.ttl.search_seconds", env.MEMORY_V2_REDIS_TTL_SEARCH_SECONDS, 300, "MEMORY_V2_REDIS_TTL_SEARCH_SECONDS"),
      session: runtimePositiveInt("cache.redis.ttl.session_seconds", env.MEMORY_V2_REDIS_TTL_SESSION_SECONDS, 1800, "MEMORY_V2_REDIS_TTL_SESSION_SECONDS"),
      recent: runtimePositiveInt("cache.redis.ttl.recent_seconds", env.MEMORY_V2_REDIS_TTL_RECENT_SECONDS, 900, "MEMORY_V2_REDIS_TTL_RECENT_SECONDS"),
      startup_context: runtimePositiveInt("cache.redis.ttl.startup_context_seconds", env.MEMORY_V2_REDIS_TTL_STARTUP_CONTEXT_SECONDS, 600, "MEMORY_V2_REDIS_TTL_STARTUP_CONTEXT_SECONDS")
    }
  };
}
