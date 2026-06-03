import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, loadRateLimiterConfig } from "../app/server/rate-limiter.js";

describe("RateLimiter", () => {
  it("allows requests under limit", () => {
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    assert.strictEqual(limiter.isAllowed("client-a"), true);
    assert.strictEqual(limiter.isAllowed("client-a"), true);
    assert.strictEqual(limiter.isAllowed("client-a"), true);
  });

  it("blocks requests over limit", () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
    limiter.isAllowed("client-a");
    limiter.isAllowed("client-a");
    assert.strictEqual(limiter.isAllowed("client-a"), false);
  });

  it("resets after window expires", () => {
    const originalNow = Date.now;
    const baseTime = 1_000_000;
    let mockTime = baseTime;
    Date.now = () => mockTime;

    try {
      const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
      // First call: allowed (bucket created at baseTime, count=1)
      assert.strictEqual(limiter.isAllowed("client-a"), true);
      // Second call: blocked (same window, count=2 > maxRequests=1)
      assert.strictEqual(limiter.isAllowed("client-a"), false);
      // Advance time past the window
      mockTime = baseTime + 61_000;
      // Window has expired, should allow again
      assert.strictEqual(limiter.isAllowed("client-a"), true);
    } finally {
      Date.now = originalNow;
    }
  });

  it("different clients have separate buckets", () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    assert.strictEqual(limiter.isAllowed("client-a"), true);
    assert.strictEqual(limiter.isAllowed("client-b"), true);
    // client-a should now be blocked, client-b too, independently
    assert.strictEqual(limiter.isAllowed("client-a"), false);
    assert.strictEqual(limiter.isAllowed("client-b"), false);
  });

  it("getRetryAfterSeconds returns correct value", () => {
    const now = Date.now();
    const originalNow = Date.now;
    let mockNow = now;
    Date.now = () => mockNow;

    try {
      const limiter = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });
      limiter.isAllowed("client-a");

      // 3 seconds into the window, 7 seconds remain
      mockNow = now + 3_000;
      const retry = limiter.getRetryAfterSeconds("client-a");
      assert.ok(retry >= 6 && retry <= 7, `expected ~7 but got ${retry}`);
    } finally {
      Date.now = originalNow;
    }
  });

  it("getRetryAfterSeconds returns 0 for unknown client", () => {
    const limiter = new RateLimiter();
    assert.strictEqual(limiter.getRetryAfterSeconds("unknown"), 0);
  });

  it("reset clears a specific client", () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    limiter.isAllowed("client-a");
    limiter.isAllowed("client-b");
    limiter.reset("client-a");
    // client-a should be allowed again
    assert.strictEqual(limiter.isAllowed("client-a"), true);
    // client-b should still be blocked (used its 1 request before reset)
    assert.strictEqual(limiter.isAllowed("client-b"), false);
  });

  it("loadRateLimiterConfig parses env vars", () => {
    const config = loadRateLimiterConfig({
      MEMORY_V2_RATE_LIMIT_MAX: "100",
      MEMORY_V2_RATE_LIMIT_WINDOW_MS: "120000",
    });
    assert.strictEqual(config.maxRequests, 100);
    assert.strictEqual(config.windowMs, 120_000);
  });

  it("loadRateLimiterConfig returns undefined for missing env vars", () => {
    const config = loadRateLimiterConfig({});
    assert.strictEqual(config.maxRequests, undefined);
    assert.strictEqual(config.windowMs, undefined);
  });

  it("constructor uses defaults when no options given", () => {
    const limiter = new RateLimiter();
    // Defaults: maxRequests=60, windowMs=60000
    // Verify by making 60 requests -- all should succeed
    for (let i = 0; i < 60; i++) {
      assert.strictEqual(limiter.isAllowed("client"), true);
    }
    // The 61st should be blocked
    assert.strictEqual(limiter.isAllowed("client"), false);
  });
});
