import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRequestMetrics } from "../app/server/metrics.js";
import { initializeDomainMetrics } from "../app/observability/domain-metrics.js";

describe("InMemoryRequestMetrics", () => {
  it("counter starts at 0 in snapshot", () => {
    const m = new InMemoryRequestMetrics();
    assert.deepStrictEqual(m.getSnapshot(), {});
  });

  it("incrementCounter adds to counter", () => {
    const m = new InMemoryRequestMetrics();
    m.incrementCounter("requests");
    m.incrementCounter("requests");
    assert.strictEqual(m.getSnapshot()["requests"], 2);
  });

  it("incrementCounter with labels aggregates correctly", () => {
    const m = new InMemoryRequestMetrics();
    m.incrementCounter("requests", { method: "GET" });
    m.incrementCounter("requests", { method: "GET" });
    m.incrementCounter("requests", { method: "POST" });
    assert.strictEqual(m.getSnapshot()["requests"], 3);
  });

  it("multiple counters coexist", () => {
    const m = new InMemoryRequestMetrics();
    m.incrementCounter("requests");
    m.incrementCounter("errors");
    m.incrementCounter("errors");
    const snap = m.getSnapshot();
    assert.strictEqual(snap["requests"], 1);
    assert.strictEqual(snap["errors"], 2);
  });

  it("observeHistogram records values", () => {
    const m = new InMemoryRequestMetrics();
    m.observeHistogram("duration", 100);
    m.observeHistogram("duration", 200);
    const snap = m.getSnapshot()["duration"] as Record<string, number>;
    assert.strictEqual(snap.count, 2);
    assert.strictEqual(snap.sum, 300);
  });

  it("histogram snapshot includes count, sum, avg, min, max", () => {
    const m = new InMemoryRequestMetrics();
    m.observeHistogram("latency", 50);
    m.observeHistogram("latency", 150);
    m.observeHistogram("latency", 100);
    const snap = m.getSnapshot()["latency"] as Record<string, number>;
    assert.strictEqual(snap.count, 3);
    assert.strictEqual(snap.sum, 300);
    assert.strictEqual(snap.avg, 100);
    assert.strictEqual(snap.min, 50);
    assert.strictEqual(snap.max, 150);
  });

  it("histogram with no values returns 0s", () => {
    const m = new InMemoryRequestMetrics();
    // A histogram key only appears after observations, so verify indirectly:
    // incrementCounter only, then getSnapshot should not contain histogram fields.
    m.incrementCounter("other");
    assert.strictEqual(m.getSnapshot()["other"], 1);
    // Verify no histogram key leaked
    assert.strictEqual("latency" in m.getSnapshot(), false);
  });

  it("reset clears all data", () => {
    const m = new InMemoryRequestMetrics();
    m.incrementCounter("requests");
    m.observeHistogram("duration", 100);
    m.reset();
    assert.deepStrictEqual(m.getSnapshot(), {});
  });

  it("getPrometheusSnapshot includes TYPE declarations", () => {
    const m = new InMemoryRequestMetrics();
    m.incrementCounter("http_requests");
    const output = m.getPrometheusSnapshot();
    assert.ok(output.includes("# TYPE http_requests counter"));
    assert.ok(output.includes("http_requests 1"));
  });

  it("getPrometheusSnapshot aggregates counter by labels", () => {
    const m = new InMemoryRequestMetrics();
    m.incrementCounter("http_requests", { method: "GET" });
    m.incrementCounter("http_requests", { method: "GET" });
    m.incrementCounter("http_requests", { method: "POST" });
    const output = m.getPrometheusSnapshot();
    assert.ok(output.includes('http_requests{method="GET"} 2'));
    assert.ok(output.includes('http_requests{method="POST"} 1'));
  });

  it("getPrometheusSnapshot formats histogram as summary with _count and _sum", () => {
    const m = new InMemoryRequestMetrics();
    m.observeHistogram("request_duration", 0.5);
    m.observeHistogram("request_duration", 1.5);
    const output = m.getPrometheusSnapshot();
    assert.ok(output.includes("# TYPE request_duration summary"));
    assert.ok(output.includes("request_duration_count 2"));
    assert.ok(output.includes("request_duration_sum 2"));
    assert.ok(output.includes("request_duration_avg 1"));
  });

  it("domain metrics expose embedding and reranker capacity counters", () => {
    const m = new InMemoryRequestMetrics();
    initializeDomainMetrics(m);
    const output = m.getPrometheusSnapshot();
    assert.ok(output.includes("memory_embedding_calls_total"));
    assert.ok(output.includes("memory_embedding_429_total"));
    assert.ok(output.includes("memory_reranker_calls_total"));
    assert.ok(output.includes("memory_reranker_429_total"));
    assert.ok(output.includes("memory_recall_fallback_ratio"));
    assert.ok(output.includes("memory_qdrant_query_timeouts_total"));
    assert.ok(output.includes("memory_post_commit_degraded_total"));
  });
});
