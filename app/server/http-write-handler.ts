import type { IncomingMessage, ServerResponse } from "node:http";

import { RecallRuntimeCacheInvalidator } from "../cache";
import { WriteCommandType, type CreateMemoryCommand } from "../shared/contracts/write";
import { CreateMemoryService } from "../write/services/create-memory-service";
import { parseJsonBody } from "./body";
import { getDeps, type HandlerDeps } from "./http-handler-deps";
import { buildCreateCommandFromBody } from "./http-request-builders";
import { validateWriteBody } from "./input-validation";
import { enforceScopePermission } from "./scope-enforcement";
import type { HttpWriteBody } from "./types";

export async function executeWriteCommand(command: CreateMemoryCommand, handlerDeps?: Partial<HandlerDeps>) {
  const deps = getDeps(handlerDeps);
  const db = deps.writeDatabase;
  if (!db) {
    throw new Error("运行时尚未初始化");
  }
  const service = new CreateMemoryService({
    database: db,
    cacheInvalidator: new RecallRuntimeCacheInvalidator(deps.recallCache, { database: db }),
    projectionSyncService: deps.projectionSyncService ?? undefined,
  });
  return await service.execute(command);
}

export function resolveWriteErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message === "body_too_large") return 413;
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  switch (code) {
    case "invalid_scope_type":
    case "invalid_create_state":
    case "invalid_input":
      return 400;
    case "request_payload_conflict":
    case "request_already_in_flight":
    case "request_already_failed":
    case "invalid_lifecycle_transition":
    case "transaction_constraint_violation":
      return 409;
    case "record_not_found":
    case "relation_target_not_found":
      return 404;
    default:
      return 500;
  }
}

export async function handleWrite(req: IncomingMessage, res: ServerResponse, handlerDeps?: Partial<HandlerDeps>): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "请求方法不允许" }));
    return;
  }
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === "body_read_timeout" ? 408 : message === "body_too_large" ? 413 : 400;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message === "body_read_timeout" ? "body_read_timeout" : "JSON 请求体无效" }));
    return;
  }
  const payload = (body ?? {}) as HttpWriteBody;
  const validation = validateWriteBody(payload);
  if (!validation.valid) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: validation.error }));
    return;
  }
  try {
    const command = buildCreateCommandFromBody(payload as Record<string, unknown>);
    const deps = getDeps(handlerDeps);
    if (!(await enforceScopePermission(req, res, {
      permissions: deps.permissions,
      env: deps.env,
      writeDatabase: deps.writeDatabase
    }, "memory:write", [{
      scopeType: command.scopeType,
      scopeId: command.scopeId
    }]))) {
      return;
    }
    const result = await executeWriteCommand(command, handlerDeps);
    const status = result.replayed || result.commandType === WriteCommandType.UpdateCandidateMemory ? 200 : 201;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const status = resolveWriteErrorStatus(err);
    res.writeHead(status, { "Content-Type": "application/json" });
    const publicMessage = err && typeof err === "object" && "publicMessage" in err
      ? String((err as { publicMessage?: unknown }).publicMessage ?? "")
      : "";
    res.end(JSON.stringify(status >= 500
      ? { error: "内部服务错误" }
      : { error: (err as Error).message, ...(publicMessage ? { message: publicMessage } : {}) }
    ));
  }
}
