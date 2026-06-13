import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";

import { processSmartWrite } from "../intelligence/handlers";
import { parseJsonBody } from "../../server/body";
import {
  enforceScopePermission,
  normalizeScopeTypeForGrant,
  strictScopeEnabled,
  type ScopeEnforcementContext,
} from "../../server/scope-enforcement";
import { ScopeType, type JsonObject } from "../../shared";
import { stableStringify } from "../../shared/command-serialization";
import { isPostgresTransactionContext, withWriteTransaction } from "../../db/tx/write-transaction";
import * as runtime from "../../server/runtime";
import type { ConversationMessageInput } from "../../intelligence/types";
import { graphHintsMetadata } from "../../intelligence/graph-extraction";
import {
  planConversationMemoryRoute,
  shouldSkipLongTermExtractionForObservation,
} from "../../governance/observer-reflector-governor";

type ConversationRole = ConversationMessageInput["role"];

interface NormalizedScope {
  readonly scopeContext: JsonObject;
  readonly source: "caller_explicit" | "defaulted";
  readonly scopeHint: { readonly scope_type: string; readonly scope_id: string };
  readonly userId?: string;
  readonly workspaceId?: string;
}

interface ConversationEvent {
  readonly id: string;
  readonly conversationId: string;
  readonly sessionId: string | null;
  readonly turnId: string;
  readonly role: ConversationRole;
  readonly content: string;
  readonly agentId: string;
  readonly source: string;
  readonly scope: NormalizedScope;
  readonly contentHash: string;
  readonly metadata: JsonObject;
  readonly observedAt: string;
}

interface BatchProcessInput {
  readonly conversationId: string;
  readonly sessionId: string | null;
  readonly agentId: string;
  readonly source: string;
  readonly scope: NormalizedScope;
  readonly messages: readonly ConversationMessageInput[];
  readonly turnIds: readonly string[];
  readonly eventIds: readonly string[];
  readonly metadata?: JsonObject;
}

export interface ConversationObservationSkipMetadataInput {
  readonly source: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly messages: readonly ConversationMessageInput[];
  readonly noOpReasons: readonly string[];
}

