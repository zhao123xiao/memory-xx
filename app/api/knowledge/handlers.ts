import type { IncomingMessage, ServerResponse } from "node:http";
import { getKnowledgeStatus, searchKnowledge } from "../../knowledge/service";
import {
  enforceScopePermission,
  globalScope,
  strictScopeEnabled,
  type ScopeEnforcementContext,
} from "../../server/scope-enforcement";
import {
  createPermissionChecker,
  extractAuthToken,
  type PermissionChecker
} from "../../server/permissions";
import { KnowledgeScopeGrantRepository } from "../../db/repositories/knowledge-scope-grant-repository";
import { withWriteTransaction } from "../../db/tx/write-transaction";
import { parseJsonBody } from "../../server/body";

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function jsonBodyErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "body_read_timeout") return 408;
  if (message === "body_too_large") return 413;
  if (message === "invalid_json_body") return 400;
  return 500;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : undefined;
}

async function enforceKnowledgeRead(
  req: IncomingMessage,
  res: ServerResponse,
  authContext: ScopeEnforcementContext | undefined,
  input: { readonly collections: readonly string[]; readonly repos: readonly string[] }
): Promise<boolean> {
  if (!strictScopeEnabled(authContext)) return true;
  const checker: PermissionChecker = authContext?.permissions ?? createPermissionChecker(authContext?.env ?? process.env);
  const shouldClose = !authContext?.permissions;
  try {
    const token = extractAuthToken(req);
    const global = await checker.authorizeScope({
      token,
      permission: "memory:read",
      scopeType: "global",
      scopeId: "global"
    });
    if (global.allowed && global.scopeAllowed) return true;

    const resources = [
      ...input.collections.map((resourceId) => ({ resourceType: "collection" as const, resourceId })),
      ...input.repos.map((resourceId) => ({ resourceType: "repo" as const, resourceId }))
    ];
    if (resources.length === 0) {
      sendJson(res, global.authenticated ? 403 : 401, {
        error: global.authenticated ? "forbidden" : "unauthorized",
        required: "memory:read",
        reason: "knowledge_scope_required"
      });
      return false;
    }
    const base = await checker.authorizeToken(token, "memory:read");
    if (!base.authenticated || !base.allowed || !base.identity) {
      sendJson(res, base.authenticated ? 403 : 401, {
        error: base.authenticated ? "forbidden" : "unauthorized",
        required: "memory:read",
        reason: base.authenticated ? "permission_denied" : "unauthenticated"
      });
      return false;
    }
    if (!authContext?.writeDatabase) {
      sendJson(res, 503, { error: "knowledge_grant_store_unavailable" });
      return false;
    }
    const grantRepository = new KnowledgeScopeGrantRepository();
    for (const resource of resources) {
      const allowed = await withWriteTransaction(authContext.writeDatabase, (tx) =>
        grantRepository.hasReadGrant(tx, {
          agentId: base.identity!.agentId,
          resourceType: resource.resourceType,
          resourceId: resource.resourceId
        })
      );
      if (!allowed) {
        sendJson(res, 403, {
          error: "forbidden",
          required: "memory:read",
          resource,
          reason: "knowledge_scope_grant_missing"
        });
        return false;
      }
    }
    return true;
  } finally {
    if (shouldClose) await checker.close();
  }
}

export async function handleKnowledgeSearch(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "请求方法不允许" });
    return;
  }
  try {
    const body = await parseJsonBody(req);
    const payload = isObject(body) ? body : {};
    const collections = readStringArray(payload.knowledge_collections) ?? [];
    const repos = readStringArray(payload.repos) ?? [];
    if (!(await enforceKnowledgeRead(req, res, authContext, { collections, repos }))) {
      return;
    }
    const query = typeof payload.query === "string" ? payload.query : "";
    const result = await searchKnowledge({
      query,
      limit: typeof payload.limit === "number" ? payload.limit : undefined,
      knowledge_collections: collections,
      repos
    });
    sendJson(res, result.ok ? 200 : 503, result);
  } catch (error) {
    sendJson(res, jsonBodyErrorStatus(error), { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleKnowledgeIngest(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "请求方法不允许" });
    return;
  }
  try {
    if (!(await enforceScopePermission(req, res, authContext, "memory:write", globalScope()))) {
      return;
    }
    const status = await getKnowledgeStatus();
    sendJson(res, 200, {
      ...status,
      ingest_mode: "offline_script",
      message: "批量导入请使用 scripts/import-knowledge-chroma-export.ts；HTTP ingest 不是长时间运行的导入 worker。"
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
