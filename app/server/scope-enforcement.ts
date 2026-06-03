import type { IncomingMessage, ServerResponse } from "node:http";

import type { WriteTransactionRunner } from "../db/tx/write-transaction";
import { ScopeType } from "../shared";
import {
  createPermissionChecker,
  extractAuthToken,
  loadScopePolicyMode,
  type MemoryPermission,
  type PermissionChecker,
} from "./permissions";

export interface ScopeRef {
  readonly scopeType: string;
  readonly scopeId: string;
}

export interface ScopeEnforcementContext {
  readonly permissions?: PermissionChecker;
  readonly env?: NodeJS.ProcessEnv;
  readonly writeDatabase?: WriteTransactionRunner | null;
}

export interface MemoryScopeLookup {
  readonly ok: boolean;
  readonly status?: number;
  readonly error?: string;
  readonly scopes: readonly ScopeRef[];
}

export function strictScopeEnabled(context?: ScopeEnforcementContext): boolean {
  return loadScopePolicyMode(context?.env ?? process.env) === "strict";
}

export function normalizeScopeTypeForGrant(scopeType: string): string {
  const normalized = scopeType.trim().toLowerCase();
  switch (normalized) {
    case "personal":
      return ScopeType.User;
    case "shared":
      return ScopeType.Workspace;
    case "execution":
      return ScopeType.Run;
    default:
      return normalized;
  }
}

export function scopeRefsFromScopeContext(scopeContext: {
  readonly user_id?: string;
  readonly workspace_id?: string;
  readonly project_ids?: readonly string[];
  readonly include_global?: boolean;
}): ScopeRef[] {
  const scopes: ScopeRef[] = [];
  if (scopeContext.user_id) scopes.push({ scopeType: ScopeType.User, scopeId: scopeContext.user_id });
  for (const projectId of scopeContext.project_ids ?? []) {
    scopes.push({ scopeType: ScopeType.Project, scopeId: projectId });
  }
  if (scopeContext.workspace_id) scopes.push({ scopeType: ScopeType.Workspace, scopeId: scopeContext.workspace_id });
  if (scopeContext.include_global) scopes.push({ scopeType: ScopeType.Global, scopeId: "global" });
  return scopes;
}

export async function lookupMemoryScopes(
  memoryIds: readonly string[],
  writeDatabase?: WriteTransactionRunner | null
): Promise<MemoryScopeLookup> {
  const uniqueIds = [...new Set(memoryIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) {
    return { ok: true, scopes: [] };
  }
  if (!writeDatabase) {
    return { ok: false, status: 503, error: "运行时尚未初始化", scopes: [] };
  }
  const snapshot = await writeDatabase.snapshotForMemoryIds(uniqueIds);
  const scopes: ScopeRef[] = [];
  const found = new Set<string>();
  for (const record of snapshot.memoryRecords) {
    if (!uniqueIds.includes(record.id)) continue;
    found.add(record.id);
    scopes.push({ scopeType: record.scopeType, scopeId: record.scopeId });
  }
  const missing = uniqueIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return { ok: false, status: 404, error: "memory_not_found", scopes };
  }
  return { ok: true, scopes };
}

export async function enforceScopePermission(
  req: IncomingMessage,
  res: ServerResponse,
  context: ScopeEnforcementContext | undefined,
  permission: MemoryPermission,
  scopes: readonly ScopeRef[]
): Promise<boolean> {
  if (!strictScopeEnabled(context)) return true;
  if (scopes.length === 0) return true;

  const checker = context?.permissions ?? createPermissionChecker(context?.env ?? process.env);
  const shouldClose = !context?.permissions;
  try {
    const token = extractAuthToken(req);
    for (const scope of scopes) {
      const decision = await checker.authorizeScope({
        token,
        permission,
        scopeType: normalizeScopeTypeForGrant(scope.scopeType),
        scopeId: scope.scopeId,
      });
      if (!decision.allowed || !decision.scopeAllowed) {
        res.writeHead(decision.authenticated ? 403 : 401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: decision.authenticated ? "forbidden" : "unauthorized",
          required: permission,
          scope: decision.scope ?? scope,
          reason: decision.reason ?? "scope_denied",
        }));
        return false;
      }
    }
    return true;
  } finally {
    if (shouldClose) await checker.close();
  }
}

export async function enforceMemoryIdPermission(
  req: IncomingMessage,
  res: ServerResponse,
  context: ScopeEnforcementContext | undefined,
  permission: MemoryPermission,
  memoryIds: readonly string[]
): Promise<boolean> {
  if (!strictScopeEnabled(context)) return true;
  const lookup = await lookupMemoryScopes(memoryIds, context?.writeDatabase);
  if (!lookup.ok) {
    res.writeHead(lookup.status ?? 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: lookup.error ?? "memory_scope_lookup_failed" }));
    return false;
  }
  return enforceScopePermission(req, res, context, permission, lookup.scopes);
}

export function globalScope(): readonly ScopeRef[] {
  return [{ scopeType: ScopeType.Global, scopeId: "global" }];
}
