import type { RecallCacheRuntime } from "./types";
import type { ScopeType } from "../shared";
import { CacheInvalidationRequestRepository } from "../db/repositories/cache-invalidation-request-repository";
import { withWriteTransaction, type WriteTransactionRunner } from "../db/tx/write-transaction";

export interface MemoryCacheInvalidationScope {
  readonly type: ScopeType;
  readonly id: string;
}

export interface MemoryCacheInvalidator {
  invalidate(scopes: readonly MemoryCacheInvalidationScope[]): Promise<void>;
}

export interface RecallRuntimeCacheInvalidatorOptions {
  readonly fastpathEnabled?: boolean;
  readonly fastpathBaseUrl?: string | null;
  readonly fastpathTimeoutMs?: number;
  readonly fetcher?: typeof fetch;
  readonly database?: WriteTransactionRunner | null;
  readonly strict?: boolean;
  readonly persistFailures?: boolean;
}

export interface FastpathInvalidationFailure {
  readonly scope: MemoryCacheInvalidationScope;
  readonly status?: number;
  readonly error?: string;
  readonly at: string;
}

const fastpathInvalidationFailures: FastpathInvalidationFailure[] = [];

export interface CacheInvalidationWorkerSummary {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
}

export interface CacheInvalidationWorkerOptions {
  readonly database: WriteTransactionRunner;
  readonly invalidator: MemoryCacheInvalidator;
  readonly repository?: CacheInvalidationRequestRepository;
  readonly workerId?: string;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly leaseTtlSeconds?: number;
  readonly retryDelaySeconds?: (attempts: number) => number;
  readonly pollIntervalMs?: number;
}

export function getFastpathInvalidationFailures(): readonly FastpathInvalidationFailure[] {
  return [...fastpathInvalidationFailures];
}

export function clearFastpathInvalidationFailures(): void {
  fastpathInvalidationFailures.splice(0, fastpathInvalidationFailures.length);
}

export class CacheInvalidationWorker {
  private readonly repository: CacheInvalidationRequestRepository;
  private readonly workerId: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly options: CacheInvalidationWorkerOptions) {
    this.repository = options.repository ?? new CacheInvalidationRequestRepository();
    this.workerId = options.workerId ?? `cache-invalidation-${process.pid}`;
  }

  async processOnce(): Promise<CacheInvalidationWorkerSummary> {
    const rows = await withWriteTransaction(this.options.database, (tx) => this.repository.claimNext(tx, {
      workerId: this.workerId,
      limit: this.options.batchSize ?? 100,
      leaseTtlSeconds: this.options.leaseTtlSeconds ?? 120,
      maxAttempts: this.options.maxAttempts ?? 10
    }));
    let completed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await this.options.invalidator.invalidate([{ type: row.scopeType, id: row.scopeId }]);
        await withWriteTransaction(this.options.database, (tx) => this.repository.markCompleted(tx, row.id));
        completed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const delay = this.options.retryDelaySeconds?.(row.attempts) ?? 60;
        await withWriteTransaction(this.options.database, (tx) => this.repository.markFailed(tx, row.id, message, delay));
        failed += 1;
      }
    }
    return { claimed: rows.length, completed, failed };
  }

  start(): void {
    if (this.timer) return;
    const poll = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.processOnce();
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => {
      void poll().catch(() => undefined);
    }, this.options.pollIntervalMs ?? 10_000);
    void poll().catch(() => undefined);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export class RecallRuntimeCacheInvalidator implements MemoryCacheInvalidator {
  constructor(
    private readonly recallCache: RecallCacheRuntime,
    private readonly options: RecallRuntimeCacheInvalidatorOptions = {}
  ) {}

  async invalidate(scopes: readonly MemoryCacheInvalidationScope[]): Promise<void> {
    const failures: string[] = [];
    try {
      await this.recallCache.invalidateScopes(scopes);
    } catch (error) {
      const reason = `redis:${error instanceof Error ? error.message : String(error)}`;
      failures.push(reason);
      await this.enqueueFailures(scopes, reason);
    }
    failures.push(...await this.invalidateFastpath(scopes));
    if (this.options.strict === true && failures.length > 0) {
      throw new Error(`cache_invalidation_failed:${failures.join(";")}`);
    }
  }

  private async enqueueFailures(scopes: readonly MemoryCacheInvalidationScope[], reason: string): Promise<void> {
    if (this.options.persistFailures === false || !this.options.database || scopes.length === 0) return;
    const repo = new CacheInvalidationRequestRepository();
    await withWriteTransaction(this.options.database, async (tx) => {
      for (const scope of scopes) {
        await repo.enqueue(tx, {
          scopeType: scope.type,
          scopeId: scope.id,
          reason
        });
      }
    }).catch(() => undefined);
  }

  private shouldInvalidateFastpath(): boolean {
    if (this.options.fastpathEnabled !== undefined) {
      return this.options.fastpathEnabled;
    }
    if (process.env.MEMORY_XX_FASTPATH_CACHE_INVALIDATE_ENABLED === "false") {
      return false;
    }
    if (process.env.MEMORY_XX_FASTPATH_CACHE_INVALIDATE_ENABLED === "true") {
      return true;
    }
    return (process.env.MEMORY_XX_RECALL_PRIMARY ?? "").toLowerCase() === "fastpath";
  }

  private fastpathBaseUrl(): string {
    return (this.options.fastpathBaseUrl ?? process.env.MEMORY_XX_FASTPATH_URL ?? "http://127.0.0.1:5200").replace(/\/+$/, "");
  }

  private async invalidateFastpath(scopes: readonly MemoryCacheInvalidationScope[]): Promise<string[]> {
    const failures: string[] = [];
    if (!this.shouldInvalidateFastpath() || scopes.length === 0) {
      return failures;
    }

    const fetcher = this.options.fetcher ?? fetch;
    const timeoutMs = this.options.fastpathTimeoutMs ?? Number.parseInt(process.env.MEMORY_XX_FASTPATH_CACHE_INVALIDATE_TIMEOUT_MS ?? "500", 10);
    for (const scope of scopes) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 500);
      try {
        const token = process.env.MEMORY_XX_FASTPATH_ADMIN_TOKEN?.trim() || process.env.MEMORY_XX_ADMIN_TOKEN?.trim();
        const response = await fetcher(`${this.fastpathBaseUrl()}/admin/cache/invalidate`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ scopeType: scope.type, scopeId: scope.id }),
          signal: controller.signal
        });
        if (response.status === 404) {
          continue;
        }
        if (!response.ok) {
          const reason = `fastpath_http_${response.status}`;
          failures.push(reason);
          await this.enqueueFailures([scope], reason);
          fastpathInvalidationFailures.push({
            scope,
            status: response.status,
            at: new Date().toISOString()
          });
        }
      } catch (error) {
        const reason = `fastpath:${error instanceof Error ? error.message : String(error)}`;
        failures.push(reason);
        await this.enqueueFailures([scope], reason);
        fastpathInvalidationFailures.push({
          scope,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString()
        });
      } finally {
        clearTimeout(timeout);
      }
    }
    return failures;
  }
}
