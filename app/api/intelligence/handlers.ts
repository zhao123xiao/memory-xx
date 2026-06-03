
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { IntelligenceService } from "../../intelligence/service";
import type { ExtractedMemory, ExtractionMode } from "../../intelligence/types";
import { graphHintsMetadata } from "../../intelligence/graph-extraction";
import { SessionAnchorStore } from "../../intelligence/session-anchors";
import { SemanticWriteLock } from "../../intelligence/semantic-write-lock";
import { CreateMemoryService } from "../../write/services/create-memory-service";
import { SupersedeMemoryService } from "../../review/services/supersede-memory-service";
import { EphemeralMemoryStore, RecallRuntimeCacheInvalidator } from "../../cache";
import { LifecycleStatus, ReviewState, ScopeType, type JsonObject } from "../../shared";
import { LowConfidenceBufferRepository } from "../../db/repositories/low-confidence-buffer-repository";
import { WriteTicketRepository } from "../../db/repositories/write-ticket-repository";
import { MemoryRecordRepository } from "../../db/repositories/memory-record-repository";
import { withWriteTransaction } from "../../db/tx/write-transaction";
import {
  evaluateAutoApprovalPolicy,
} from "../../governance/auto-approval-policy";
import { collectAutoApprovalOperationalHealth } from "../../governance/auto-approval-health";
import { recordWriteQualityGate } from "../../observability/domain-metrics";
import { readRuntimeControlNumberSync } from "../../runtime-control-settings";
import * as runtime from "../../server/runtime";
import {
  createPermissionChecker,
  extractAuthToken,
  type MemoryPermission,
  type PermissionChecker,
} from "../../server/permissions";
import { parseJsonBody } from "../../server/body";
import {
  enforceScopePermission,
  enforceMemoryIdPermission,
  normalizeScopeTypeForGrant,
  strictScopeEnabled,
  type ScopeEnforcementContext,
} from "../../server/scope-enforcement";
import {
  isPlainObject,
  parseMode,
  parseScopeHint,
  readJsonObject,
  readMessages,
  readString,
  resolveScopeType,
  samePayload,
} from "./request-parsing";
import {
  countRecentSilentApproved,
  isTrustedAgent,
  loadSilentApprovePolicy,
  normalizeApprovalSource,
  qualityScoreOf,
  readIdempotencyKey,
  readLatencyMode,
  recordAutoApprovalAudit,
  hasTrustedAgentScopeGrant,
} from "./auto-approval-flow";
import { persistGraphEntityLinks } from "./graph-persistence";
import {
  coalesceConversationMemories,
  embedCanonicalContent,
  enrichConflicts,
  loadExistingMemoryContext,
  semanticPreflight,
  shouldTreatConversationDuplicateAsNoChange,
} from "./semantic-preflight";

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

function runtimePositiveInt(key: string, envName: string, fallback: number): number {
  const envRaw = process.env[envName]?.trim();
  const envValue = envRaw ? Number.parseInt(envRaw, 10) : fallback;
  const base = Number.isFinite(envValue) && envValue > 0 ? envValue : fallback;
  const runtimeValue = readRuntimeControlNumberSync(key, base);
  return Number.isFinite(runtimeValue) && runtimeValue > 0 ? runtimeValue : base;
}

function writeTicketTtlSeconds(): number {
  return runtimePositiveInt("write.ticket.ttl_seconds", "MEMORY_V2_WRITE_TICKET_TTL_SECONDS", 120);
}

function semanticLockTtlMs(): number {
  return runtimePositiveInt("write.semantic_lock.ttl_ms", "MEMORY_V2_SEMANTIC_LOCK_TTL_MS", 30_000);
}

function semanticLockWaitTimeoutMs(): number {
  return runtimePositiveInt("write.semantic_lock.wait_timeout_ms", "MEMORY_V2_SEMANTIC_LOCK_WAIT_TIMEOUT_MS", 5_000);
}

interface SmartWriteScopeAuthorizer {
  authorize(scope: { readonly scope_type: string; readonly scope_id: string }): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly body: Record<string, unknown>;
  }>;
}

function createSmartWriteScopeAuthorizer(
  req: IncomingMessage,
  context: ScopeEnforcementContext | undefined,
  permission: MemoryPermission = "memory:write"
): SmartWriteScopeAuthorizer {
  return {
    async authorize(scope) {
      if (!strictScopeEnabled(context)) {
        return { ok: true, status: 200, body: {} };
      }

      const checker: PermissionChecker = context?.permissions ?? createPermissionChecker(context?.env ?? process.env);
      const shouldClose = !context?.permissions;
      try {
        const decision = await checker.authorizeScope({
          token: extractAuthToken(req),
          permission,
          scopeType: normalizeScopeTypeForGrant(scope.scope_type),
          scopeId: scope.scope_id,
        });
        if (decision.allowed && decision.scopeAllowed) {
          return { ok: true, status: 200, body: {} };
        }
        return {
          ok: false,
          status: decision.authenticated ? 403 : 401,
          body: {
            error: decision.authenticated ? "forbidden" : "unauthorized",
            required: permission,
            scope: decision.scope ?? { scopeType: scope.scope_type, scopeId: scope.scope_id },
            reason: decision.reason ?? "scope_denied",
          },
        };
      } finally {
        if (shouldClose) await checker.close();
      }
    }
  };
}

