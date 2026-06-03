import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CircuitBreaker } from "../app/shared/circuit-breaker";

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = new CircuitBreaker();
    assert.equal(cb.currentState, "closed");
    assert.equal(cb.canExecute(), true);
  });

  it("stays closed under threshold failures", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.currentState, "closed");
    assert.equal(cb.canExecute(), true);
  });

  it("opens after reaching failure threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.currentState, "open");
    assert.equal(cb.canExecute(), false);
  });

  it("transitions to half-open after reset timeout", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50 });
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.currentState, "open");

    // Wait for reset timeout
    const start = Date.now();
    while (Date.now() - start < 60) {
      // busy wait
    }

    assert.equal(cb.currentState, "half-open");
    assert.equal(cb.canExecute(), true);
  });

  it("closes after half-open success", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50, halfOpenMaxAttempts: 1 });
    cb.recordFailure();
    cb.recordFailure();

    // Wait for half-open
    const start = Date.now();
    while (Date.now() - start < 60) { /* busy wait */ }

    assert.equal(cb.currentState, "half-open");
    cb.recordSuccess();
    assert.equal(cb.currentState, "closed");
    assert.equal(cb.failureCountValue, 0);
  });

  it("re-opens on half-open failure", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50 });
    cb.recordFailure();
    cb.recordFailure();

    const start = Date.now();
    while (Date.now() - start < 60) { /* busy wait */ }

    assert.equal(cb.currentState, "half-open");
    cb.recordFailure();
    assert.equal(cb.currentState, "open");
  });

  it("success resets failure count in closed state", () => {
    const cb = new CircuitBreaker({ failureThreshold: 5 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.failureCountValue, 3);
    cb.recordSuccess();
    assert.equal(cb.failureCountValue, 0);
  });

  it("reset clears all state", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.currentState, "open");
    cb.reset();
    assert.equal(cb.currentState, "closed");
    assert.equal(cb.failureCountValue, 0);
    assert.equal(cb.canExecute(), true);
  });

  it("tracks failure count correctly", () => {
    const cb = new CircuitBreaker();
    assert.equal(cb.failureCountValue, 0);
    cb.recordFailure();
    assert.equal(cb.failureCountValue, 1);
    cb.recordFailure();
    assert.equal(cb.failureCountValue, 2);
  });

  it("uses default options when none provided", () => {
    const cb = new CircuitBreaker();
    // Default threshold is 5
    for (let i = 0; i < 4; i++) cb.recordFailure();
    assert.equal(cb.currentState, "closed");
    cb.recordFailure();
    assert.equal(cb.currentState, "open");
  });
});
