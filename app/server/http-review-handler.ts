import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { MemoryCacheInvalidator } from "../cache";
import { RecallRuntimeCacheInvalidator } from "../cache";
import type { WriteTransactionRunner } from "../db/tx/write-transaction";
import { ArchiveMemoryService } from "../review/services/archive-memory-service";
import { ReviewDecisionService } from "../review/services/review-decision-service";
import { SupersedeMemoryService } from "../review/services/supersede-memory-service";
import { TombstoneMemoryService } from "../review/services/tombstone-memory-service";
import { UpdateCandidateMemoryService } from "../review/services/update-candidate-memory-service";
import { ReviewState, ScopeType, type JsonObject } from "../shared";
import { parseJsonBody } from "./body";
import { getDeps, type HandlerDeps } from "./http-handler-deps";
import { validateReviewBody, validateWriteBody } from "./input-validation";
import type { MemoryPermission } from "./permissions";
import { enforceMemoryIdPermission } from "./scope-enforcement";
import { resolveWriteErrorStatus } from "./http-write-handler";

const REVIEW_ROUTE_RE = /^\/api\/memory\/xx\/review\/memories\/([^/]+)\/(approve|reject|archive|supersede|tombstone|update-candidate)$/;

function reviewPermissionForAction(action: string): MemoryPermission {
  return action === "archive" || action === "tombstone" ? "memory:governance_revert" : "memory:governance_apply";
}

async function invalidateMemoryScopeCache(memoryId: string, cacheInvalidator: MemoryCacheInvalidator, db: WriteTransactionRunner): Promise<void> {
  try {
    const snapshot = await db.snapshotForMemoryIds([memoryId]);
    const record = snapshot.memoryRecords.find((r) => r.id === memoryId);
    if (record) {
      await cacheInvalidator.invalidate([{ type: record.scopeType as ScopeType, id: record.scopeId }]);
    }
  } catch {
    // Cache invalidation failure must not break review operations.
  }
}

export async function handleReview(req: IncomingMessage, res: ServerResponse, handlerDeps?: Partial<HandlerDeps>): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "请求方法不允许" }));
    return;
  }
  const deps = getDeps(handlerDeps);
  if (!deps.writeDatabase) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "运行时尚未初始化" }));
    return;
  }

  const match = (req.url ?? "").match(REVIEW_ROUTE_RE);
  if (!match) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "审批路由不存在" }));
    return;
  }
  const memoryId = match[1];
  const action = match[2];

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "body_read_timeout" || message === "body_too_large" || message === "invalid_json_body") {
      res.writeHead(message === "body_read_timeout" ? 408 : message === "body_too_large" ? 413 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message === "invalid_json_body" ? "JSON 请求体无效" : message }));
      return;
    }
    body = {};
  }
  const payload = (body ?? {}) as Record<string, unknown>;
  try {
    if (!(await enforceMemoryIdPermission(req, res, {
      permissions: deps.permissions,
      env: deps.env,
      writeDatabase: deps.writeDatabase
    }, reviewPermissionForAction(action), [memoryId]))) {
      return;
    }
    const requestId = String(payload.requestId ?? randomUUID());
    const actorId = String(payload.actorId ?? "klee");
    const serviceDeps = {
      database: deps.writeDatabase,
      cacheInvalidator: new RecallRuntimeCacheInvalidator(deps.recallCache, { database: deps.writeDatabase }),
      projectionSyncService: deps.projectionSyncService ?? undefined,
    };

    switch (action) {
      case "approve": {
        const service = new ReviewDecisionService(serviceDeps);
        const result = await service.approve({ requestId, actorId, memoryId });
        await invalidateMemoryScopeCache(memoryId, serviceDeps.cacheInvalidator, deps.writeDatabase);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        break;
      }
      case "reject": {
        const service = new ReviewDecisionService(serviceDeps);
        const result = await service.reject({ requestId, actorId, memoryId });
        await invalidateMemoryScopeCache(memoryId, serviceDeps.cacheInvalidator, deps.writeDatabase);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        break;
      }
      case "archive": {
        const service = new ArchiveMemoryService(serviceDeps);
        const result = await service.execute({ requestId, actorId, memoryId });
        await invalidateMemoryScopeCache(memoryId, serviceDeps.cacheInvalidator, deps.writeDatabase);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        break;
      }
      case "supersede": {
        const reviewVal = validateReviewBody(payload, action);
        if (!reviewVal.valid) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: reviewVal.error }));
          return;
        }
        if (!payload.content) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "执行 supersede（替换旧记忆）时必须提供 content（新内容）" }));
          return;
        }
        const service = new SupersedeMemoryService(serviceDeps);
        const result = await service.execute({
          requestId,
          actorId,
          memoryId,
          content: String(payload.content),
          title: payload.title != null ? String(payload.title) : null,
          summary: payload.summary != null ? String(payload.summary) : null,
          metadata: (payload.metadata as JsonObject) ?? {},
          dedupeKey: payload.dedupeKey != null ? String(payload.dedupeKey) : null,
          reviewState: ReviewState.NotRequired,
          sources: [],
          relations: [],
        });
        await invalidateMemoryScopeCache(memoryId, serviceDeps.cacheInvalidator, deps.writeDatabase);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        break;
      }
      case "update-candidate": {
        const validation = validateWriteBody({
          scopeType: "project",
          scopeId: "validation-placeholder",
          content: payload.content,
          title: payload.title,
          dedupeKey: payload.dedupeKey,
          metadata: payload.metadata
        });
        if (!validation.valid) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: validation.error }));
          return;
        }
        const service = new UpdateCandidateMemoryService(serviceDeps);
        const result = await service.execute({
          requestId,
          actorId,
          memoryId,
          content: String(payload.content),
          title: payload.title != null ? String(payload.title) : null,
          summary: payload.summary != null ? String(payload.summary) : null,
          metadata: (payload.metadata as JsonObject) ?? {},
          dedupeKey: payload.dedupeKey != null ? String(payload.dedupeKey) : null,
          memoryType: payload.memoryType != null ? String(payload.memoryType) : payload.memory_type != null ? String(payload.memory_type) : null,
        });
        await invalidateMemoryScopeCache(memoryId, serviceDeps.cacheInvalidator, deps.writeDatabase);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        break;
      }
      case "tombstone": {
        const service = new TombstoneMemoryService(serviceDeps);
        const result = await service.execute({ requestId, actorId, memoryId });
        await invalidateMemoryScopeCache(memoryId, serviceDeps.cacheInvalidator, deps.writeDatabase);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        break;
      }
    }
  } catch (err) {
    const status = resolveWriteErrorStatus(err);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status >= 500 ? { error: "内部服务错误" } : { error: (err as Error).message }));
  }
}