interface SmartWriteDependencies {
  readonly intelligenceService?: Pick<IntelligenceService, "extract" | "resolveConflict">;
  readonly ephemeralMemoryStore?: Pick<EphemeralMemoryStore, "remember">;
}

function requestIdFrom(payload: Record<string, unknown>): string {
  return readString(payload.request_id ?? payload.requestId) || randomUUID();
}

async function executeSmartWrite(
  payload: Record<string, unknown>,
  mcpDefaults = false,
  scopeAuthorizer?: SmartWriteScopeAuthorizer
) {
  const db = runtime.writeDatabase;
  if (!db) return { status: 503, body: { error: "运行时尚未初始化" } };

  const agentId = readString(payload.agent_id, mcpDefaults ? "mcp-agent" : "intelligence");
  const latencyMode = readLatencyMode(payload.latency_mode);
  const actualLatencyMode = latencyMode === "fast_ack" && isTrustedAgent(agentId) ? "fast_ack" : "sync";
  const idempotencyKey = readIdempotencyKey(payload);

  if (actualLatencyMode === "fast_ack") {
    const ticketRepo = new WriteTicketRepository();
    const existing = idempotencyKey
      ? await withWriteTransaction(db, (tx) => ticketRepo.findByIdempotencyKey(tx, idempotencyKey))
      : null;
    if (existing) {
      if (!samePayload(existing.requestJson, payload)) {
        return {
          status: 409,
          body: { error: "idempotency_payload_conflict", ticket_id: existing.id },
        };
      }
      const terminal = existing.status !== "pending_extraction" && existing.status !== "processing_extraction";
      return {
        status: terminal ? 200 : 202,
        body: ticketResponse(existing, "fast_ack"),
      };
    }
    const ticketTtlSeconds = writeTicketTtlSeconds();
    const ticket = await withWriteTransaction(db, (tx) => ticketRepo.create(tx, {
      idempotencyKey,
      actorId: agentId,
      agentId,
      requestJson: payload as JsonObject,
      ttlSeconds: ticketTtlSeconds,
    }));
    if (!samePayload(ticket.requestJson, payload)) {
      return {
        status: 409,
        body: { error: "idempotency_payload_conflict", ticket_id: ticket.id },
      };
    }
    if (process.env.MEMORY_V2_FAST_ACK_INLINE_FALLBACK === "true") {
      void processSmartWrite(payload, mcpDefaults, ticket.id, "fast_ack", scopeAuthorizer).catch(async (error) => {
        await withWriteTransaction(db, (tx) => ticketRepo.complete(tx, {
          ticketId: ticket.id,
          status: "failed_extraction",
          failureReason: error instanceof Error ? error.message : String(error),
        })).catch(() => undefined);
      });
    }
    return {
      status: 202,
      body: {
        ticket_id: ticket.id,
        status: ticket.status,
        ticket_ttl_seconds: ticketTtlSeconds,
        actual_latency_mode: "fast_ack",
      },
    };
  }

  return processSmartWrite(payload, mcpDefaults, undefined, actualLatencyMode, scopeAuthorizer);
}

function ticketResponse(ticket: import("../../db/schema/tables").WriteTicketRow, actualLatencyMode: "sync" | "fast_ack") {
  return {
    ticket_id: ticket.id,
    status: ticket.status,
    ticket_ttl_seconds: Math.max(1, Math.round((Date.parse(ticket.expiresAt) - Date.parse(ticket.createdAt)) / 1000)) || writeTicketTtlSeconds(),
    actual_latency_mode: actualLatencyMode,
    created_memory_id: ticket.createdMemoryId,
    candidate_memory_id: ticket.candidateMemoryId,
    duplicate_of_memory_id: ticket.duplicateOfMemoryId,
    failure_reason: ticket.failureReason,
    result: ticket.resultJson,
  };
}

