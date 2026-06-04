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
  route("/api/memory/xx/recall/query", "memory:read"),
  route("/api/memory/xx/recall", "memory:read"),
  route("/api/memory/xx/write", "memory:write", /^\/api\/memory\/xx\/write(?:\/.*)?$/),
  route("/api/memory/xx/review/memories/:memory_id/:action", "memory:governance_apply", /^\/api\/memory\/xx\/review\/memories\/[^/]+(?:\/[^/]+)?$/),
  route("/api/memory/xx/orchestrator/resolve-scope-plan", "memory:read"),
  route("/api/memory/xx/orchestrator/write-memory", "memory:write"),
  route("/api/memory/xx/orchestrator/recall-memory", "memory:read"),
  route("/api/memory/xx/orchestrator/recall-memory-legacy", "memory:read"),
  route("/api/memory/xx/orchestrator/summarize-memory", "memory:read"),
  route("/api/memory/xx/orchestrator/memory-counts", "memory:read"),
  route("/api/memory/xx/orchestrator/forget-memory", "memory:governance_revert"),
  route("/api/memory/xx/orchestrator/read-memory", "memory:read"),
  route("/api/memory/xx/orchestrator/audit-memory-consistency", "memory:read"),
  route("/api/memory/xx/orchestrator/repair-memory-consistency", "memory:governance_apply"),
  route("/api/memory/xx/intelligence/extract", "memory:write"),
  route("/api/memory/xx/intelligence/smart-write", "memory:write"),
  route("/api/memory/xx/intelligence/write-tickets/:ticket_id", "memory:read", /^\/api\/memory\/xx\/intelligence\/write-tickets\/[^/]+$/),
  route("/api/memory/xx/mcp/list-pending", "memory:read"),
  route("/api/memory/xx/mcp/approve", "memory:governance_apply"),
  route("/api/memory/xx/mcp/reject", "memory:governance_apply"),
  route("/api/memory/xx/mcp/smart-write", "memory:write"),
  route("/api/memory/xx/conversation/events", "memory:write"),
  route("/api/memory/xx/conversation/ingest", "memory:write"),
  route("/api/memory/xx/conversation/flush", "memory:write"),
  route("/api/memory/xx/unified/remember", "memory:write"),
  route("/api/memory/xx/unified/recall", "memory:read"),
  route("/api/memory/xx/unified/reflect", "memory:write"),
  route("/api/memory/xx/unified/forget", "memory:governance_revert"),
  route("/api/memory/xx/unified/audit", "memory:read"),
  route("/api/memory/xx/unified/feedback", "memory:feedback"),
  route("/api/memory/xx/feedback/memories/:memory_id/:action", "memory:feedback", /^\/api\/memory\/xx\/feedback\/memories\/[^/]+\/[^/]+$/),
  route("/api/memory/xx/unified/recall-feedback", "memory:feedback"),
  route("/api/memory/xx/knowledge/ingest", "memory:write"),
  route("/api/memory/xx/knowledge/search", "memory:read"),
  route("/api/memory/xx/skills", "memory:read"),
  route("/api/memory/xx/skills/execute", "memory:write"),
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
