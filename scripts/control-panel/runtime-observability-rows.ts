import { createHash } from "node:crypto";

import { objectValue, stringValue } from "./utils.js";

export interface RuntimeObservabilitySnapshotInput {
  readonly snapshot_id: string;
  readonly collected_at: string;
  readonly status: string;
  readonly summary: Record<string, unknown>;
  readonly metrics: Record<string, unknown>;
  readonly registry: readonly unknown[];
}

export interface RuntimeAgentConnectionRow {
  readonly connection_id: string;
  readonly agent_id: string;
  readonly identity_source: string;
  readonly transport: string;
  readonly endpoint: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly request_count: number;
  readonly methods: readonly string[];
  readonly permissions: readonly string[];
  readonly remote_address?: string;
  readonly user_agent?: string;
  readonly client_name?: string;
  readonly last_status?: number;
  readonly last_error?: string;
  readonly metadata: Record<string, unknown>;
}

export interface RuntimeToolInvocationRow {
  readonly tool_name: string;
  readonly call_count: number;
  readonly success_count: number;
  readonly failure_count: number;
  readonly latency_total_ms: number;
  readonly latency_max_ms: number;
  readonly last_latency_ms: number;
  readonly last_seen_at: string;
  readonly last_error?: string;
  readonly agents: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface RuntimeComponentSnapshotRow {
  readonly component_snapshot_id: string;
  readonly snapshot_id: string;
  readonly collected_at: string;
  readonly component_name: string;
  readonly label: string;
  readonly status: string;
  readonly detail: string;
  readonly source: string;
  readonly remediation?: string;
  readonly metadata: Record<string, unknown>;
}

export interface RuntimeSettingEffectiveValueRow {
  readonly setting_key: string;
  readonly category: string;
  readonly label: string;
  readonly effective_value: unknown;
  readonly default_value: unknown;
  readonly source: string;
  readonly effect_status: string;
  readonly safety: string;
  readonly service?: string;
  readonly unit?: string;
  readonly writable: boolean;
  readonly last_observed_at: string;
  readonly metadata: Record<string, unknown>;
}

export interface RuntimeObservabilityRows {
  readonly agents: readonly RuntimeAgentConnectionRow[];
  readonly tools: readonly RuntimeToolInvocationRow[];
  readonly components: readonly RuntimeComponentSnapshotRow[];
  readonly settings: readonly RuntimeSettingEffectiveValueRow[];
}

export function runtimeObsText(value: unknown, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.slice(0, 500) : fallback;
}

export function runtimeObsNumberValue(value: unknown, fallback = 0): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 240))
    : [];
}

export function runtimeObsStableId(...parts: readonly unknown[]): string {
  return createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\n")).digest("hex").slice(0, 24);
}

export function buildRuntimeObservabilityRows(snapshot: RuntimeObservabilitySnapshotInput): RuntimeObservabilityRows {
  const metrics = objectValue(snapshot.metrics);
  const connections = Array.isArray(objectValue(metrics.client_connections).connections)
    ? objectValue(metrics.client_connections).connections as readonly Record<string, unknown>[]
    : [];
  const tools = Array.isArray(objectValue(metrics.mcp_tool_invocations).tools)
    ? objectValue(metrics.mcp_tool_invocations).tools as readonly Record<string, unknown>[]
    : [];
  const components = Array.isArray(metrics.component_statuses)
    ? metrics.component_statuses as readonly Record<string, unknown>[]
    : [];
  const registry = Array.isArray(snapshot.registry) ? snapshot.registry as readonly Record<string, unknown>[] : [];

  return {
    agents: connections.map((item) => ({
      connection_id: runtimeObsText(item.connection_id, `client_connection_${runtimeObsStableId(item.agent_id, item.transport, item.endpoint)}`),
      agent_id: runtimeObsText(item.agent_id, "unknown-agent"),
      identity_source: runtimeObsText(item.identity_source, "unknown-source"),
      transport: runtimeObsText(item.transport, "unknown"),
      endpoint: runtimeObsText(item.endpoint, "unknown-endpoint"),
      first_seen_at: runtimeObsText(item.first_seen_at, snapshot.collected_at),
      last_seen_at: runtimeObsText(item.last_seen_at, snapshot.collected_at),
      request_count: runtimeObsNumberValue(item.request_count),
      methods: stringArray(item.methods),
      permissions: stringArray(item.permissions),
      remote_address: stringValue(item.remote_address) || undefined,
      user_agent: stringValue(item.user_agent) || undefined,
      client_name: stringValue(item.client_name) || undefined,
      last_status: Number.isFinite(Number(item.last_status)) ? Number(item.last_status) : undefined,
      last_error: stringValue(item.last_error) || undefined,
      metadata: { snapshot_id: snapshot.snapshot_id },
    })),
    tools: tools.map((item) => ({
      tool_name: runtimeObsText(item.tool_name, "unknown_tool"),
      call_count: runtimeObsNumberValue(item.call_count),
      success_count: runtimeObsNumberValue(item.success_count),
      failure_count: runtimeObsNumberValue(item.failure_count),
      latency_total_ms: runtimeObsNumberValue(item.latency_total_ms),
      latency_max_ms: runtimeObsNumberValue(item.latency_max_ms),
      last_latency_ms: runtimeObsNumberValue(item.last_latency_ms),
      last_seen_at: runtimeObsText(item.last_seen_at, snapshot.collected_at),
      last_error: stringValue(item.last_error) || undefined,
      agents: stringArray(item.agents),
      metadata: { snapshot_id: snapshot.snapshot_id },
    })),
    components: components.map((item) => {
      const componentName = runtimeObsText(item.name, "unknown_component");
      return {
        component_snapshot_id: `component_snapshot_${runtimeObsStableId(snapshot.snapshot_id, componentName)}`,
        snapshot_id: snapshot.snapshot_id,
        collected_at: snapshot.collected_at,
        component_name: componentName,
        label: runtimeObsText(item.label, componentName),
        status: runtimeObsText(item.status, "unknown"),
        detail: runtimeObsText(item.detail, ""),
        source: runtimeObsText(item.source, "runtime_snapshot"),
        remediation: stringValue(item.remediation) || undefined,
        metadata: {},
      };
    }),
    settings: registry.map((item) => ({
      setting_key: runtimeObsText(item.key, "unknown_setting"),
      category: runtimeObsText(item.category, "config"),
      label: runtimeObsText(item.label, ""),
      effective_value: item.effective_value ?? item.value ?? null,
      default_value: item.default_value ?? null,
      source: runtimeObsText(item.source, "default"),
      effect_status: runtimeObsText(item.effect_status, "read_only_env"),
      safety: runtimeObsText(item.safety, "safe"),
      service: stringValue(item.service) || undefined,
      unit: stringValue(item.unit) || undefined,
      writable: item.writable === true,
      last_observed_at: snapshot.collected_at,
      metadata: {
        snapshot_id: snapshot.snapshot_id,
        type: item.type ?? null,
        min: item.min ?? null,
        max: item.max ?? null,
      },
    })),
  };
}
