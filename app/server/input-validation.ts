/**
 * Input Validation Module for Memory XX
 *
 * All validators return a discriminated union:
 *   { valid: true, value: T }   — input passed validation
 *   { valid: false, error: string } — input rejected with a human-readable message
 *
 * No exceptions are thrown.
 */

import { LifecycleStatus, ReviewState, type JsonObject } from "../shared";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; error: string };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

// ---------------------------------------------------------------------------
// Write body
// ---------------------------------------------------------------------------

const VALID_SCOPE_TYPES = new Set([
  "personal",
  "shared",
  "execution",
  "user",
  "workspace",
  "run",
  "project",
  "global",
  "task",
]);

export interface WriteBody {
  scopeType: string;
  scopeId: string;
  content: string;
  title?: string;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
  lifecycleStatus?: LifecycleStatus.Candidate | LifecycleStatus.Approved;
  reviewState?: ReviewState.Pending | ReviewState.Approved | ReviewState.SilentApproved | ReviewState.NotRequired;
  relations?: Array<{
    relatedMemoryId: string;
    relationType: string;
    direction?: "outbound" | "bidirectional";
    weight?: number | null;
    metadata?: JsonObject | null;
  }>;
}

export function validateWriteBody(body: unknown): ValidationResult<WriteBody> {
  if (!isObject(body)) {
    return { valid: false, error: "请求体必须是 JSON 对象。" };
  }

  // --- scopeType ---
  if (!isString(body.scopeType)) {
    return { valid: false, error: "scopeType（作用域类型）必须是字符串。" };
  }
  if (!VALID_SCOPE_TYPES.has(body.scopeType)) {
    return {
      valid: false,
      error: `scopeType（作用域类型）必须是以下值之一：${[...VALID_SCOPE_TYPES].join(", ")}。`,
    };
  }

  // --- scopeId ---
  if (!isString(body.scopeId)) {
    return { valid: false, error: "scopeId（作用域 ID）必须是字符串。" };
  }
  if (isBlank(body.scopeId)) {
    return { valid: false, error: "scopeId（作用域 ID）不能为空。" };
  }
  if (body.scopeId.length > 256) {
    return { valid: false, error: "scopeId（作用域 ID）不能超过 256 个字符。" };
  }

  // --- content ---
  if (!isString(body.content)) {
    return { valid: false, error: "content（内容）必须是字符串。" };
  }
  if (isBlank(body.content)) {
    return { valid: false, error: "content（内容）不能为空。" };
  }
  if (body.content.length > 100_000) {
    return { valid: false, error: "content（内容）不能超过 100,000 个字符。" };
  }

  // --- title (optional) ---
  if (body.title !== undefined && body.title !== null) {
    if (!isString(body.title)) {
      return { valid: false, error: "title（标题）如果提供，必须是字符串。" };
    }
    if (body.title.length > 512) {
      return { valid: false, error: "title（标题）不能超过 512 个字符。" };
    }
    if (isBlank(body.title)) {
      return { valid: false, error: "title（标题）如果提供，不能为空白字符串。" };
    }
  }

  // --- dedupeKey (optional) ---
  if (body.dedupeKey !== undefined && body.dedupeKey !== null) {
    if (!isString(body.dedupeKey)) {
      return { valid: false, error: "dedupeKey（去重键）如果提供，必须是字符串。" };
    }
    if (isBlank(body.dedupeKey)) {
      return { valid: false, error: "dedupeKey（去重键）如果提供，不能为空白字符串。" };
    }
    if (body.dedupeKey.trim().length > 256) {
      return { valid: false, error: "dedupeKey（去重键）不能超过 256 个字符。" };
    }
  }

  // --- metadata (optional) ---
  if (body.metadata !== undefined) {
    if (
      typeof body.metadata !== "object" ||
      body.metadata === null ||
      Array.isArray(body.metadata)
    ) {
      return {
        valid: false,
        error: "metadata（元数据）如果提供，必须是普通对象，不能是数组或 null。",
      };
    }
  }

  let lifecycleStatus: WriteBody["lifecycleStatus"] = LifecycleStatus.Candidate;
  if (body.lifecycleStatus !== undefined && body.lifecycleStatus !== null) {
    if (body.lifecycleStatus !== LifecycleStatus.Candidate && body.lifecycleStatus !== LifecycleStatus.Approved) {
      return { valid: false, error: "invalid_create_state" };
    }
    lifecycleStatus = body.lifecycleStatus;
  }

  let reviewState: WriteBody["reviewState"] = ReviewState.Pending;
  if (body.reviewState !== undefined && body.reviewState !== null) {
    if (
      body.reviewState !== ReviewState.Pending &&
      body.reviewState !== ReviewState.Approved &&
      body.reviewState !== ReviewState.SilentApproved &&
      body.reviewState !== ReviewState.NotRequired
    ) {
      return { valid: false, error: "invalid_create_state" };
    }
    reviewState = body.reviewState;
  }

  if (!lifecycleStatus || !reviewState) {
    return { valid: false, error: "invalid_create_state" };
  }
  if (
    !(
      (lifecycleStatus === LifecycleStatus.Candidate && reviewState === ReviewState.Pending) ||
      (lifecycleStatus === LifecycleStatus.Approved && [ReviewState.Approved, ReviewState.SilentApproved, ReviewState.NotRequired].includes(reviewState))
    )
  ) {
    return { valid: false, error: "invalid_create_state" };
  }

  let relations: WriteBody["relations"] | undefined;
  if (body.relations !== undefined) {
    if (!Array.isArray(body.relations)) {
      return { valid: false, error: "relations_must_be_array" };
    }
    relations = [];
    for (let index = 0; index < body.relations.length; index += 1) {
      const relation = body.relations[index];
      if (!isObject(relation)) {
        return { valid: false, error: `relations[${index}]_must_be_object` };
      }
      if (!isString(relation.relatedMemoryId) || isBlank(relation.relatedMemoryId)) {
        return { valid: false, error: `relations[${index}].relatedMemoryId_required` };
      }
      if (!isString(relation.relationType) || isBlank(relation.relationType)) {
        return { valid: false, error: `relations[${index}].relationType_required` };
      }
      if (
        relation.direction !== undefined &&
        relation.direction !== null &&
        relation.direction !== "outbound" &&
        relation.direction !== "bidirectional"
      ) {
        return { valid: false, error: `relations[${index}].direction_invalid` };
      }
      if (relation.weight !== undefined && relation.weight !== null && !isNumber(relation.weight)) {
        return { valid: false, error: `relations[${index}].weight_must_be_number` };
      }
      if (
        relation.metadata !== undefined &&
        relation.metadata !== null &&
        !isObject(relation.metadata)
      ) {
        return { valid: false, error: `relations[${index}].metadata_must_be_object` };
      }
      relations.push({
        relatedMemoryId: relation.relatedMemoryId.trim(),
        relationType: relation.relationType.trim(),
        ...(relation.direction ? { direction: relation.direction } : {}),
        ...(relation.weight !== undefined ? { weight: relation.weight as number | null } : {}),
        ...(relation.metadata !== undefined ? { metadata: relation.metadata as JsonObject | null } : {}),
      });
    }
  }

  const value: WriteBody = {
    scopeType: body.scopeType,
    scopeId: body.scopeId,
    content: body.content,
    lifecycleStatus,
    reviewState,
  };

  if (body.title !== undefined && body.title !== null) {
    value.title = body.title as string;
  }

  if (body.dedupeKey !== undefined && body.dedupeKey !== null) {
    value.dedupeKey = body.dedupeKey as string;
  }

  if (body.metadata !== undefined) {
    value.metadata = body.metadata as Record<string, unknown>;
  }

  if (relations !== undefined) {
    value.relations = relations;
  }

  return { valid: true, value };
}

