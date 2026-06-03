import { createHash, randomUUID } from "node:crypto";
import { createClient } from "redis";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_SIMILARITY_THRESHOLD = 0.92;

interface ActiveEmbedding {
  readonly key: string;
  readonly scopeKey: string;
  readonly embedding: readonly number[];
  readonly expiresAt: number;
  resolve(): void;
  readonly done: Promise<void>;
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < length; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SemanticWriteLockAcquireResult {
  readonly key: string;
  readonly waited: boolean;
  readonly timed_out: boolean;
  release(): void;
}

export class SemanticWriteLock {
  private static readonly active = new Map<string, ActiveEmbedding>();
  private static redisClient: RedisSemanticClient | null = null;
  private static redisClientUrl: string | null = null;

  async acquire(input: {
    readonly scopeType: string;
    readonly scopeId: string;
    readonly embedding: readonly number[] | null;
    readonly ttlMs?: number;
    readonly waitTimeoutMs?: number;
  }): Promise<SemanticWriteLockAcquireResult> {
    if ((process.env.MEMORY_V2_SEMANTIC_LOCK_BACKEND?.trim() || "local") === "redis") {
      try {
        const redisResult = await this.acquireRedis(input);
        if (redisResult) return redisResult;
      } catch (error) {
        if (configuredInstanceCount() > 1) throw error;
      }
    }

    const scopeKey = `${input.scopeType}:${input.scopeId}`;
    const embedding = input.embedding;
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
    const waitTimeoutMs = input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.prune();
    let waited = false;
    let timedOut = false;

    if (embedding && embedding.length > 0) {
      const existing = this.findSimilar(scopeKey, embedding);
      if (existing) {
        waited = true;
        timedOut = !(await waitFor(existing.done, waitTimeoutMs));
      }
    }

    const key = `${scopeKey}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let resolve!: () => void;
    const done = new Promise<void>((doneResolve) => { resolve = doneResolve; });
    if (embedding && embedding.length > 0) {
      SemanticWriteLock.active.set(key, {
        key,
        scopeKey,
        embedding,
        expiresAt: Date.now() + ttlMs,
        resolve,
        done,
      });
    }
    return {
      key,
      waited,
      timed_out: timedOut,
      release: () => {
        const active = SemanticWriteLock.active.get(key);
        active?.resolve();
        SemanticWriteLock.active.delete(key);
      },
    };
  }

  private async acquireRedis(input: {
    readonly scopeType: string;
    readonly scopeId: string;
    readonly embedding: readonly number[] | null;
    readonly ttlMs?: number;
    readonly waitTimeoutMs?: number;
  }): Promise<SemanticWriteLockAcquireResult | null> {
    const url = process.env.MEMORY_V2_REDIS_URL?.trim() || process.env.REDIS_URL?.trim() || "";
    if (!url) {
      if (configuredInstanceCount() > 1) {
        throw new Error("redis_semantic_lock_unconfigured");
      }
      return null;
    }
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
    const waitTimeoutMs = input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const key = redisLockKey(input.scopeType, input.scopeId, input.embedding);
    const token = randomUUID();
    let waited = false;
    const started = Date.now();
    const client = await SemanticWriteLock.redis(url);

    while (Date.now() - started <= waitTimeoutMs) {
      const acquired = await client.set(key, token, { NX: true, PX: ttlMs });
      if (acquired) {
        return {
          key,
          waited,
          timed_out: false,
          release: () => {
            void releaseRedisLock(client, key, token);
          },
        };
      }
      waited = true;
      await sleep(100);
    }

    return {
      key,
      waited,
      timed_out: true,
      release: () => undefined,
    };
  }

  private static async redis(url: string): Promise<RedisSemanticClient> {
    if (SemanticWriteLock.redisClient && SemanticWriteLock.redisClientUrl === url && SemanticWriteLock.redisClient.isOpen) {
      return SemanticWriteLock.redisClient;
    }
    const client = createClient({ url }) as unknown as RedisSemanticClient;
    await client.connect();
    SemanticWriteLock.redisClient = client;
    SemanticWriteLock.redisClientUrl = url;
    return client;
  }

  private findSimilar(scopeKey: string, embedding: readonly number[]): ActiveEmbedding | null {
    const threshold = readDedupeEmbeddingThreshold();
    for (const active of SemanticWriteLock.active.values()) {
      if (active.scopeKey !== scopeKey) continue;
      if (cosineSimilarity(active.embedding, embedding) >= threshold) return active;
    }
    return null;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, active] of SemanticWriteLock.active.entries()) {
      if (active.expiresAt <= now) {
        active.resolve();
        SemanticWriteLock.active.delete(key);
      }
    }
  }

  static clear(): void {
    for (const active of SemanticWriteLock.active.values()) active.resolve();
    SemanticWriteLock.active.clear();
  }
}

function configuredInstanceCount(): number {
  const parsed = Number.parseInt(process.env.MEMORY_V2_INSTANCE_COUNT?.trim() || "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function readDedupeEmbeddingThreshold(): number {
  const raw = process.env.MEMORY_V2_INTELLIGENCE_DEDUPE_EMBEDDING_THRESHOLD?.trim();
  if (!raw) return DEFAULT_SIMILARITY_THRESHOLD;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 1) {
    throw new Error("MEMORY_V2_INTELLIGENCE_DEDUPE_EMBEDDING_THRESHOLD 必须在 0.5 到 1 之间。");
  }
  return parsed;
}

interface RedisSemanticClient {
  readonly isOpen?: boolean;
  connect(): Promise<unknown>;
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

function redisLockKey(scopeType: string, scopeId: string, embedding: readonly number[] | null): string {
  const embeddingFingerprint = embedding && embedding.length > 0
    ? createHash("sha256")
      .update(embedding.map((value) => Number(value).toFixed(6)).join(","))
      .digest("hex")
      .slice(0, 24)
    : "no-embedding";
  return `memory-xx:semantic-lock:${scopeType}:${scopeId}:${embeddingFingerprint}`;
}

async function releaseRedisLock(client: RedisSemanticClient, key: string, token: string): Promise<void> {
  try {
    await client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      { keys: [key], arguments: [token] }
    );
  } catch {
    // Best-effort unlock; TTL bounds stale lock lifetime.
  }
}

async function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timedOut = false;
  await Promise.race([
    promise,
    sleep(timeoutMs).then(() => { timedOut = true; }),
  ]);
  return !timedOut;
}

export { cosineSimilarity };
