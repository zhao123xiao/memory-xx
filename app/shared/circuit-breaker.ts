type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly halfOpenMaxAttempts: number;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 1,
};

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenSuccesses = 0;
  private readonly options: CircuitBreakerOptions;

  constructor(options?: Partial<CircuitBreakerOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get currentState(): CircuitState {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.options.resetTimeoutMs) {
        this.state = "half-open";
        this.halfOpenSuccesses = 0;
      }
    }
    return this.state;
  }

  get failureCountValue(): number {
    return this.failureCount;
  }

  canExecute(): boolean {
    return this.currentState !== "open";
  }

  recordSuccess(): void {
    if (this.state === "half-open") {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.options.halfOpenMaxAttempts) {
        this.state = "closed";
        this.failureCount = 0;
      }
    } else {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === "half-open") {
      this.state = "open";
    } else if (this.failureCount >= this.options.failureThreshold) {
      this.state = "open";
    }
  }

  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.halfOpenSuccesses = 0;
  }
}

export interface SlidingWindowCircuitBreakerOptions {
  readonly windowMs: number;
  readonly minCalls: number;
  readonly failureRate: number;
  readonly cooldownMs: number;
  readonly halfOpenMaxAttempts?: number;
  readonly clock?: () => number;
}

export interface CircuitBreakerSnapshot {
  readonly state: CircuitState;
  readonly open_count: number;
  readonly fallback_count: number;
  readonly window_calls: number;
  readonly window_failures: number;
}

interface SlidingWindowCall {
  readonly at: number;
  readonly ok: boolean;
}

export class SlidingWindowCircuitBreaker {
  private state: CircuitState = "closed";
  private openedAt = 0;
  private openCount = 0;
  private fallbackCount = 0;
  private halfOpenAttempts = 0;
  private readonly calls: SlidingWindowCall[] = [];
  private readonly clock: () => number;

  constructor(private readonly options: SlidingWindowCircuitBreakerOptions) {
    this.clock = options.clock ?? Date.now;
  }

  canExecute(): boolean {
    if (this.state === "open" && this.clock() - this.openedAt >= this.options.cooldownMs) {
      this.state = "half-open";
      this.halfOpenAttempts = 0;
    }
    if (this.state !== "half-open") {
      return this.state !== "open";
    }
    const maxAttempts = this.options.halfOpenMaxAttempts ?? 1;
    if (this.halfOpenAttempts >= maxAttempts) {
      return false;
    }
    this.halfOpenAttempts += 1;
    return true;
  }

  recordFallback(): void {
    this.fallbackCount += 1;
  }

  recordSuccess(): void {
    if (this.state === "half-open") {
      this.close();
      return;
    }
    this.record(true);
  }

  recordFailure(): void {
    if (this.state === "half-open") {
      this.open();
      return;
    }
    this.record(false);
    this.tripIfNeeded();
  }

  snapshot(): CircuitBreakerSnapshot {
    this.prune();
    const failures = this.calls.filter((call) => !call.ok).length;
    return {
      state: this.state,
      open_count: this.openCount,
      fallback_count: this.fallbackCount,
      window_calls: this.calls.length,
      window_failures: failures,
    };
  }

  private record(ok: boolean): void {
    this.calls.push({ at: this.clock(), ok });
    this.prune();
  }

  private prune(): void {
    const cutoff = this.clock() - this.options.windowMs;
    while (this.calls.length > 0 && this.calls[0]!.at < cutoff) {
      this.calls.shift();
    }
  }

  private tripIfNeeded(): void {
    if (this.calls.length < this.options.minCalls) return;
    const failures = this.calls.filter((call) => !call.ok).length;
    if (failures / this.calls.length >= this.options.failureRate) {
      this.open();
    }
  }

  private open(): void {
    if (this.state !== "open") {
      this.openCount += 1;
    }
    this.state = "open";
    this.openedAt = this.clock();
  }

  private close(): void {
    this.state = "closed";
    this.halfOpenAttempts = 0;
    this.calls.length = 0;
  }
}