export async function processSmartWrite(
  payload: Record<string, unknown>,
  mcpDefaults = false,
  ticketId?: string,
  actualLatencyMode: "sync" | "fast_ack" = "sync",
  scopeAuthorizer?: SmartWriteScopeAuthorizer,
  databaseOverride?: import("../../db/tx/write-transaction").WriteTransactionRunner | null,
  dependencies?: SmartWriteDependencies,
) {
  const db = databaseOverride ?? runtime.writeDatabase;
  if (!db) return { status: 503, body: { error: "运行时尚未初始化" } };

  const mode = parseMode(payload.mode);
  const agentId = readString(payload.agent_id, mcpDefaults ? "mcp-agent" : "intelligence");
  const scopeHint = parseScopeHint(payload);
  const text = readString(payload.text);
  const messages = readMessages(payload.messages);
  const payloadMetadata = readJsonObject(payload.metadata);
  const sessionStore = new SessionAnchorStore();
  const sessionContext = sessionStore.getContext({
    session_id: readString(payload.session_id) || undefined,
    turn_id: readString(payload.turn_id) || undefined,
    run_id: readString(payload.run_id) || undefined,
  });
  const service = dependencies?.intelligenceService ??
    new IntelligenceService(undefined, undefined, undefined, { compareObservationDatabase: db });
  const existingMemories = await loadExistingMemoryContext(text, scopeHint);
  const extraction = await service.extract({
    text,
    messages,
    agent_id: agentId,
    user_id: typeof payload.user_id === "string" ? payload.user_id : undefined,
    workspace_id: typeof payload.workspace_id === "string" ? payload.workspace_id : undefined,
    scope_hint: scopeHint,
    existing_memories: existingMemories,
    session_context: {
      session_id: sessionContext.session_id,
      turn_id: sessionContext.turn_id,
      run_id: sessionContext.run_id,
      contextual_followup: sessionContext.contextual_followup,
      anchor_id: sessionContext.anchor_id,
    },
    mode,
  });

  if (!extraction.ok || !extraction.should_write || extraction.memories.length === 0 || mode === "draft") {
    const body = { ...extraction, mode, created: [], actual_latency_mode: actualLatencyMode, session_context: sessionContext };
    if (ticketId) await completeTicket(ticketId, "failed_extraction", body, { failureReason: extraction.failure_reason ?? "empty_memory" });
    return { status: 200, body };
  }

  const cacheInvalidator = new RecallRuntimeCacheInvalidator(runtime.recallCache, { database: db });
  const createService = new CreateMemoryService({
    database: db,
    cacheInvalidator,
    projectionSyncService: runtime.projectionSyncService ?? undefined,
  });
  const supersedeService = new SupersedeMemoryService({
    database: db,
    projectionSyncService: runtime.projectionSyncService ?? undefined,
  });

  if (scopeAuthorizer) {
    const seenScopes = new Set<string>();
    for (const memory of extraction.memories) {
      try {
        resolveScopeType(memory.scope_type);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
        const body = { error: message, scope: { scope_type: memory.scope_type, scope_id: memory.scope_id } };
        if (ticketId) {
          await completeTicket(ticketId, "failed_extraction", {
            ok: false,
            ...body,
            actual_latency_mode: actualLatencyMode,
          }, { failureReason: message });
        }
        return { status, body };
      }
      const scopeKey = `${memory.scope_type}:${memory.scope_id}`;
      if (seenScopes.has(scopeKey)) continue;
      seenScopes.add(scopeKey);
      const decision = await scopeAuthorizer.authorize({
        scope_type: memory.scope_type,
        scope_id: memory.scope_id,
      });
      if (!decision.ok) {
        if (ticketId) {
          await completeTicket(ticketId, "failed_extraction", {
            ok: false,
            ...decision.body,
            actual_latency_mode: actualLatencyMode,
          }, { failureReason: String(decision.body.reason ?? decision.body.error ?? "scope_denied") });
        }
        return { status: decision.status, body: decision.body };
      }
    }
  }
  const smartWriteSource = readString(
    payloadMetadata.source,
    mcpDefaults ? "memory-xx-mcp-smart-write" : "memory-xx-intelligence-smart-write"
  );
  const isConversationIngest = smartWriteSource === "conversation_ingest";
  let memories = await enrichConflicts(service as IntelligenceService, extraction.memories);
  if (isConversationIngest) {
    memories = coalesceConversationMemories(memories);
  }
  const created: Array<Record<string, unknown>> = [];
  if (isConversationIngest) {
    const maxConversationCandidates = Math.max(1, Number.parseInt(process.env.MEMORY_V2_CONVERSATION_MAX_CANDIDATES_PER_BATCH ?? "3", 10) || 3);
    const overflow = memories.slice(maxConversationCandidates);
    memories = memories.slice(0, maxConversationCandidates);
    for (const memory of overflow) {
      const buffer = await withWriteTransaction(db, (tx) => new LowConfidenceBufferRepository().add(tx, {
        requestId: requestIdFrom(payload),
        actorId: agentId,
        scopeType: memory.scope_type,
        scopeId: memory.scope_id,
        inputText: text,
        extraction: {
          provider: extraction.provider ?? "native",
          strategy: extraction.strategy ?? null,
          memory: memory as unknown as JsonObject,
        },
        qualityGate: {
          action: "buffer",
          reason: "candidate_batch_limit",
          max_candidates_per_batch: maxConversationCandidates,
        } as unknown as JsonObject,
      }));
      created.push({
        action: "buffer",
        low_confidence_buffer_id: buffer.id,
        reason: "candidate_batch_limit",
      });
    }
  }
  for (const memory of memories) {
    recordWriteQualityGate(memory.quality_gate ?? extraction.quality_gate);
    if ((memory.quality_gate?.score ?? extraction.quality_gate?.score ?? 1) < 0.60) {
      const buffer = await withWriteTransaction(db, (tx) => new LowConfidenceBufferRepository().add(tx, {
        requestId: requestIdFrom(payload),
        actorId: agentId,
        scopeType: memory.scope_type,
        scopeId: memory.scope_id,
        inputText: text,
        extraction: {
          provider: extraction.provider ?? "native",
          strategy: extraction.strategy ?? null,
          memory: memory as unknown as JsonObject,
        },
        qualityGate: (memory.quality_gate ?? extraction.quality_gate ?? {}) as unknown as JsonObject,
      }));
      created.push({
        action: "buffer",
        low_confidence_buffer_id: buffer.id,
        reason: "quality_gate_buffer",
      });
      continue;
    }

    const embedding = await embedCanonicalContent(memory.canonical_content);
    const lock = await new SemanticWriteLock().acquire({
      scopeType: memory.scope_type,
      scopeId: memory.scope_id,
      embedding,
      ttlMs: semanticLockTtlMs(),
      waitTimeoutMs: semanticLockWaitTimeoutMs(),
    });
    let semantic = await semanticPreflight(memory, embedding);
    if (lock.waited && !lock.timed_out) {
      semantic = await semanticPreflight(memory, embedding);
    }
    if (memory.conflict_action === "skip") {
      created.push({ memory_id: memory.existing_memory_id ?? null, action: "skip", reason: isConversationIngest ? "duplicate_no_change" : memory.conflict_reason ?? "duplicate" });
      lock.release();
      continue;
    }
    if (semantic.action === "skip") {
      created.push({
        memory_id: semantic.existing_memory_id ?? null,
        action: "skip",
        reason: isConversationIngest ? "semantic_duplicate_no_change" : "semantic_duplicate",
        semantic_dedup: semantic,
      });
      lock.release();
      continue;
    }
    if (isConversationIngest && shouldTreatConversationDuplicateAsNoChange(memory, semantic)) {
      created.push({
        memory_id: semantic.existing_memory_id ?? null,
        action: "skip",
        reason: "semantic_duplicate_no_change",
        semantic_dedup: {
          ...semantic,
          action: "skip",
          original_action: semantic.action,
          conversation_duplicate_policy: "no_change",
        },
      });
      lock.release();
      continue;
    }

    const effectiveMemory: ExtractedMemory =
      semantic.action === "merge_or_supersede" || semantic.action === "merge_review"
        ? {
            ...memory,
            existing_memory_id: semantic.existing_memory_id,
            conflict_action: semantic.action === "merge_review" ? "merge" : memory.conflict_action,
            conflict_reason: isConversationIngest && semantic.action === "merge_or_supersede"
              ? "needs_human_merge_review"
              : semantic.action,
          }
        : memory;
    const silentPolicy = await loadSilentApprovePolicy({
      agentId,
      scopeType: effectiveMemory.scope_type,
      scopeId: effectiveMemory.scope_id,
      memoryType: effectiveMemory.memory_type,
      source: smartWriteSource,
    });
    const hasScopeGrant = await hasTrustedAgentScopeGrant({
      agentId,
      scopeType: effectiveMemory.scope_type,
      scopeId: effectiveMemory.scope_id,
      database: db,
    });
    const normalizedSource = normalizeApprovalSource(smartWriteSource);
    const recentApprovedCount = await countRecentSilentApproved({
      agentId,
      scopeType: effectiveMemory.scope_type,
      scopeId: effectiveMemory.scope_id,
      source: smartWriteSource,
      database: db,
    });
    const healthSnapshot = await collectAutoApprovalOperationalHealth({ database: db });
    const approval = evaluateAutoApprovalPolicy({
      agentId,
      mode,
      source: normalizedSource,
      sourceText: text,
      candidate: {
        scopeType: effectiveMemory.scope_type,
        scopeId: effectiveMemory.scope_id,
        memoryType: effectiveMemory.memory_type,
        operation: effectiveMemory.operation ?? "add",
        conflictAction: effectiveMemory.conflict_action,
        conflictReason: effectiveMemory.conflict_reason,
        confidence: Math.min(extraction.confidence, effectiveMemory.confidence),
        qualityScore: qualityScoreOf(effectiveMemory, extraction.confidence),
        title: effectiveMemory.title,
        content: effectiveMemory.canonical_content,
        metadata: {
          ...payloadMetadata,
          source: smartWriteSource,
          memory_type: effectiveMemory.memory_type,
          topic: effectiveMemory.topic,
          ...(effectiveMemory.memory_class ? { memory_class: effectiveMemory.memory_class } : {}),
          ...(effectiveMemory.evidence_span ? { evidence_span: effectiveMemory.evidence_span } : {}),
          ...(effectiveMemory.why_long_term ? { why_long_term: effectiveMemory.why_long_term } : {}),
          ...(effectiveMemory.temporal_validity ? { temporal_validity: effectiveMemory.temporal_validity } : {}),
          ...(effectiveMemory.source_intent ? { source_intent: effectiveMemory.source_intent } : {}),
        },
      },
      trustedAgent: isTrustedAgent(agentId) || hasScopeGrant,
      hasScopeGrant,
      candidateOnly: silentPolicy.candidateOnly,
      candidateOnlyReasons: silentPolicy.candidateOnlyReasons,
      semanticConflict: semantic.action === "merge_or_supersede" || semantic.action === "merge_review",
      semanticDuplicate: false,
      autoApproveEnabled: silentPolicy.autoApproveEnabled,
      thresholdOverride: silentPolicy.threshold,
      recentApprovedCount,
      operationalBlockers: healthSnapshot.blockers,
    });

    const metadata: JsonObject = {
      source: smartWriteSource,
      memory_type: effectiveMemory.memory_type,
      topic: effectiveMemory.topic,
      memory_class: approval.memory_policy.memory_class,
      storage_target: approval.memory_policy.storage_target,
      recall_policy: approval.memory_policy.recall_policy,
      lifecycle_intent: approval.memory_policy.lifecycle_intent,
      policy_action: approval.memory_policy.policy_action,
      ...(approval.memory_policy.ttl_seconds ? { ttl_seconds: approval.memory_policy.ttl_seconds } : {}),
      ...(effectiveMemory.evidence_span ? { evidence_span: effectiveMemory.evidence_span } : {}),
      ...(effectiveMemory.why_long_term ? { why_long_term: effectiveMemory.why_long_term } : {}),
      ...(effectiveMemory.temporal_validity ? { temporal_validity: effectiveMemory.temporal_validity } : {}),
      ...(effectiveMemory.source_intent ? { source_intent: effectiveMemory.source_intent } : {}),
      confidence: effectiveMemory.confidence,
      ...(effectiveMemory.memory_type_corrected_from
        ? {
            memory_type_corrected_from: effectiveMemory.memory_type_corrected_from,
            memory_type_correction_reason: effectiveMemory.memory_type_correction_reason ?? "deterministic_type_correction",
          }
        : {}),
      conflict_action: effectiveMemory.conflict_action,
      existing_memory_id: effectiveMemory.existing_memory_id ?? null,
      conflict_reason: effectiveMemory.conflict_reason ?? null,
      session_context: sessionContext as unknown as JsonObject,
      quality_gate: (effectiveMemory.quality_gate ?? extraction.quality_gate ?? {}) as unknown as JsonObject,
      semantic_dedup: semantic as unknown as JsonObject,
      ...(isConversationIngest && (semantic.action === "merge_or_supersede" || semantic.action === "merge_review")
        ? {
            semantic_duplicate: {
              existing_memory_id: semantic.existing_memory_id ?? null,
              score: semantic.score ?? null,
              source: semantic.source,
              review_reason: semantic.action === "merge_or_supersede" ? "needs_human_merge_review" : "same_scope_similarity_review",
              action: semantic.action,
            },
          }
        : {}),
      ...(effectiveMemory.coalesced_from_count
        ? {
            coalesced_from_count: effectiveMemory.coalesced_from_count,
            coalesced_candidate_titles: [...(effectiveMemory.coalesced_candidate_titles ?? [])],
            coalesced_candidate_contents: [...(effectiveMemory.coalesced_candidate_contents ?? [])],
          }
        : {}),
      approval_mode: approval.approvalMode,
      auto_approval_policy: {
        decision: approval.decision,
        score: approval.score,
        reasons: [...approval.reasons],
        blocked_reasons: [...approval.blocked_reasons],
        policy_version: approval.policy_version,
        thresholds: approval.thresholds as unknown as JsonObject,
        scope_profile: approval.scope_profile,
        rollback_plan: approval.rollback_plan,
        privacy: approval.privacy,
        privacy_findings: Array.isArray(approval.privacy.findings) ? approval.privacy.findings : [],
        temporal: approval.temporal ?? {},
        memory_policy: approval.memory_policy as unknown as JsonObject,
        ...(approval.low_value ? { low_value: approval.low_value } : {}),
        operational_blockers: [...healthSnapshot.blockers],
        health_snapshot_id: healthSnapshot.id,
      },
      auto_approval_health_snapshot: healthSnapshot as unknown as JsonObject,
      silent_approve_policy: silentPolicy as unknown as JsonObject,
      intelligence_candidate_only: silentPolicy.candidateOnly,
      intelligence_candidate_only_reasons: [...silentPolicy.candidateOnlyReasons],
      ...(lock.timed_out ? { semantic_write_lock_timeout: true } : {}),
      ...((effectiveMemory.quality_gate?.score ?? extraction.quality_gate?.score ?? 1) < 0.75
        ? { review_reason: "quality_gate_low_confidence" }
        : {}),
      ...graphHintsMetadata(effectiveMemory.canonical_content),
      ...payloadMetadata,
      extraction_backend: extraction.provider ?? "native",
      mem0_used: extraction.mem0_used ?? false,
      ...(typeof extraction.mem0_attempted === "boolean" ? { mem0_attempted: extraction.mem0_attempted } : {}),
      ...(typeof extraction.mem0_success === "boolean" ? { mem0_success: extraction.mem0_success } : {}),
      ...(extraction.mem0_attempted_mode ? { mem0_attempted_mode: extraction.mem0_attempted_mode } : {}),
      ...(extraction.mem0_mode ? { mem0_mode: extraction.mem0_mode } : {}),
      ...(typeof extraction.mem0_official_attempted === "boolean" ? { mem0_official_attempted: extraction.mem0_official_attempted } : {}),
      ...(typeof extraction.mem0_official_success === "boolean" ? { mem0_official_success: extraction.mem0_official_success } : {}),
      ...(extraction.mem0_fallback_reason ? { mem0_fallback_reason: extraction.mem0_fallback_reason } : {}),
      ...(extraction.mem0_strategy_version ? { mem0_strategy_version: extraction.mem0_strategy_version } : {}),
      fallback_used: extraction.fallback_used,
      ...(extraction.fallback_reason ? { fallback_reason: extraction.fallback_reason } : {}),
    };

    if (approval.memory_policy.policy_action === "reject_by_policy" || approval.memory_policy.policy_action === "ephemeral_only" || approval.memory_policy.policy_action === "skip") {
      const ephemeralResult = approval.memory_policy.policy_action === "ephemeral_only"
        ? await (dependencies?.ephemeralMemoryStore ?? new EphemeralMemoryStore()).remember({
          scopeType: effectiveMemory.scope_type,
          scopeId: effectiveMemory.scope_id,
          content: effectiveMemory.canonical_content,
          ttlSeconds: approval.memory_policy.ttl_seconds ?? 1800,
          metadata,
        })
        : null;
      created.push({
        action: approval.memory_policy.policy_action,
        reason: approval.memory_policy.reasons[0] ?? "memory_policy",
        memory_class: approval.memory_policy.memory_class,
        storage_target: approval.memory_policy.storage_target,
        recall_policy: approval.memory_policy.recall_policy,
        lifecycle_intent: approval.memory_policy.lifecycle_intent,
        ...(approval.memory_policy.ttl_seconds ? { ttl_seconds: approval.memory_policy.ttl_seconds } : {}),
        ...(ephemeralResult ? {
          ephemeral_key: ephemeralResult.key,
          ephemeral_store_status: ephemeralResult.status,
          ephemeral_store_reason: ephemeralResult.reason,
          expires_at: ephemeralResult.expires_at,
          ttl_seconds: ephemeralResult.ttl_seconds,
        } : {}),
        auto_approval: {
          decision: approval.decision,
          score: approval.score,
          blocked_reasons: [...approval.blocked_reasons],
          policy_version: approval.policy_version,
          memory_policy: approval.memory_policy,
        },
      });
      await recordAutoApprovalAudit({
        candidateMemoryId: null,
        approvedMemoryId: null,
        agentId,
        scopeType: effectiveMemory.scope_type,
        scopeId: effectiveMemory.scope_id,
        policy: approval,
        source: smartWriteSource,
        memoryType: effectiveMemory.memory_type,
        database: db,
      });
      lock.release();
      continue;
    }

    if (approval.reviewState === ReviewState.SilentApproved && effectiveMemory.existing_memory_id && (effectiveMemory.conflict_action === "merge" || effectiveMemory.conflict_action === "supersede")) {
      const result = await supersedeService.execute({
        requestId: randomUUID(),
        actorId: agentId,
        memoryId: effectiveMemory.existing_memory_id,
        content: effectiveMemory.canonical_content,
        title: effectiveMemory.title,
        summary: null,
        metadata,
        dedupeKey: effectiveMemory.dedupe_key,
        reviewState: ReviewState.SilentApproved,
        sources: [],
        relations: [],
      });
      await cacheInvalidator.invalidate([{ type: resolveScopeType(effectiveMemory.scope_type), id: effectiveMemory.scope_id }]);
      created.push({
        memory_id: result.memoryId,
        action: approval.memory_policy.policy_action === "create_memory" ? effectiveMemory.conflict_action : approval.memory_policy.policy_action,
        lifecycle_status: result.lifecycleStatus,
        review_state: result.reviewState,
        superseded_memory_id: result.supersededMemoryId,
        semantic_dedup: semantic,
        approval_mode: approval.approvalMode,
        memory_class: approval.memory_policy.memory_class,
        recall_policy: approval.memory_policy.recall_policy,
      });
      await recordAutoApprovalAudit({
        approvedMemoryId: result.memoryId,
        agentId,
        scopeType: effectiveMemory.scope_type,
        scopeId: effectiveMemory.scope_id,
        policy: approval,
        source: smartWriteSource,
        memoryType: effectiveMemory.memory_type,
        database: db,
      });
      await persistGraphEntityLinks({
        memoryId: result.memoryId,
        content: effectiveMemory.canonical_content,
      }).catch(() => undefined);
      sessionStore.rememberAnchor({
        session_id: sessionContext.session_id,
        turn_id: sessionContext.turn_id,
        run_id: sessionContext.run_id,
        memory_type: effectiveMemory.memory_type,
        topic: effectiveMemory.topic,
        anchor_id: result.memoryId,
      });
      lock.release();
      continue;
    }

    const dedupeKey = effectiveMemory.existing_memory_id && approval.reviewState !== ReviewState.SilentApproved
      ? effectiveMemory.dedupe_key + ":pending:" + randomUUID()
      : effectiveMemory.dedupe_key;
    const writeResult = await createService.execute({
      requestId: readIdempotencyKey(payload) ?? randomUUID(),
      actorId: agentId,
      scopeType: resolveScopeType(effectiveMemory.scope_type),
      scopeId: effectiveMemory.scope_id,
      content: effectiveMemory.canonical_content,
      lifecycleStatus: approval.lifecycleStatus,
      reviewState: approval.reviewState,
      title: effectiveMemory.title,
      summary: null,
      metadata,
      dedupeKey,
      memoryType: effectiveMemory.memory_type,
      contentEmbedding: embedding,
      sources: [],
      relations: [],
    });
    created.push({
      memory_id: writeResult.memoryId,
      action: approval.memory_policy.policy_action === "create_candidate" || approval.memory_policy.policy_action === "create_memory"
        ? effectiveMemory.conflict_action
        : approval.memory_policy.policy_action,
      lifecycle_status: writeResult.lifecycleStatus,
      review_state: writeResult.reviewState,
      replayed: writeResult.replayed === true,
      semantic_dedup: semantic,
      approval_mode: approval.approvalMode,
      memory_class: approval.memory_policy.memory_class,
      recall_policy: approval.memory_policy.recall_policy,
      auto_approval: {
        decision: approval.decision,
        score: approval.score,
        blocked_reasons: [...approval.blocked_reasons],
        policy_version: approval.policy_version,
        memory_policy: approval.memory_policy,
      },
    });
    await recordAutoApprovalAudit({
      candidateMemoryId: approval.decision === "approve" ? null : writeResult.memoryId,
      approvedMemoryId: approval.decision === "approve" ? writeResult.memoryId : null,
      agentId,
      scopeType: effectiveMemory.scope_type,
      scopeId: effectiveMemory.scope_id,
      policy: approval,
      source: smartWriteSource,
      memoryType: effectiveMemory.memory_type,
      database: db,
    });
    await persistGraphEntityLinks({
      memoryId: writeResult.memoryId,
      content: effectiveMemory.canonical_content,
    }).catch(() => undefined);
    sessionStore.rememberAnchor({
      session_id: sessionContext.session_id,
      turn_id: sessionContext.turn_id,
      run_id: sessionContext.run_id,
      memory_type: effectiveMemory.memory_type,
      topic: effectiveMemory.topic,
      anchor_id: writeResult.memoryId,
    });
    lock.release();
  }

  const body = {
    ...extraction,
    mode,
    actual_latency_mode: actualLatencyMode,
    session_context: sessionContext,
    memories,
    created,
  };
  if (ticketId) {
    const first = created[0] ?? {};
    const status = first.action === "skip"
      ? "skipped_duplicate"
      : first.action === "buffer"
        ? "cancelled_low_quality"
        : first.review_state === ReviewState.Pending
          ? "needs_review"
          : "completed";
    await completeTicket(ticketId, status, body, {
      createdMemoryId: typeof first.memory_id === "string" && status === "completed" ? first.memory_id : undefined,
      candidateMemoryId: typeof first.memory_id === "string" && status === "needs_review" ? first.memory_id : undefined,
      duplicateOfMemoryId: typeof first.memory_id === "string" && status === "skipped_duplicate" ? first.memory_id : undefined,
      failureReason: status === "cancelled_low_quality" ? "quality_gate_buffer" : undefined,
    });
  }
  return { status: 200, body };
}

