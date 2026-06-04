import { readRuntimeControlValueSync } from "../runtime-control-settings";

export interface RateLimiterOptions {
  readonly maxRequests: number;
  readonly windowMs: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly defaultMaxRequests: number;
  private readonly defaultWindowMs: number;

  constructor(options?: Partial<RateLimiterOptions>) {
    this.defaultMaxRequests = options?.maxRequests ?? 60;
    this.defaultWindowMs = options?.windowMs ?? 60_000;
  }

  private currentOptions(): RateLimiterOptions {
    const runtime = loadRateLimiterConfig(process.env);
    const maxRequests = Number.isFinite(runtime.maxRequests) && Number(runtime.maxRequests) > 0
      ? Number(runtime.maxRequests)
      : this.defaultMaxRequests;
    const windowMs = Number.isFinite(runtime.windowMs) && Number(runtime.windowMs) > 0
      ? Number(runtime.windowMs)
      : this.defaultWindowMs;
    return { maxRequests, windowMs };
  }

  isAllowed(clientId: string): boolean {
    const now = Date.now();
    const { maxRequests, windowMs } = this.currentOptions();
    let bucket = this.buckets.get(clientId);

    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(clientId, bucket);
    }

    bucket.count++;
    return bucket.count <= maxRequests;
  }

  getRetryAfterSeconds(clientId: string): number {
    const bucket = this.buckets.get(clientId);
    if (!bucket) return 0;
    const { windowMs } = this.currentOptions();
    const elapsed = Date.now() - bucket.windowStart;
    return Math.max(0, Math.ceil((windowMs - elapsed) / 1000));
  }

  reset(clientId: string): void {
    this.buckets.delete(clientId);
  }
}

export function loadRateLimiterConfig(env: NodeJS.ProcessEnv): Partial<RateLimiterOptions> {
  const envMax = env.MEMORY_XX_RATE_LIMIT_MAX
    ? Number.parseInt(env.MEMORY_XX_RATE_LIMIT_MAX, 10)
    : undefined;
  const envWindow = env.MEMORY_XX_RATE_LIMIT_WINDOW_MS
    ? Number.parseInt(env.MEMORY_XX_RATE_LIMIT_WINDOW_MS, 10)
    : undefined;
  const runtimeMax = readRuntimeControlValueSync("write.rate_limit.max_requests");
  const runtimeWindow = readRuntimeControlValueSync("write.rate_limit.window_ms");
  return {
    maxRequests: runtimeMax !== undefined ? Number.parseInt(String(runtimeMax), 10) : envMax,
    windowMs: runtimeWindow !== undefined ? Number.parseInt(String(runtimeWindow), 10) : envWindow,
  };
}
