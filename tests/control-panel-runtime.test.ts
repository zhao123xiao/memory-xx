import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadMemoryRedisConfig } from "../app/cache/config";
import {
  readMcpToolInvocationMetrics,
  recordMcpToolInvocation,
} from "../app/observability/mcp-tool-invocations";
import {
  activatePendingRuntimeControlsSync,
  readRuntimeControlNumberSync,
} from "../app/runtime-control-settings";
import { loadQdrantProjectorWorkerRuntimeConfig } from "../app/qdrant-sync/daemon";
import { loadRateLimiterConfig, RateLimiter } from "../app/server/rate-limiter";
import {
  buildRuntimeRegistry,
  previewRuntimeSettings,
  resetRuntimeSettings,
  updateRuntimeSettingsBatch,
} from "../scripts/control-panel/settings";
import { buildRuntimeObservabilityRows } from "../scripts/control-panel/runtime-observability-rows";
import { buildRuntimeObservabilityRetentionPlan } from "../scripts/control-panel/runtime-observability-retention";
import { buildComponentStatusesFromRuntimeModules } from "../app/runtime-module-components";

function withRuntimeDir<T>(fn: () => T): T {
  const previous = process.env.MEMORY_XX_RUNTIME_DIR;
  const dir = mkdtempSync(join(tmpdir(), "memory-xx-runtime-control-"));
  process.env.MEMORY_XX_RUNTIME_DIR = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.MEMORY_XX_RUNTIME_DIR;
    else process.env.MEMORY_XX_RUNTIME_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runtime registry exposes typed, sourced, safety-labeled settings", () => withRuntimeDir(() => {
  const registry = buildRuntimeRegistry({});
  assert.ok(registry.length >= 30);
  for (const item of registry) {
    assert.ok(item.key);
    assert.ok(item.label);
    assert.ok(item.description);
    assert.ok(item.category);
    assert.ok(["boolean", "number", "string"].includes(item.type));
    assert.ok(["safe", "guarded", "high-risk"].includes(item.safety));
    assert.ok(["runtime_json", "restart_pending", "env", "default"].includes(item.source));
    assert.ok(["hot_reload", "pending_restart", "read_only_env", "external_service_owned"].includes(item.effect_status));
    if (item.service) {
      assert.doesNotMatch(item.service, /^openclaw-.*\.service$/u);
    }
    if (item.type === "number") {
      assert.equal(typeof item.default_value, "number");
      assert.ok(item.unit, `${item.key} should expose a display unit`);
      assert.ok(item.min === undefined || item.max === undefined || item.min <= item.max);
    }
  }
}));

test("batch update rejects readonly env settings and previews restart requirements", () => withRuntimeDir(() => {
  assert.throws(
    () => updateRuntimeSettingsBatch({ MEMORY_XX_DATABASE_URL: "postgres://example" }, {}),
    /setting_not_writable/
  );

  const preview = previewRuntimeSettings({
    "worker.qdrant_projector.interval_ms": 9000,
    "cache.redis.ttl.search_seconds": 60,
  }, {});
  assert.equal(preview.changes.length, 2);
  assert.equal(preview.restart_required_count, 1);
  assert.ok(preview.services_to_restart.includes("memory-xx-qdrant-projector-worker.service"));
}));

test("runtime cache and rate limit values hot override env/default values", () => withRuntimeDir(() => {
  updateRuntimeSettingsBatch({
    "cache.redis.ttl.search_seconds": 42,
    "write.rate_limit.max_requests": 7,
    "write.rate_limit.window_ms": 12_000,
  }, {});

  const redisConfig = loadMemoryRedisConfig({});
  assert.equal(redisConfig.ttl_seconds.search, 42);

  const rateLimit = loadRateLimiterConfig({});
  assert.equal(rateLimit.maxRequests, 7);
  assert.equal(rateLimit.windowMs, 12_000);

  resetRuntimeSettings(["cache.redis.ttl.search_seconds", "write.rate_limit.max_requests", "write.rate_limit.window_ms"], {});
  assert.equal(loadMemoryRedisConfig({}).ttl_seconds.search, 300);
  assert.equal(loadRateLimiterConfig({}).maxRequests, undefined);
}));

test("rate limiter reads runtime controls without process restart", () => withRuntimeDir(() => {
  const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });
  assert.equal(limiter.isAllowed("client-a"), true);

  updateRuntimeSettingsBatch({
    "write.rate_limit.max_requests": 1,
    "write.rate_limit.window_ms": 60_000,
  }, {});

  assert.equal(limiter.isAllowed("client-a"), false);
}));

test("restart-required worker settings become real after pending activation", () => withRuntimeDir(() => {
  updateRuntimeSettingsBatch({
    "worker.qdrant_projector.interval_ms": 12_345,
    "worker.qdrant_projector.batch_size": 17,
  }, {});

  assert.equal(readRuntimeControlNumberSync("worker.qdrant_projector.interval_ms", 5000), 5000);

  activatePendingRuntimeControlsSync([
    "worker.qdrant_projector.interval_ms",
    "worker.qdrant_projector.batch_size",
  ]);

  assert.equal(readRuntimeControlNumberSync("worker.qdrant_projector.interval_ms", 5000), 12_345);
  assert.equal(loadQdrantProjectorWorkerRuntimeConfig(process.env).intervalMs, 12_345);
  assert.equal(loadQdrantProjectorWorkerRuntimeConfig(process.env).batchSize, 17);
}));