async function completeTicket(
  ticketId: string,
  status: Exclude<import("../../db/schema/tables").WriteTicketStatus, "pending_extraction" | "processing_extraction">,
  body: Record<string, unknown>,
  ids: {
    readonly createdMemoryId?: string;
    readonly candidateMemoryId?: string;
    readonly duplicateOfMemoryId?: string;
    readonly failureReason?: string;
  } = {},
): Promise<void> {
  const db = runtime.writeDatabase;
  if (!db) return;
  await withWriteTransaction(db, (tx) => new WriteTicketRepository().complete(tx, {
    ticketId,
    status,
    resultJson: body as JsonObject,
    createdMemoryId: ids.createdMemoryId ?? null,
    candidateMemoryId: ids.candidateMemoryId ?? null,
    duplicateOfMemoryId: ids.duplicateOfMemoryId ?? null,
    failureReason: ids.failureReason ?? null,
  }));
}

export async function processPendingWriteTickets(options: {
  readonly workerId?: string;
  readonly limit?: number;
  readonly leaseTtlSeconds?: number;
} = {}): Promise<{ claimed: number; completed: number; failed: number }> {
  const db = runtime.writeDatabase;
  if (!db) return { claimed: 0, completed: 0, failed: 0 };
  const repo = new WriteTicketRepository();
  const workerId = options.workerId ?? process.env.MEMORY_V2_WORKER_ID?.trim() ?? `write-ticket-${process.pid}`;
  const tickets = await withWriteTransaction(db, (tx) => repo.claimNext(tx, {
    workerId,
    limit: options.limit ?? 10,
    leaseTtlSeconds: options.leaseTtlSeconds ?? 120,
  }));
  let completed = 0;
  let failed = 0;
  for (const ticket of tickets) {
    try {
      await withWriteTransaction(db, (tx) => repo.heartbeat(tx, ticket.id, workerId, options.leaseTtlSeconds ?? 120));
      await processSmartWrite(ticket.requestJson, false, ticket.id, "fast_ack");
      completed += 1;
    } catch (error) {
      failed += 1;
      await withWriteTransaction(db, (tx) => repo.complete(tx, {
        ticketId: ticket.id,
        status: "failed_extraction",
        failureReason: error instanceof Error ? error.message : String(error),
      })).catch(() => undefined);
    }
  }
  return { claimed: tickets.length, completed, failed };
}

