import type { MemoryPermission } from "./permissions";

export interface RouteRegistryEntry {
  readonly label: string;
  readonly permission: MemoryPermission | null;
  readonly pattern: RegExp;
}

const ROUTES: readonly RouteRegistryEntry[] = [
  route("/live", null),
  route("/health", "memory:read"),
  route("/metrics", "memory:read"),
  route("/metrics/prometheus", "memory:read"),
  route("/mcp", "memory:write"),
  route("/recall", "memory:read"),
  route("/write", "memory:write"),
  route("/api/memory/v2/recall/query", "memory:read"),
  route("/api/memory/v2/recall", "memory:read"),
  route("/api/memory/v2/write", "memory:write", /^\/api\/memory\/v2\/write(?:\/.*)?$/),
  route("/api/memory/v2/review/memories/:memory_id/:action", "memory:governance_apply", /^\/api\/memory\/v2\/review\/memories\/[^/]+(?:\/[^/]+)?$/),
  route("/api/memory/v2/orchestrator/resolve-scope-plan", "memory:read"),
  route("/api/memory/v2/orchestrator/write-memory", "memory:write"),
  route("/api/memory/v2/orchestrator/recall-memory", "memory:read"),
  route("/api/memory/v2/orchestrator/recall-memory-legacy", "memory:read"),
  route("/api/memory/v2/orchestrator/summarize-memory", "memory:read"),
  route("/api/memory/v2/orchestrator/memory-counts", "memory:read"),
  route("/api/memory/v2/orchestrator/forget-memory", "memory:governance_revert"),
  route("/api/memory/v2/orchestrator/read-memory", "memory:read"),
  route("/api/memory/v2/orchestrator/audit-memory-consistency", "memory:read"),
  route("/api/memory/v2/orchestrator/repair-memory-consistency", "memory:governance_apply"),
  route("/api/memory/v2/intelligence/extract", "memory:write"),
  route("/api/memory/v2/intelligence/smart-write", "memory:write"),
  route("/api/memory/v2/intelligence/write-tickets/:ticket_id", "memory:read", /^\/api\/memory\/v2\/intelligence\/write-tickets\/[^/]+$/),
  route("/api/memory/v2/mcp/list-pending", "memory:read"),
  route("/api/memory/v2/mcp/approve", "memory:governance_apply"),
  route("/api/memory/v2/mcp/reject", "memory:governance_apply"),
  route("/api/memory/v2/mcp/smart-write", "memory:write"),
  route("/api/memory/v2/conversation/events", "memory:write"),
  route("/api/memory/v2/conversation/ingest", "memory:write"),
  route("/api/memory/v2/conversation/flush", "memory:write"),
  route("/api/memory/v2/unified/remember", "memory:write"),
  route("/api/memory/v2/unified/recall", "memory:read"),
  route("/api/memory/v2/unified/reflect", "memory:write"),
  route("/api/memory/v2/unified/forget", "memory:governance_revert"),
  route("/api/memory/v2/unified/audit", "memory:read"),
  route("/api/memory/v2/unified/feedback", "memory:feedback"),
  route("/api/memory/v2/feedback/memories/:memory_id/:action", "memory:feedback", /^\/api\/memory\/v2\/feedback\/memories\/[^/]+\/[^/]+$/),
  route("/api/memory/v2/unified/recall-feedback", "memory:feedback"),
  route("/api/memory/v2/knowledge/ingest", "memory:write"),
  route("/api/memory/v2/knowledge/search", "memory:read"),
  route("/api/memory/v2/skills", "memory:read"),
  route("/api/memory/v2/skills/execute", "memory:write"),
];

export function normalizeHttpPath(input: string): string {
  try {
    return new URL(input || "/", "http://memory-xx.local").pathname;
  } catch {
    return (input.split("?")[0] || "/").trim() || "/";
  }
}

export function routeLabelForPath(input: string): string {
  const pathname = normalizeHttpPath(input);
  const entry = findRoute(pathname);
  return entry?.label ?? scrubUnknownPath(pathname);
}

export function requiredPermissionForPath(input: string): MemoryPermission | null {
  return findRoute(normalizeHttpPath(input))?.permission ?? null;
}

export function listRouteRegistry(): readonly RouteRegistryEntry[] {
  return ROUTES;
}

function findRoute(pathname: string): RouteRegistryEntry | null {
  return ROUTES.find((entry) => entry.pattern.test(pathname)) ?? null;
}

function route(
  label: string,
  permission: MemoryPermission | null,
  pattern: RegExp = exactPattern(label)
): RouteRegistryEntry {
  return { label, permission, pattern };
}

function exactPattern(pathname: string): RegExp {
  return new RegExp(`^${escapeRegExp(pathname)}$`);
}

function scrubUnknownPath(pathname: string): string {
  const safe = pathname
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (/^[0-9a-f]{12,}$/i.test(segment)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f-]{13,}$/i.test(segment)) return ":id";
      if (segment.length > 48) return ":id";
      return segment;
    })
    .join("/");
  return safe || "/";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