test("MCP tool invocation metrics aggregate calls, failures, latency, and agents", () => withRuntimeDir(() => {
  recordMcpToolInvocation({
    toolName: "recall_memory",
    agentId: "codex",
    success: true,
    latencyMs: 12,
  });
  recordMcpToolInvocation({
    toolName: "recall_memory",
    agentId: "codex",
    success: false,
    latencyMs: 21,
    error: "upstream unavailable",
  });

  const metrics = readMcpToolInvocationMetrics();
  const recall = metrics.tools.find((tool) => tool.tool_name === "recall_memory");
  assert.ok(recall);
  assert.equal(recall.call_count, 2);
  assert.equal(recall.success_count, 1);
  assert.equal(recall.failure_count, 1);
  assert.equal(recall.latency_total_ms, 33);
  assert.equal(recall.latency_max_ms, 21);
  assert.deepEqual(recall.agents, ["codex"]);
  assert.equal(recall.last_error, "upstream unavailable");
}));

test("runtime observability rows flatten agents, MCP tools, components, and effective settings", () => {
  const rows = buildRuntimeObservabilityRows({
    snapshot_id: "runtime_snapshot_test",
    collected_at: "2026-05-30T00:00:00.000Z",
    status: "ok",
    summary: {},
    metrics: {
      client_connections: {
        connections: [{
          connection_id: "client_connection_test",
          agent_id: "codex",
          identity_source: "mcp",
          transport: "mcp",
          endpoint: "tools/call",
          first_seen_at: "2026-05-30T00:00:00.000Z",
          last_seen_at: "2026-05-30T00:01:00.000Z",
          request_count: 2,
          methods: ["recall_memory"],
          permissions: ["memory:read"],
        }],
      },
      mcp_tool_invocations: {
        tools: [{
          tool_name: "recall_memory",
          call_count: 2,
          success_count: 1,
          failure_count: 1,
          latency_total_ms: 33,
          latency_max_ms: 21,
          last_latency_ms: 21,
          last_seen_at: "2026-05-30T00:01:00.000Z",
          last_error: "upstream unavailable",
          agents: ["codex"],
        }],
      },
      component_statuses: [{
        name: "qdrant",
        label: "Qdrant（向量库）",
        status: "ok",
        detail: "green",
        source: "wrapper /health",
      }],
    },
    registry: [{
      key: "cache.redis.ttl.search_seconds",
      category: "cache",
      label: "搜索缓存 TTL",
      effective_value: 60,
      default_value: 300,
      source: "runtime_json",
      effect_status: "hot_reload",
      safety: "safe",
      service: "wrapper",
      unit: "秒",
      writable: true,
    }],
  });

  assert.equal(rows.agents.length, 1);
  assert.equal(rows.agents[0].agent_id, "codex");
  assert.equal(rows.tools.length, 1);
  assert.equal(rows.tools[0].tool_name, "recall_memory");
  assert.equal(rows.components.length, 1);
  assert.equal(rows.components[0].component_name, "qdrant");
  assert.equal(rows.settings.length, 1);
  assert.equal(rows.settings[0].setting_key, "cache.redis.ttl.search_seconds");
});

test("runtime observability retention plan keeps current state and prunes historical rows", () => {
  const plan = buildRuntimeObservabilityRetentionPlan();
  const policiesByTable = new Map(plan.policies.map((policy) => [policy.table, policy]));

  assert.equal(policiesByTable.get("runtime_component_snapshots")?.retention_days, 7);
  assert.equal(policiesByTable.get("ops_advisor_reports")?.retention_days, 90);
  assert.equal(policiesByTable.get("runtime_agent_connections")?.retention_days, 90);
  assert.equal(policiesByTable.get("code_graph_project_snapshots")?.keep_latest_per_project, 20);

  assert.ok(plan.current_state_tables.includes("runtime_setting_effective_values"));
  assert.ok(plan.current_state_tables.includes("runtime_tool_invocations"));
  assert.equal(plan.policies.some((policy) => policy.table === "runtime_setting_effective_values"), false);
});

test("control panel component statuses use runtime module snapshot states", () => {
  const components = buildComponentStatusesFromRuntimeModules({
    states: {
      wrapper: {
        state: "enabled",
        role: "required",
        label: "memory-xx wrapper HTTP API",
        kind: "core",
        service: "memory-xx-wrapper.service",
        degraded_behavior: "HTTP API unavailable",
      },
      fastpath: {
        state: "disabled",
        role: "expected",
        label: "Fastpath recall sidecar",
        kind: "sidecar",
        service: "memory-xx-fastpath.service",
        source_path: "sidecars/fastpath/fastpath.mjs",
        degraded_behavior: "Recall falls back to Node.",
      },
      mem0_extractor: {
        state: "missing_dependency",
        role: "expected",
        label: "Mem0-style extraction sidecar",
        kind: "sidecar",
        service: "memory-xx-mem0-extractor.service",
        source_path: "sidecars/mem0-extractor/extractor.py",
        degraded_behavior: "Smart extraction falls back.",
        reason: "MEMORY_XX_MEM0_EXTRACTOR_SOURCE_AVAILABLE=disabled",
      },
    },
  });

  const byName = new Map(components.map((component) => [component.name, component]));
  assert.equal(byName.get("wrapper")?.status, "ok");
  assert.equal(byName.get("fastpath")?.status, "degraded");
  assert.equal(byName.get("fastpath")?.detail.includes("disabled"), true);
  assert.equal(byName.get("mem0_extractor")?.status, "blocked");
  assert.equal(byName.get("mem0_extractor")?.source, "sidecars/mem0-extractor/extractor.py");
});