export async function handleIntelligenceExtract(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const body = await parseJsonBody(req);
    const payload = (isPlainObject(body) ? body : {}) as Record<string, unknown>;
    const scopeHint = parseScopeHint(payload);
    if (!scopeHint && strictScopeEnabled(authContext)) {
      sendJson(res, 400, { error: "scope_hint_required" });
      return;
    }
    if (scopeHint && !(await enforceScopePermission(req, res, authContext, "memory:write", [{
      scopeType: resolveScopeType(scopeHint.scope_type),
      scopeId: scopeHint.scope_id,
    }]))) {
      return;
    }
    const service = new IntelligenceService(undefined, undefined, undefined, { compareObservationDatabase: runtime.writeDatabase });
    const extraction = await service.extract({
      text: readString(payload.text),
      agent_id: readString(payload.agent_id, "unknown"),
      user_id: typeof payload.user_id === "string" ? payload.user_id : undefined,
      workspace_id: typeof payload.workspace_id === "string" ? payload.workspace_id : undefined,
      scope_hint: scopeHint,
      mode: "draft",
    });
    sendJson(res, 200, extraction);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : jsonBodyErrorStatus(message);
    sendJson(res, status, { error: message });
  }
}

export async function handleIntelligenceSmartWrite(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const body = await parseJsonBody(req);
    const payload = (isPlainObject(body) ? body : {}) as Record<string, unknown>;
    const scopeHint = parseScopeHint(payload);
    if (!scopeHint && strictScopeEnabled(authContext)) {
      sendJson(res, 400, { error: "scope_hint_required" });
      return;
    }
    if (scopeHint && !(await enforceScopePermission(req, res, authContext, "memory:write", [{
      scopeType: resolveScopeType(scopeHint.scope_type),
      scopeId: scopeHint.scope_id,
    }]))) {
      return;
    }
    const result = await executeSmartWrite(payload, false, createSmartWriteScopeAuthorizer(req, authContext));
    sendJson(res, result.status, result.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : jsonBodyErrorStatus(message);
    sendJson(res, status, { error: message });
  }
}

