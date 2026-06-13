import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface McpToolInvocationInput {
  readonly toolName: string;
  readonly agentId?: string | null;
  readonly success: boolean;
  readonly latencyMs: number;
  readonly error?: string | null;
}

export interface McpToolInvocationMetric {
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
}

export interface McpToolInvocationStore {
  readonly updated_at: string;
  readonly tools: readonly McpToolInvocationMetric[];
}

function runtimeDir(): string {
  return process.env.MEMORY_XX_RUNTIME_DIR?.trim() || join(process.cwd(), ".runtime");
}

export function mcpToolInvocationsPath(): string {
  return join(runtimeDir(), "memory-xx-mcp-tool-invocations.json");
}

function readStore(): McpToolInvocationStore {
  const path = mcpToolInvocationsPath();
  if (!existsSync(path)) return { updated_at: new Date(0).toISOString(), tools: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<McpToolInvocationStore>;
    return {
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date(0).toISOString(),
      tools: Array.isArray(parsed.tools) ? parsed.tools as McpToolInvocationMetric[] : [],
    };
  } catch {
    return { updated_at: new Date(0).toISOString(), tools: [] };
  }
}

function writeStore(store: McpToolInvocationStore): void {
  const path = mcpToolInvocationsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, path);
}

function cleanText(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 240) : fallback;
}

export function recordMcpToolInvocation(input: McpToolInvocationInput): void {
  const now = new Date().toISOString();
  const toolName = cleanText(input.toolName, "unknown_tool");
  const agentId = cleanText(input.agentId, "unknown-agent");
  const latencyMs = Math.max(0, Math.round(input.latencyMs));
  const store = readStore();
  const byName = new Map(store.tools.map((tool) => [tool.tool_name, tool]));
  const previous = byName.get(toolName);
  const agents = new Set(previous?.agents ?? []);
  agents.add(agentId);
  byName.set(toolName, {
    tool_name: toolName,
    call_count: (previous?.call_count ?? 0) + 1,
    success_count: (previous?.success_count ?? 0) + (input.success ? 1 : 0),
    failure_count: (previous?.failure_count ?? 0) + (input.success ? 0 : 1),
    latency_total_ms: (previous?.latency_total_ms ?? 0) + latencyMs,
    latency_max_ms: Math.max(previous?.latency_max_ms ?? 0, latencyMs),
    last_latency_ms: latencyMs,
    last_seen_at: now,
    last_error: input.success ? previous?.last_error : cleanText(input.error, "unknown_error"),
    agents: [...agents].sort().slice(0, 40),
  });
  writeStore({
    updated_at: now,
    tools: [...byName.values()]
      .sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at))
      .slice(0, 200),
  });
}

export function readMcpToolInvocationMetrics(): McpToolInvocationStore {
  return readStore();
}