export interface ConversationObservationSkipMetadata {
  readonly noOpReasons: readonly string[];
  readonly metadata: JsonObject;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function jsonBodyErrorStatus(message: string): number {
  if (message === "body_read_timeout") return 408;
  if (message === "body_too_large") return 413;
  if (message === "invalid_json_body") return 400;
  return 500;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envEnabled(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRole(value: unknown): ConversationRole {
  const role = readString(value).toLowerCase();
  if (role === "system" || role === "user" || role === "assistant" || role === "tool") return role;
  throw Object.assign(new Error("invalid_role"), { status: 400 });
}

function normalizeScopeContext(raw: unknown): NormalizedScope {
  const input = objectValue(raw);
  const projectIds = readStringArray(input.project_ids ?? input.projectIds);
  const userId = readString(input.user_id ?? input.userId);
  const workspaceId = readString(input.workspace_id ?? input.workspaceId);
  const memoryIds = readStringArray(input.memory_ids ?? input.memoryIds);
  const hasLongTermScope = projectIds.length > 0 || Boolean(userId) || Boolean(workspaceId) || memoryIds.length > 0;
  if (!hasLongTermScope && process.env.MEMORY_XX_CONVERSATION_STRICT_SCOPE === "1") {
    throw Object.assign(new Error("scope_context_required"), { status: 400 });
  }
  const defaultProjectId = process.env.MEMORY_XX_CONVERSATION_DEFAULT_PROJECT_ID?.trim() || "memory-xx";
  const effectiveProjectIds = projectIds.length > 0 ? projectIds : hasLongTermScope ? [] : [defaultProjectId];
  const effectiveUserId = userId || (!hasLongTermScope ? "current-instance-owner" : "");
  const effectiveWorkspaceId = workspaceId || (!hasLongTermScope ? "current-instance" : "");
  const scopeContext: JsonObject = {
    ...input as JsonObject,
    ...(effectiveProjectIds.length > 0 ? { project_ids: effectiveProjectIds } : {}),
    ...(effectiveUserId ? { user_id: effectiveUserId } : {}),
    ...(effectiveWorkspaceId ? { workspace_id: effectiveWorkspaceId } : {}),
    ...(typeof input.include_global === "boolean" ? { include_global: input.include_global } : {}),
  };

  if (effectiveProjectIds[0]) {
    return {
      scopeContext,
      source: hasLongTermScope ? "caller_explicit" : "defaulted",
      scopeHint: { scope_type: "project", scope_id: effectiveProjectIds[0] },
      userId: effectiveUserId || undefined,
      workspaceId: effectiveWorkspaceId || undefined,
    };
  }
  if (effectiveWorkspaceId) {
    return {
      scopeContext,
      source: "caller_explicit",
      scopeHint: { scope_type: "workspace", scope_id: effectiveWorkspaceId },
      userId: effectiveUserId || undefined,
      workspaceId: effectiveWorkspaceId,
    };
  }
  if (effectiveUserId) {
    return {
      scopeContext,
      source: "caller_explicit",
      scopeHint: { scope_type: "user", scope_id: effectiveUserId },
      userId: effectiveUserId,
      workspaceId: undefined,
    };
  }
  throw Object.assign(new Error("scope_context_required"), { status: 400 });
}

function scopeTypeForPermission(scopeType: string): ScopeType {
  switch (scopeType) {
    case "project": return ScopeType.Project;
    case "workspace": return ScopeType.Workspace;
    case "user": return ScopeType.User;
    case "global": return ScopeType.Global;
    default: throw Object.assign(new Error("invalid_scope_type"), { status: 400 });
  }
}

async function authorizeScope(
  req: IncomingMessage,
  res: ServerResponse,
  authContext: ScopeEnforcementContext | undefined,
  scope: NormalizedScope,
): Promise<boolean> {
  if (!strictScopeEnabled(authContext)) return true;
  return enforceScopePermission(req, res, authContext, "memory:write", [{
    scopeType: scopeTypeForPermission(scope.scopeHint.scope_type),
    scopeId: scope.scopeHint.scope_id,
  }]);
}

function normalizeEvent(input: unknown, defaults: Record<string, unknown> = {}): ConversationEvent {
  const raw = { ...defaults, ...objectValue(input) };
  const role = normalizeRole(raw.role);
  const content = readString(raw.content);
  if (!content) throw Object.assign(new Error("content_required"), { status: 400 });
  const conversationId = readString(raw.conversation_id ?? raw.conversationId, "codex-local");
  const sessionId = readString(raw.session_id ?? raw.sessionId) || null;
  const contentHash = sha256(content);
  const turnId = readString(raw.turn_id ?? raw.turnId, `turn_${contentHash.slice(0, 16)}`);
  const agentId = readString(raw.agent_id ?? raw.agentId, "codex");
  const source = readString(raw.source, "codex-jsonl-spool");
  const scope = normalizeScopeContext(raw.scope_context ?? raw.scopeContext ?? defaults.scope_context ?? defaults.scopeContext);
  const metadata = objectValue(raw.metadata) as JsonObject;
  const observedAt = readString(raw.observed_at ?? raw.observedAt, new Date().toISOString());
  const id = readString(raw.id, `ce_${sha256(`${conversationId}:${sessionId ?? ""}:${turnId}:${contentHash}`).slice(0, 32)}`);
  return { id, conversationId, sessionId, turnId, role, content, agentId, source, scope, contentHash, metadata, observedAt };
}

function normalizeMessages(value: unknown): ConversationMessageInput[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const raw = objectValue(item);
    return {
      role: normalizeRole(raw.role),
      content: readString(raw.content),
      ...(readString(raw.created_at ?? raw.createdAt) ? { created_at: readString(raw.created_at ?? raw.createdAt) } : {}),
      ...(readString(raw.name) ? { name: readString(raw.name) } : {}),
    };
  }).filter((message) => message.content.length > 0);
}

function messagesText(messages: readonly ConversationMessageInput[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}

export function buildConversationObservationSkipMetadata(
  input: ConversationObservationSkipMetadataInput,
): ConversationObservationSkipMetadata {
  const conversationMemoryRoute = planConversationMemoryRoute({
    source: input.source,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    messages: input.messages,
  });
  return {
    noOpReasons: input.noOpReasons,
    metadata: {
      conversation_memory_route: conversationMemoryRoute as unknown as JsonObject,
    },
  };
}

function hasExplicitMemoryIntent(events: readonly { content: string; metadata?: JsonObject }[]): boolean {
  return events.some((event) =>
    event.metadata?.memory_intent === true ||
    /请记住|帮我记住|记住|记一下|记下来|remember this|please remember|我的偏好|以后|后续|必须|不能|prefer|preference/i.test(event.content)
  );
}

function hasSessionEnd(events: readonly { metadata?: JsonObject }[]): boolean {
  return events.some((event) => event.metadata?.event_type === "session_end" || event.metadata?.session_ended === true);
}

function batchHashOf(input: BatchProcessInput): string {
  return sha256(stableStringify({
    conversation_id: input.conversationId,
    session_id: input.sessionId,
    scope_context: input.scope.scopeContext,
    messages: input.messages,
  }));
}

function sourceRoles(messages: readonly ConversationMessageInput[]): string[] {
  return [...new Set(messages.map((message) => message.role))];
}

function eventSourceAdapters(events: readonly { metadata: JsonObject }[]): string[] {
  return [...new Set(events
    .map((event) => readString(event.metadata.source_adapter))
    .filter(Boolean))];
}

function noOpReasons(result: Record<string, unknown>, created: readonly Record<string, unknown>[]): string[] {
  const reasons = new Set<string>();
  if (result.should_write === false) reasons.add(readString(result.operation, "no_change"));
  if (readString(result.failure_reason)) reasons.add(readString(result.failure_reason));
  for (const item of created) {
    if (item.action === "skip") reasons.add(readString(item.reason, "skip_guard"));
    if (item.action === "buffer") reasons.add(readString(item.reason, "low_confidence"));
  }
  if (created.length === 0) reasons.add("no_candidates");
  return [...reasons];
}

async function insertEvents(events: readonly ConversationEvent[]): Promise<{ inserted: number; skipped: number }> {
  const db = runtime.writeDatabase;
  if (!db) throw Object.assign(new Error("运行时尚未初始化"), { status: 503 });
  let inserted = 0;
  await withWriteTransaction(db, async (tx) => {
    if (!isPostgresTransactionContext(tx)) throw Object.assign(new Error("postgres_required"), { status: 503 });
    for (const event of events) {
      const rows = await tx.query<{ id: string }>(`
        INSERT INTO conversation_events (
          id, conversation_id, session_id, turn_id, role, content, agent_id, source,
          scope_context, content_hash, metadata, observed_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::timestamptz)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [
        event.id,
        event.conversationId,
        event.sessionId,
        event.turnId,
        event.role,
        event.content,
        event.agentId,
        event.source,
        JSON.stringify(event.scope.scopeContext),
        event.contentHash,
        JSON.stringify({ ...event.metadata, scope_context_source: event.scope.source }),
        event.observedAt,
      ]);
      inserted += rows.length;
    }
  });
  return { inserted, skipped: events.length - inserted };
}

async function countRecentCandidates(sessionId: string | null): Promise<number> {
  if (!sessionId || !runtime.writeDatabase) return 0;
  return withWriteTransaction(runtime.writeDatabase, async (tx) => {
    if (!isPostgresTransactionContext(tx)) return 0;
    const rows = await tx.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM memory_records
      WHERE metadata ->> 'source' = 'conversation_ingest'
        AND metadata ->> 'session_id' = $1
        AND created_at >= now() - interval '1 hour'
    `, [sessionId]);
    return Number.parseInt(rows[0]?.count ?? "0", 10) || 0;
  });
}

async function upsertBatchStart(input: BatchProcessInput, batchId: string, batchHash: string): Promise<{ reused: boolean; row?: Record<string, unknown> }> {
  const db = runtime.writeDatabase;
  if (!db) throw Object.assign(new Error("运行时尚未初始化"), { status: 503 });
  return withWriteTransaction(db, async (tx) => {
    if (!isPostgresTransactionContext(tx)) throw Object.assign(new Error("postgres_required"), { status: 503 });
    const inserted = await tx.query(`
      INSERT INTO conversation_batches (
        id, conversation_id, session_id, batch_hash, status, agent_id, source,
        scope_context, messages_json, metadata, started_at
      )
      VALUES ($1,$2,$3,$4,'processing',$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,now())
      ON CONFLICT (batch_hash) DO NOTHING
      RETURNING *
    `, [
      batchId,
      input.conversationId,
      input.sessionId,
      batchHash,
      input.agentId,
      input.source,
      JSON.stringify(input.scope.scopeContext),
      JSON.stringify(input.messages),
      JSON.stringify(input.metadata ?? {}),
    ]);
    if (inserted[0]) return { reused: false, row: inserted[0] as Record<string, unknown> };
    const existing = await tx.query(`SELECT * FROM conversation_batches WHERE batch_hash = $1 LIMIT 1`, [batchHash]);
    return { reused: true, row: existing[0] as Record<string, unknown> | undefined };
  });
}

async function completeBatch(
  batchId: string,
  status: "completed" | "failed" | "skipped",
  patch: {
    readonly extractionBackend?: string | null;
    readonly mem0Mode?: string | null;
    readonly candidateMemoryIds?: readonly string[];
    readonly noOpReasons?: readonly string[];
    readonly error?: string | null;
    readonly metadata?: JsonObject;
  },
  eventIds: readonly string[],
): Promise<void> {
  const db = runtime.writeDatabase;
  if (!db) return;
  await withWriteTransaction(db, async (tx) => {
    if (!isPostgresTransactionContext(tx)) return;
    await tx.query(`
      UPDATE conversation_batches
      SET status = $2,
          extraction_backend = $3,
          mem0_mode = $4,
          candidate_memory_ids = $5::jsonb,
          no_op_reasons = $6::jsonb,
          error = $7,
          metadata = metadata || $8::jsonb,
          completed_at = now(),
          updated_at = now()
      WHERE id = $1
    `, [
      batchId,
      status,
      patch.extractionBackend ?? null,
      patch.mem0Mode ?? null,
      JSON.stringify(patch.candidateMemoryIds ?? []),
      JSON.stringify(patch.noOpReasons ?? []),
      patch.error ?? null,
      JSON.stringify(patch.metadata ?? {}),
    ]);
    if (eventIds.length > 0) {
      await tx.query(`
        UPDATE conversation_events
        SET processed_at = now(), batch_id = $2, updated_at = now()
        WHERE id = ANY($1::text[])
      `, [eventIds, batchId]);
    }
  });
}

async function processConversationBatch(input: BatchProcessInput): Promise<Record<string, unknown>> {
  const batchHash = batchHashOf(input);
  const batchId = `cb_${batchHash.slice(0, 32)}`;
  const started = await upsertBatchStart(input, batchId, batchHash);
  if (started.reused) {
    return { ok: true, reused: true, batch: started.row };
  }

  const requireUser = process.env.MEMORY_XX_CONVERSATION_REQUIRE_USER_MESSAGE !== "0";
  if (requireUser && !input.messages.some((message) => message.role === "user")) {
    const observationSkip = buildConversationObservationSkipMetadata({
      source: "conversation_ingest",
      scopeType: input.scope.scopeHint.scope_type,
      scopeId: input.scope.scopeHint.scope_id,
      messages: input.messages,
      noOpReasons: ["assistant_only_ignored"],
    });
    await completeBatch(batchId, "skipped", observationSkip, input.eventIds);
    return {
      ok: true,
      batch_id: batchId,
      status: "skipped",
      no_op_reasons: observationSkip.noOpReasons,
      conversation_memory_route: observationSkip.metadata.conversation_memory_route,
    };
  }

  const maxCandidates = readPositiveInt("MEMORY_XX_CONVERSATION_MAX_CANDIDATES_PER_HOUR", 5);
  const recentCandidates = await countRecentCandidates(input.sessionId);
  if (recentCandidates >= maxCandidates) {
    await completeBatch(batchId, "skipped", {
      noOpReasons: ["rate_limited"],
      metadata: { recent_candidate_count: recentCandidates, max_candidates_per_hour: maxCandidates },
    }, input.eventIds);
    return { ok: true, batch_id: batchId, status: "skipped", no_op_reasons: ["rate_limited"] };
  }

  const graphHints = graphHintsMetadata(messagesText(input.messages));
  const conversationMemoryRoute = planConversationMemoryRoute({
    source: "conversation_ingest",
    scopeType: input.scope.scopeHint.scope_type,
    scopeId: input.scope.scopeHint.scope_id,
    messages: input.messages,
  });
  const metadata: JsonObject = {
    source: "conversation_ingest",
    conversation_id: input.conversationId,
    session_id: input.sessionId,
    turn_ids: [...input.turnIds],
    source_turn_ids: [...input.turnIds],
    batch_id: batchId,
    scope_context_source: input.scope.source,
    source_message_roles: sourceRoles(input.messages),
    temporal_hint: { observed_at: new Date().toISOString(), source: "conversation_ingest" },
    entity_hint: graphHints.entity_names ?? [],
    relation_hint: (graphHints.graph_extraction as JsonObject | undefined)?.relations ?? [],
    conversation_memory_route: conversationMemoryRoute as unknown as JsonObject,
    ...(input.metadata ?? {}),
  };
  if (shouldSkipLongTermExtractionForObservation(conversationMemoryRoute, {
    observerFirstEnabled: envEnabled("MEMORY_XX_CONVERSATION_OBSERVER_FIRST", false),
  })) {
    await completeBatch(batchId, "skipped", {
      noOpReasons: ["observation_only", "observer_first_long_term_extraction_skipped"],
      metadata: {
        conversation_memory_route: conversationMemoryRoute as unknown as JsonObject,
        observation_first_enabled: true,
      },
    }, input.eventIds);
    return {
      ok: true,
      batch_id: batchId,
      batch_hash: batchHash,
      status: "skipped",
      candidate_memory_ids: [],
      no_op_reasons: ["observation_only", "observer_first_long_term_extraction_skipped"],
      conversation_memory_route: conversationMemoryRoute,
    };
  }

  try {
    const result = await processSmartWrite({
      text: messagesText(input.messages),
      messages: input.messages,
      agent_id: input.agentId,
      user_id: input.scope.userId,
      workspace_id: input.scope.workspaceId,
      scope_type: input.scope.scopeHint.scope_type,
      scope_id: input.scope.scopeHint.scope_id,
      mode: "write",
      session_id: input.sessionId ?? undefined,
      metadata,
    }, false, undefined, "sync", undefined, runtime.writeDatabase);
    const body = objectValue(result.body);
    const created = Array.isArray(body.created) ? body.created.filter(isPlainObject) : [];
    const candidateMemoryIds = created
      .filter((item) => item.action !== "skip" && item.action !== "buffer" && item.replayed !== true)
      .map((item) => readString(item.memory_id))
      .filter(Boolean);
    const reasons = noOpReasons(body, created);
    const extractionBackend = readString(body.provider, "native");
    const model = objectValue(body.model);
    const modelFinal = readString(model.final);
    const mem0Mode = readString(body.mem0_mode) ||
      (modelFinal.includes(":official") ? "official" : modelFinal.includes(":legacy_extract") ? "legacy_extract" : null);
    const mem0Attempted = typeof body.mem0_attempted === "boolean" ? body.mem0_attempted : body.mem0_used === true;
    const mem0Success = typeof body.mem0_success === "boolean" ? body.mem0_success : body.mem0_used === true && body.fallback_used !== true;
    const mem0FallbackReason = readString(body.mem0_fallback_reason);
    const fallbackReason = readString(body.fallback_reason);
    await completeBatch(batchId, "completed", {
      extractionBackend,
      mem0Mode,
      candidateMemoryIds,
      noOpReasons: candidateMemoryIds.length > 0 ? reasons.filter((reason) => reason !== "no_candidates") : reasons,
      metadata: {
        mem0_mode: mem0Mode,
        extraction_backend: extractionBackend,
        mem0_attempted: mem0Attempted,
        mem0_success: mem0Success,
        mem0_attempted_mode: readString(body.mem0_attempted_mode) || mem0Mode,
        mem0_official_attempted: typeof body.mem0_official_attempted === "boolean" ? body.mem0_official_attempted : mem0Mode === "official",
        mem0_official_success: typeof body.mem0_official_success === "boolean" ? body.mem0_official_success : mem0Mode === "official" && mem0Success,
        ...(mem0FallbackReason ? { mem0_fallback_reason: mem0FallbackReason } : {}),
        fallback_used: body.fallback_used === true,
        ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
        candidate_count: candidateMemoryIds.length,
        smart_write_status: result.status,
        conversation_memory_route: conversationMemoryRoute as unknown as JsonObject,
      },
    }, input.eventIds);
    return {
      ok: result.status >= 200 && result.status < 300,
      batch_id: batchId,
      batch_hash: batchHash,
      status: "completed",
      candidate_memory_ids: candidateMemoryIds,
      no_op_reasons: candidateMemoryIds.length > 0 ? [] : reasons,
      extraction_backend: extractionBackend,
      mem0_mode: mem0Mode,
      mem0_attempted: mem0Attempted,
      mem0_success: mem0Success,
      mem0_fallback_reason: mem0FallbackReason || undefined,
      fallback_used: body.fallback_used === true,
      fallback_reason: fallbackReason || undefined,
      smart_write: body,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completeBatch(batchId, "failed", { error: message, noOpReasons: ["processing_error"] }, input.eventIds);
    throw error;
  }
}

async function selectFlushEvents(conversationId: string, sessionId: string | null, limit: number) {
  const db = runtime.writeDatabase;
  if (!db) throw Object.assign(new Error("运行时尚未初始化"), { status: 503 });
  return withWriteTransaction(db, async (tx) => {
    if (!isPostgresTransactionContext(tx)) throw Object.assign(new Error("postgres_required"), { status: 503 });
    return tx.query<{
      id: string;
      conversation_id: string;
      session_id: string | null;
      turn_id: string;
      role: ConversationRole;
      content: string;
      agent_id: string;
      source: string;
      scope_context: JsonObject;
      metadata: JsonObject;
      observed_at: string;
    }>(`
      SELECT id, conversation_id, session_id, turn_id, role, content, agent_id, source,
             scope_context, metadata, observed_at
      FROM conversation_events
      WHERE processed_at IS NULL
        AND conversation_id = $1
        AND COALESCE(session_id, '') = COALESCE($2, '')
      ORDER BY observed_at ASC, created_at ASC
      LIMIT $3
    `, [conversationId, sessionId, limit]);
  });
}

export async function handleConversationEvents(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const body = objectValue(await parseJsonBody(req));
    const defaults = {
      conversation_id: body.conversation_id ?? body.conversationId,
      session_id: body.session_id ?? body.sessionId,
      agent_id: body.agent_id ?? body.agentId,
      source: body.source,
      scope_context: body.scope_context ?? body.scopeContext,
    };
    const rawEvents = Array.isArray(body.events) ? body.events : Array.isArray(body.event) ? body.event : [body.event ?? body];
    const events = rawEvents.map((event) => normalizeEvent(event, defaults));
    for (const event of events) {
      if (!(await authorizeScope(req, res, authContext, event.scope))) return;
    }
    const result = await insertEvents(events);
    sendJson(res, 200, { ok: true, ...result, events: events.map((event) => ({ id: event.id, content_hash: event.contentHash })) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : jsonBodyErrorStatus(message);
    sendJson(res, status, { ok: false, error: message });
  }
}

export async function handleConversationIngest(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const body = objectValue(await parseJsonBody(req));
    const scope = normalizeScopeContext(body.scope_context ?? body.scopeContext);
    if (!(await authorizeScope(req, res, authContext, scope))) return;
    const messages = normalizeMessages(body.messages);
    if (messages.length === 0) {
      sendJson(res, 400, {
        ok: false,
        error: "messages_required",
        expected: { messages: [{ role: "user", content: "..." }] },
      });
      return;
    }
    const turnIds = readStringArray(body.turn_ids ?? body.turnIds);
    const result = await processConversationBatch({
      conversationId: readString(body.conversation_id ?? body.conversationId, "codex-local"),
      sessionId: readString(body.session_id ?? body.sessionId) || null,
      agentId: readString(body.agent_id ?? body.agentId, "codex"),
      source: readString(body.source, "conversation-ingest-api"),
      scope,
      messages,
      turnIds: turnIds.length > 0 ? turnIds : messages.map((message, index) => `${message.role}-${index}`),
      eventIds: [],
      metadata: objectValue(body.metadata) as JsonObject,
    });
    sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : jsonBodyErrorStatus(message);
    sendJson(res, status, { ok: false, error: message });
  }
}

export async function handleConversationFlush(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const body = objectValue(await parseJsonBody(req));
    const conversationId = readString(body.conversation_id ?? body.conversationId);
    if (!conversationId) {
      sendJson(res, 400, { ok: false, error: "conversation_id_required" });
      return;
    }
    const sessionId = readString(body.session_id ?? body.sessionId) || null;
    const maxBatch = readPositiveInt("MEMORY_XX_CONVERSATION_MAX_BATCH_MESSAGES", 10);
    const events = await selectFlushEvents(conversationId, sessionId, maxBatch);
    if (events.length === 0) {
      sendJson(res, 200, { ok: true, flushed: false, reason: "no_unprocessed_events" });
      return;
    }
    const scope = normalizeScopeContext(events[0]?.scope_context ?? body.scope_context ?? body.scopeContext);
    if (!(await authorizeScope(req, res, authContext, scope))) return;
    const force = body.force !== false;
    if (!force) {
      const latest = Math.max(...events.map((event) => new Date(event.observed_at).getTime()).filter(Number.isFinite));
      const debounceMs = readPositiveInt("MEMORY_XX_CONVERSATION_DEBOUNCE_MS", 60_000);
      const ready = hasExplicitMemoryIntent(events) ||
        hasSessionEnd(events) ||
        events.length >= maxBatch ||
        (Number.isFinite(latest) && Date.now() - latest >= debounceMs);
      if (!ready) {
        sendJson(res, 200, { ok: true, flushed: false, reason: "debounce_waiting", event_count: events.length, debounce_ms: debounceMs });
        return;
      }
    }
    const result = await processConversationBatch({
      conversationId,
      sessionId,
      agentId: readString(events[0]?.agent_id, "codex"),
      source: readString(events[0]?.source, "conversation-events-api"),
      scope,
      messages: events.map((event) => ({
        role: event.role,
        content: event.content,
        created_at: new Date(event.observed_at).toISOString(),
      })),
      turnIds: events.map((event) => event.turn_id),
      eventIds: events.map((event) => event.id),
      metadata: {
        flush_source: force ? "manual" : "worker",
        event_count: events.length,
        source_adapters: eventSourceAdapters(events),
        ...(eventSourceAdapters(events).length === 1 ? { source_adapter: eventSourceAdapters(events)[0] } : {}),
      },
    });
    sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : jsonBodyErrorStatus(message);
    sendJson(res, status, { ok: false, error: message });
  }
}