export async function handleWriteTicket(
  req: IncomingMessage,
  res: ServerResponse,
  ticketId: string,
  authContext?: ScopeEnforcementContext
): Promise<void> {
  if (req.method !== "GET") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const db = runtime.writeDatabase;
    if (!db) { sendJson(res, 503, { error: "运行时尚未初始化" }); return; }
    const repo = new WriteTicketRepository();
    await withWriteTransaction(db, (tx) => repo.failExpired(tx));
    const ticket = await withWriteTransaction(db, (tx) => repo.findById(tx, ticketId));
    if (!ticket) { sendJson(res, 404, { error: "write_ticket_not_found" }); return; }
    const memoryIds = [
      ticket.createdMemoryId,
      ticket.candidateMemoryId,
      ticket.duplicateOfMemoryId,
    ].filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    if (memoryIds.length > 0) {
      if (!(await enforceMemoryIdPermission(req, res, authContext, "memory:read", memoryIds))) return;
    } else {
      const scopeHint = parseScopeHint(ticket.requestJson);
      if (scopeHint && !(await enforceScopePermission(req, res, authContext, "memory:read", [{
        scopeType: normalizeScopeTypeForGrant(scopeHint.scope_type),
        scopeId: scopeHint.scope_id,
      }]))) {
        return;
      }
    }
    sendJson(res, 200, ticketResponse(ticket, "fast_ack"));
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
  }
}

export async function handleMcpSmartWrite(req: IncomingMessage, res: ServerResponse, authContext?: ScopeEnforcementContext): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { error: "请求方法不允许" }); return; }
  try {
    const body = await parseJsonBody(req);
    const payload = (isPlainObject(body) ? body : {}) as Record<string, unknown>;
    const scopeHint = parseScopeHint(payload);
    if (!scopeHint && strictScopeEnabled(authContext)) {
      sendJson(res, 400, { error: "scope_hint_required" });
      return;
    }
    if (scopeHint && !(await enforceScopePermission(req, res, authContext, "memory:write", [{
      scopeType: resolveScopeType(scopeHint.scope_type),
      scopeId: scopeHint.scope_id,
    }]))) {
      return;
    }
    const result = await executeSmartWrite(payload, true, createSmartWriteScopeAuthorizer(req, authContext));
    sendJson(res, result.status, result.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : jsonBodyErrorStatus(message);
    sendJson(res, status, { error: message });
  }
}