// ---------------------------------------------------------------------------
// Recall body
// ---------------------------------------------------------------------------

export interface RecallBody {
  query: string;
  limit?: number;
  offset?: number;
}

export function validateRecallBody(body: unknown): ValidationResult<RecallBody> {
  if (!isObject(body)) {
    return { valid: false, error: "请求体必须是 JSON 对象。" };
  }

  // --- query ---
  if (!isString(body.query)) {
    return { valid: false, error: "query（查询内容）必须是字符串。" };
  }
  if (isBlank(body.query)) {
    return { valid: false, error: "query（查询内容）不能为空。" };
  }
  if (body.query.length > 10_000) {
    return { valid: false, error: "query（查询内容）不能超过 10,000 个字符。" };
  }

  if (body.scope_conflict_policy !== undefined) {
    const policy = body.scope_conflict_policy;
    if (
      !isString(policy) ||
      !["more_specific_wins", "higher_scope_wins", "latest_wins"].includes(policy)
    ) {
      return { valid: false, error: "unsupported_scope_conflict_policy" };
    }
  }

  if (body.scope_context !== undefined && !isObject(body.scope_context)) {
    return { valid: false, error: "scope_context（作用域上下文）如果提供，必须是 JSON 对象。" };
  }

  // --- limit (optional) ---
  if (body.limit !== undefined) {
    if (!isNumber(body.limit)) {
      return { valid: false, error: "limit（数量限制）如果提供，必须是数字。" };
    }
    if (body.limit < 1 || body.limit > 100) {
      return { valid: false, error: "limit（数量限制）必须在 1 到 100 之间。" };
    }
  }

  // --- offset (optional) ---
  if (body.offset !== undefined) {
    if (!isNumber(body.offset)) {
      return { valid: false, error: "offset（偏移量）如果提供，必须是数字。" };
    }
    if (body.offset < 0) {
      return { valid: false, error: "offset（偏移量）不能是负数。" };
    }
  }

  const value: RecallBody = {
    query: body.query.trim(),
  };

  if (body.limit !== undefined) {
    value.limit = body.limit;
  }

  if (body.offset !== undefined) {
    value.offset = body.offset;
  }

  return { valid: true, value };
}

// ---------------------------------------------------------------------------
// Review body
// ---------------------------------------------------------------------------

export interface ReviewBody {
  content?: string;
}

export function validateReviewBody(
  body: unknown,
  action: string,
): ValidationResult<ReviewBody> {
  // supersede（替换旧记忆）动作必须提供 content。
  if (action === "supersede") {
    if (!isObject(body)) {
      return {
        valid: false,
        error: "supersede（替换旧记忆）动作的请求体必须是 JSON 对象。",
      };
    }

    if (!isString(body.content)) {
      return {
        valid: false,
        error: "supersede（替换旧记忆）动作的 content（内容）必须是非空字符串。",
      };
    }

    if (isBlank(body.content)) {
      return {
        valid: false,
        error: "supersede（替换旧记忆）动作的 content（内容）不能为空。",
      };
    }

    return { valid: true, value: { content: body.content } };
  }

  // 其他动作允许请求体为空。
  return { valid: true, value: {} };
}
