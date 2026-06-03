import { IntelligenceLLMClient } from "./llm-client";
import { Mem0ExtractionClient } from "./mem0-client";
import type { IntelligenceConfig } from "./config";
import { loadIntelligenceConfig } from "./config";
import {
  CONFLICT_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT,
  buildConflictUserPrompt,
  buildExtractionUserPrompt,
} from "./prompts";
import { computeDedupeKey } from "./dedup-engine";
import { resolveConflictRules } from "./conflict";
import { combineQualityGates, evaluateExtractionQuality } from "./quality-gate";
import { persistIntelligenceCompareObservation, recordIntelligenceCompareObservation } from "./compare-observation";
import type { WriteTransactionRunner } from "../db/tx/write-transaction";
import type {
  ConflictAction,
  ExistingMemoryForConflict,
  ExtractedMemoryClass,
  ExtractedMemory,
  FailureReason,
  LLMCallResult,
  MemoryOperation,
  MemoryType,
  SmartExtractionRequest,
  SmartExtractionResponse,
} from "./types";

interface RawExtractionMemory {
  content?: unknown;
  canonical_content?: unknown;
  memory_type?: unknown;
  topic?: unknown;
  title?: unknown;
  confidence?: unknown;
  dedupe_key?: unknown;
  dedupeKey?: unknown;
  operation?: unknown;
  existing_memory_id?: unknown;
  conflict_reason?: unknown;
  memory_class?: unknown;
  evidence_span?: unknown;
  why_long_term?: unknown;
  temporal_validity?: unknown;
  source_intent?: unknown;
}

interface RawExtractionOutput {
  ok?: unknown;
  should_write?: unknown;
  confidence?: unknown;
  memories?: unknown;
  strategy?: unknown;
  operation?: unknown;
  quality_flags?: unknown;
  schema_repair_applied?: unknown;
  transport_error?: unknown;
  failure_reason?: unknown;
}

interface IntentGuard {
  force_write: boolean;
  force_skip: boolean;
  reason: string;
  canonical_seed: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readMemoryClass(value: unknown): ExtractedMemoryClass | undefined {
  const raw = readString(value);
  return [
    "long_term_fact",
    "preference",
    "constraint",
    "decision",
    "procedure",
    "operational_issue",
    "test_evidence",
    "audit_evidence",
    "runtime_noise",
    "ephemeral_task",
    "explicit_no_memory",
    "unknown_source_quarantine",
  ].includes(raw) ? raw as ExtractedMemoryClass : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function modelTrace(primary: string, final: string) {
  return { primary, final };
}

function fallbackReasonOf(result: LLMCallResult): FailureReason | undefined {
  return result.fallback_reason ?? result.failure_reason;
}

function isTransportFailure(reason: FailureReason | undefined): boolean {
  return reason === "timeout" ||
    reason === "network_error" ||
    reason === "http_error" ||
    reason === "llm_http_429" ||
    reason === "llm_http_5xx";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function buildIntentGuard(text: string, contextualFollowup = false): IntentGuard {
  const trimmed = text.trim();
  const negative = /(?:不要|不用|别).{0,12}(?:记住|记忆|保存|写入|加入|记录)|(?:do not|don't)\s+(?:remember|save|store)|临时测试|只是临时|temporary only/i.test(trimmed);
  const explicitRemember = /请记住|帮我记住|记住|记一下|记下来|remember this|please remember/i.test(trimmed);
  const explicit = explicitRemember || /我的偏好|以后|后续|必须|不能|不超过|must|prefer/i.test(trimmed);
  const questionOnly = !explicitRemember && /(?:[?？]\s*$|是否|吗[?？\s]*$|么[?？\s]*$)/u.test(trimmed);
  const canonicalSeed = trimmed
    .replace(/^(?:请|麻烦|帮我)?(?:记住|记一下|记下来)[:：,，\s]*/u, "")
    .replace(/^我的偏好[:：,，\s]*/u, "My preference: ")
    .trim() || trimmed;

  if (negative || questionOnly) {
    return { force_write: false, force_skip: true, reason: negative ? "negative_memory_intent" : "question_only", canonical_seed: canonicalSeed };
  }
  if (explicit) {
    return { force_write: true, force_skip: false, reason: "explicit_memory_intent", canonical_seed: canonicalSeed };
  }
  if (contextualFollowup) {
    return { force_write: true, force_skip: false, reason: "contextual_followup", canonical_seed: canonicalSeed };
  }
  return { force_write: false, force_skip: false, reason: "model_decides", canonical_seed: canonicalSeed };
}

function cleanCanonicalSeed(text: string): string {
  return text
    .replace(/^(?:请|麻烦|帮我)?(?:记住|记一下|记下来)[:：,，\s]*/u, "")
    .replace(/\b(?:test tag|test marker|run id|run_id)[:：\s-]*[a-z0-9-]{6,}\b/gi, "")
    .replace(/测试标记\s*[a-zA-Z0-9-]+/gu, "")
    .replace(/样本\s*\d+/gu, "")
    .replace(/benchmark-\d+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactTypeText(inputText: string, canonicalContent: string): string {
  return `${inputText}\n${canonicalContent}`.toLowerCase();
}

function deterministicTypeCorrection(
  rawType: MemoryType,
  inputText: string,
  canonicalContent: string
): { memoryType: MemoryType; correctedFrom?: MemoryType; reason?: string } {
  const text = compactTypeText(inputText, canonicalContent);
  const hardConstraint = /必须|不能|禁止|不超过|至少|限制|硬约束|约束|must|never|constraint|limit/i.test(text);
  if (hardConstraint) {
    return rawType === "constraint"
      ? { memoryType: rawType }
      : { memoryType: "constraint", correctedFrom: rawType, reason: "constraint_keyword" };
  }

  const decision = /决定|决策|策略选择|默认仍保持|默认保持|先用|先采用|选定|decided|decision/i.test(text);
  if (decision) {
    return rawType === "decision"
      ? { memoryType: rawType }
      : { memoryType: "decision", correctedFrom: rawType, reason: "decision_keyword" };
  }

  const preference = /我以后|我的偏好|偏好|优先|倾向|prefer|preference/i.test(text);
  if (preference) {
    return rawType === "preference"
      ? { memoryType: rawType }
      : { memoryType: "preference", correctedFrom: rawType, reason: "preference_keyword" };
  }

  const softConstraint = /应该|should/i.test(text);
  if (softConstraint) {
    return rawType === "constraint"
      ? { memoryType: rawType }
      : { memoryType: "constraint", correctedFrom: rawType, reason: "constraint_keyword" };
  }

  return { memoryType: rawType };
}

function mem0ModeFromModel(model: string): "official" | "legacy_extract" {
  return model.includes(":official") ? "official" : "legacy_extract";
}

function mem0ModeFromResult(result: LLMCallResult | undefined): "official" | "legacy_extract" | undefined {
  if (!result) return undefined;
  return result.mem0_attempted_mode ?? mem0ModeFromModel(result.model);
}

function mem0OfficialAttempted(result: LLMCallResult | undefined, mode: "official" | "legacy_extract" | undefined): boolean | undefined {
  if (!result && !mode) return undefined;
  return result?.mem0_official_attempted ?? mode === "official";
}

function mem0OfficialSuccess(result: LLMCallResult | undefined, mode: "official" | "legacy_extract" | undefined, success: boolean): boolean | undefined {
  if (!result && !mode) return undefined;
  return result?.mem0_official_success ?? (mode === "official" && success);
}

export class IntelligenceService {
  private readonly llmClient: IntelligenceLLMClient;
  private readonly mem0Client: Mem0ExtractionClient;
  private readonly config: IntelligenceConfig;
  private readonly compareObservationDatabase?: WriteTransactionRunner;

  constructor(
    config?: IntelligenceConfig,
    llmClient?: IntelligenceLLMClient,
    mem0Client?: Mem0ExtractionClient,
    options?: { readonly compareObservationDatabase?: WriteTransactionRunner | null }
  ) {
    this.config = config ?? loadIntelligenceConfig();
    this.llmClient = llmClient ?? new IntelligenceLLMClient(this.config);
    this.mem0Client = mem0Client ?? new Mem0ExtractionClient(this.config);
    this.compareObservationDatabase = options?.compareObservationDatabase ?? undefined;
  }

  hasFallbackConfigured(): boolean {
    return this.llmClient.hasFallbackConfigured();
  }

  async extract(request: SmartExtractionRequest): Promise<SmartExtractionResponse> {
    const guard = buildIntentGuard(request.text, request.session_context?.contextual_followup === true);
    if (guard.force_skip) {
      return this.guardSkipResponse(guard);
    }

    if (this.config.provider === "mem0") {
      const mem0 = await this.extractWithMem0(request);
      if (guard.force_write) {
        return await this.ensureGuardedWrite(mem0, buildExtractionUserPrompt(request.text, request.scope_hint), request, guard);
      }
      return mem0;
    }

    const userPrompt = buildExtractionUserPrompt(request.text, request.scope_hint);
    const first = await this.llmClient.callPrimary(EXTRACTION_SYSTEM_PROMPT, userPrompt);
    this.sampleFallbackComparison(userPrompt, first, first.failure_reason ?? "unknown");
    const normalized = await this.normalizeOrFallback(first, userPrompt, request, first.failure_reason);
    if (guard.force_write) {
      return await this.ensureGuardedWrite(normalized, userPrompt, request, guard);
    }
    return normalized;
  }

  private sampleFallbackComparison(userPrompt: string, primary: LLMCallResult, reason: FailureReason): void {
    if (this.config.compareSampleRate <= 0 || !this.hasFallbackConfigured()) return;
    if (Math.random() > this.config.compareSampleRate) return;
    void this.llmClient
      .callFallback(EXTRACTION_SYSTEM_PROMPT, userPrompt, reason)
      .then((fallback) => {
        const observation = recordIntelligenceCompareObservation({ primary, fallback });
        if (this.compareObservationDatabase) {
          void persistIntelligenceCompareObservation(this.compareObservationDatabase, observation).catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }

  private async extractWithMem0(request: SmartExtractionRequest): Promise<SmartExtractionResponse> {
    const result = await this.mem0Client.extract(request);
    if (result.ok) {
      const normalized = this.normalizeParsed(result, request, { provider: "mem0", mem0Used: true });
      if (normalized.ok && normalized.response) {
        if (normalized.response.should_write && normalized.response.confidence < this.config.lowConfidenceThreshold) {
          return await this.nativeFallback(request, "low_confidence", result);
        }
        return normalized.response;
      }
      return await this.nativeFallback(request, normalized.reason ?? "schema_invalid", result);
    }

    const reason = result.failure_reason ?? "mem0_error";
    if (isTransportFailure(reason)) {
      return await this.nativeFallback(request, reason, result);
    }
    return await this.nativeFallback(request, result.failure_reason ?? "mem0_error", result);
  }

  private mem0UnavailableResponse(reason: FailureReason, mem0Result: LLMCallResult): SmartExtractionResponse {
    return {
      ok: false,
      should_write: false,
      confidence: 0,
      memories: [],
      model: modelTrace(`mem0:${this.config.model}`, mem0Result.model ?? `mem0:${this.config.model}`),
      provider: "mem0",
      mem0_used: true,
      mem0_attempted: true,
      mem0_success: false,
      mem0_attempted_mode: mem0ModeFromResult(mem0Result),
      mem0_mode: mem0ModeFromResult(mem0Result),
      mem0_official_attempted: mem0OfficialAttempted(mem0Result, mem0ModeFromResult(mem0Result)),
      mem0_official_success: mem0OfficialSuccess(mem0Result, mem0ModeFromResult(mem0Result), false),
      mem0_fallback_reason: reason,
      mem0_strategy_version: this.config.mem0StrategyVersion,
      transport_error: true,
      fallback_used: false,
      fallback_reason: reason,
      failure_reason: reason,
      error: mem0Result.error ?? reason,
    };
  }

  private async nativeFallback(
    request: SmartExtractionRequest,
    reason: FailureReason,
    mem0Result?: LLMCallResult,
  ): Promise<SmartExtractionResponse> {
    if (!this.config.nativeFallback) {
      return {
        ok: false,
        should_write: false,
        confidence: 0,
        memories: [],
        model: modelTrace(`mem0:${this.config.model}`, mem0Result?.model ?? `mem0:${this.config.model}`),
        provider: "mem0",
        mem0_used: true,
        mem0_attempted: true,
        mem0_success: false,
        mem0_attempted_mode: mem0ModeFromResult(mem0Result),
        mem0_mode: mem0ModeFromResult(mem0Result),
        mem0_official_attempted: mem0OfficialAttempted(mem0Result, mem0ModeFromResult(mem0Result)),
        mem0_official_success: mem0OfficialSuccess(mem0Result, mem0ModeFromResult(mem0Result), false),
        mem0_fallback_reason: reason,
        mem0_strategy_version: this.config.mem0StrategyVersion,
        fallback_used: false,
        failure_reason: reason,
        error: mem0Result?.error ?? reason,
      };
    }

    const userPrompt = buildExtractionUserPrompt(request.text, request.scope_hint);
    const first = await this.llmClient.callPrimary(EXTRACTION_SYSTEM_PROMPT, userPrompt);
    const native = await this.normalizeOrFallback(first, userPrompt, request, first.failure_reason);
    return {
      ...native,
      provider: "mem0",
      mem0_used: true,
      mem0_attempted: true,
      mem0_success: false,
      mem0_attempted_mode: mem0ModeFromResult(mem0Result),
      mem0_mode: mem0ModeFromResult(mem0Result),
      mem0_official_attempted: mem0OfficialAttempted(mem0Result, mem0ModeFromResult(mem0Result)),
      mem0_official_success: mem0OfficialSuccess(mem0Result, mem0ModeFromResult(mem0Result), false),
      mem0_fallback_reason: reason,
      mem0_strategy_version: this.config.mem0StrategyVersion,
      fallback_used: true,
      fallback_reason: reason,
      model: modelTrace(`mem0:${this.config.model}`, native.model.final),
    };
  }

  async resolveConflict(memory: ExtractedMemory, existing: ExistingMemoryForConflict): Promise<ExtractedMemory> {
    const exactDuplicate = existing.content.trim() === memory.canonical_content.trim();
    if (exactDuplicate) {
      return {
        ...memory,
        conflict_action: "skip",
        existing_memory_id: existing.id,
        conflict_reason: "exact_duplicate",
      };
    }

    const rule = resolveConflictRules(memory);
    if ((rule.action === "merge" || rule.action === "supersede") && this.hasFallbackConfigured()) {
      const result = await this.llmClient.callFallback(
        CONFLICT_SYSTEM_PROMPT,
        buildConflictUserPrompt({
          existingContent: existing.content,
          newContent: memory.canonical_content,
          memoryType: memory.memory_type,
          topic: memory.topic,
        }),
        "low_confidence"
      );
      if (result.ok && isPlainObject(result.parsed)) {
        const action = this.validateConflictAction(readString(result.parsed.conflict_action), rule.action);
        const canonical = readString(result.parsed.canonical_content) || memory.canonical_content;
        const reason = readString(result.parsed.reason) || "fallback_conflict_resolution";
        return {
          ...memory,
          content: canonical,
          canonical_content: canonical,
          conflict_action: action,
          existing_memory_id: existing.id,
          conflict_reason: reason,
        };
      }
    }

    const fallbackMerge = rule.action === "merge"
      ? this.mergeContents(existing.content, memory.canonical_content, this.hasFallbackConfigured())
      : { action: rule.action, content: memory.canonical_content, reason: rule.reason };
    return {
      ...memory,
      content: fallbackMerge.content,
      canonical_content: fallbackMerge.content,
      conflict_action: fallbackMerge.action,
      existing_memory_id: existing.id,
      conflict_reason: this.hasFallbackConfigured() ? fallbackMerge.reason : "fallback_config_missing; " + fallbackMerge.reason,
    };
  }

  private async normalizeOrFallback(
    result: LLMCallResult,
    userPrompt: string,
    request: SmartExtractionRequest,
    fallbackReason?: FailureReason,
  ): Promise<SmartExtractionResponse> {
    if (!result.ok) {
      if (!result.fallback_used && result.failure_reason !== "fallback_config_missing") {
        const fallback = await this.llmClient.callFallback(EXTRACTION_SYSTEM_PROMPT, userPrompt, result.failure_reason ?? "unknown");
        if (!fallback.ok) return this.failureResponse(fallback, fallback.failure_reason ?? result.failure_reason ?? "unknown");
        const fallbackNormalized = this.normalizeParsed(fallback, request);
        return fallbackNormalized.response ?? this.failureResponse(fallback, fallbackNormalized.reason ?? "schema_invalid");
      }
      return this.failureResponse(result, fallbackReason ?? result.failure_reason ?? "unknown");
    }

    const normalized = this.normalizeParsed(result, request);
    if (normalized.ok && normalized.response) {
      if (
        normalized.response.should_write &&
        normalized.response.confidence < this.config.lowConfidenceThreshold &&
        !result.fallback_used
      ) {
        const fallback = await this.llmClient.callFallback(EXTRACTION_SYSTEM_PROMPT, userPrompt, "low_confidence");
        if (!fallback.ok) return this.failureResponse(fallback, fallback.failure_reason ?? "low_confidence");
        const fallbackNormalized = this.normalizeParsed(fallback, request);
        return fallbackNormalized.response ?? this.failureResponse(fallback, fallbackNormalized.reason ?? "schema_invalid");
      }
      return normalized.response;
    }

    if (!result.fallback_used) {
      const fallback = await this.llmClient.callFallback(EXTRACTION_SYSTEM_PROMPT, userPrompt, normalized.reason ?? "schema_invalid");
      if (!fallback.ok) return this.failureResponse(fallback, fallback.failure_reason ?? "schema_invalid");
      const fallbackNormalized = this.normalizeParsed(fallback, request);
      return fallbackNormalized.response ?? this.failureResponse(fallback, fallbackNormalized.reason ?? "schema_invalid");
    }

    return this.failureResponse(result, normalized.reason ?? "schema_invalid");
  }

  private normalizeParsed(
    result: LLMCallResult,
    request: SmartExtractionRequest,
    source?: { provider?: "native" | "mem0"; mem0Used?: boolean },
  ): { ok: boolean; response?: SmartExtractionResponse; reason?: FailureReason } {
    if (!isPlainObject(result.parsed)) return { ok: false, reason: "schema_invalid" };
    const output = result.parsed as RawExtractionOutput;
    if (output.ok === false) return { ok: false, reason: this.validateFailureReason(readString(output.failure_reason), "mem0_error") };
    if (typeof output.should_write !== "boolean") return { ok: false, reason: "schema_invalid" };
    const confidence = readNumber(output.confidence, output.should_write ? 0.5 : 1);
    const operation = this.validateOperation(readString(output.operation), output.should_write ? "add" : "no_change");
    const strategy = readString(output.strategy);
    const qualityFlags = readStringArray(output.quality_flags);
    const mem0Mode = source?.provider === "mem0" ? mem0ModeFromResult(result) ?? mem0ModeFromModel(result.model) : undefined;
    const base = {
      model: modelTrace(this.config.model, result.model),
      provider: source?.provider ?? "native",
      mem0_used: source?.mem0Used ?? false,
      mem0_attempted: source?.provider === "mem0" ? true : undefined,
      mem0_success: source?.provider === "mem0" ? true : undefined,
      mem0_attempted_mode: source?.provider === "mem0" ? mem0Mode : undefined,
      mem0_mode: mem0Mode,
      mem0_official_attempted: source?.provider === "mem0" ? mem0OfficialAttempted(result, mem0Mode) : undefined,
      mem0_official_success: source?.provider === "mem0" ? mem0OfficialSuccess(result, mem0Mode, true) : undefined,
      mem0_fallback_reason: source?.provider === "mem0" ? result.mem0_fallback_reason : undefined,
      mem0_strategy_version: source?.provider === "mem0" ? this.config.mem0StrategyVersion : undefined,
      strategy: strategy || undefined,
      operation,
      quality_flags: qualityFlags,
      schema_repair_applied: output.schema_repair_applied === true,
      transport_error: output.transport_error === true,
      fallback_used: result.fallback_used,
      fallback_reason: result.fallback_used ? fallbackReasonOf(result) : undefined,
    };

    if (!output.should_write) {
      return {
        ok: true,
        response: {
          ok: true,
          should_write: false,
          confidence,
          memories: [],
          ...base,
        },
      };
    }

    if (!Array.isArray(output.memories)) return { ok: false, reason: "schema_invalid" };
    const scopeType = request.scope_hint?.scope_type || "project";
    const scopeId = request.scope_hint?.scope_id || "default";
    const memories: ExtractedMemory[] = [];
    const qualityGates: ReturnType<typeof evaluateExtractionQuality>[] = [];
    for (const raw of output.memories as RawExtractionMemory[]) {
      if (!isPlainObject(raw)) return { ok: false, reason: "schema_invalid" };
      const canonical = readString(raw.canonical_content) || readString(raw.content);
      if (!canonical) return { ok: false, reason: "schema_invalid" };
      const qualityGate = evaluateExtractionQuality({
        inputText: request.text,
        canonicalContent: canonical,
      });
      qualityGates.push(qualityGate);
      const rawMemoryType = this.validateMemoryType(readString(raw.memory_type));
      const correction = deterministicTypeCorrection(rawMemoryType, request.text, canonical);
      const memoryType = correction.memoryType;
      const topic = (readString(raw.topic) || this.inferTopic(canonical)).toLowerCase();
      const title = readString(raw.title) || this.defaultTitle(memoryType, topic);
      const memoryOperation = this.validateOperation(readString(raw.operation), operation);
      memories.push({
        content: canonical,
        canonical_content: canonical,
        memory_type: memoryType,
        topic,
        title,
        confidence: readNumber(raw.confidence, confidence),
        dedupe_key: readString(raw.dedupe_key) || readString(raw.dedupeKey) || computeDedupeKey(scopeType, scopeId, memoryType, topic),
        scope_type: scopeType,
        scope_id: scopeId,
        conflict_action: this.operationToConflictAction(memoryOperation, memoryType),
        operation: memoryOperation,
        existing_memory_id: readString(raw.existing_memory_id) || undefined,
        conflict_reason: readString(raw.conflict_reason) || undefined,
        quality_gate: qualityGate,
        memory_class: readMemoryClass(raw.memory_class),
        evidence_span: readString(raw.evidence_span) || undefined,
        why_long_term: readString(raw.why_long_term) || undefined,
        temporal_validity: readString(raw.temporal_validity) || undefined,
        source_intent: readString(raw.source_intent) || undefined,
        memory_type_corrected_from: correction.correctedFrom,
        memory_type_correction_reason: correction.reason,
      });
    }

    const effectiveShouldWrite = memories.some((memory) => memory.conflict_action !== "skip");
    const combinedQualityGate = combineQualityGates(qualityGates);
    const combinedQualityFlags = [
      ...qualityFlags,
      ...(combinedQualityGate?.flags ?? []),
    ];
    const effectiveConfidence = combinedQualityGate
      ? Math.min(confidence, combinedQualityGate.score)
      : confidence;

    return {
      ok: true,
      response: {
        ok: true,
        should_write: effectiveShouldWrite,
        confidence: effectiveConfidence,
        memories,
        ...base,
        quality_gate: combinedQualityGate,
        quality_flags: combinedQualityFlags,
      },
    };
  }

  private failureResponse(result: LLMCallResult, reason: FailureReason): SmartExtractionResponse {
    return {
      ok: false,
      should_write: false,
      confidence: 0,
      memories: [],
      model: modelTrace(this.config.model, result.model || this.config.model),
      fallback_used: result.fallback_used,
      fallback_reason: result.fallback_used ? (fallbackReasonOf(result) ?? reason) : undefined,
      failure_reason: reason,
      error: result.error || reason,
    };
  }

  private async ensureGuardedWrite(
    response: SmartExtractionResponse,
    userPrompt: string,
    request: SmartExtractionRequest,
    guard: IntentGuard,
  ): Promise<SmartExtractionResponse> {
    if (!response.ok) return response;
    if (response.ok && response.should_write && response.memories.length > 0 && !this.hasWeakGuardedMemory(response, guard, request)) {
      return response;
    }

    if (this.hasFallbackConfigured()) {
      const fallback = await this.llmClient.callFallback(EXTRACTION_SYSTEM_PROMPT, userPrompt, "low_confidence");
      if (fallback.ok) {
        const normalized = this.normalizeParsed(fallback, request);
        if (
          normalized.response?.ok &&
          normalized.response.should_write &&
          normalized.response.memories.length > 0 &&
          !this.hasWeakGuardedMemory(normalized.response, guard, request)
        ) {
          return {
            ...normalized.response,
            provider: response.provider ?? normalized.response.provider,
            mem0_used: response.mem0_used ?? normalized.response.mem0_used,
            mem0_attempted: response.mem0_attempted ?? normalized.response.mem0_attempted,
            mem0_success: response.mem0_success ?? normalized.response.mem0_success,
            mem0_attempted_mode: response.mem0_attempted_mode ?? normalized.response.mem0_attempted_mode,
            mem0_mode: response.mem0_mode ?? normalized.response.mem0_mode,
            mem0_official_attempted: response.mem0_official_attempted ?? normalized.response.mem0_official_attempted,
            mem0_official_success: response.mem0_official_success ?? normalized.response.mem0_official_success,
            mem0_fallback_reason: response.mem0_fallback_reason,
            fallback_used: true,
            fallback_reason: response.fallback_reason ?? "low_confidence",
          };
        }
      }
    }

    return this.guardWriteResponse(request, guard, response);
  }

  private hasWeakGuardedMemory(response: SmartExtractionResponse, guard: IntentGuard, request: SmartExtractionRequest): boolean {
    const memory = response.memories[0];
    const canonical = memory?.canonical_content?.trim() ?? "";
    if (!canonical) return true;
    const lower = canonical.toLowerCase();
    if (/^(the user|user is|the text|text indicates|request for|remember the project|only text can be remembered)/i.test(canonical)) return true;
    const scopeId = request.scope_hint?.scope_id?.trim().toLowerCase();
    if (scopeId && lower.includes(scopeId) && !guard.canonical_seed.toLowerCase().includes(scopeId)) return true;
    if (canonical.length < Math.min(8, guard.canonical_seed.length)) return true;
    return false;
  }

  private guardSkipResponse(guard: IntentGuard): SmartExtractionResponse {
    return {
      ok: true,
      should_write: false,
      confidence: guard.reason === "negative_memory_intent" ? 0.98 : 0.9,
      memories: [],
      model: modelTrace(this.config.model, this.config.model),
      provider: this.config.provider,
      mem0_used: false,
      mem0_attempted: this.config.provider === "mem0" ? false : undefined,
      mem0_success: this.config.provider === "mem0" ? false : undefined,
      mem0_strategy_version: this.config.provider === "mem0" ? this.config.mem0StrategyVersion : undefined,
      strategy: "skip_guard",
      operation: "no_change",
      quality_flags: ["intent_guard_skip"],
      fallback_used: false,
    };
  }

  private guardWriteResponse(
    request: SmartExtractionRequest,
    guard: IntentGuard,
    previous: SmartExtractionResponse,
  ): SmartExtractionResponse {
    const scopeType = request.scope_hint?.scope_type || "project";
    const scopeId = request.scope_hint?.scope_id || "default";
    const canonical = cleanCanonicalSeed(guard.canonical_seed) || guard.canonical_seed;
    const qualityGate = evaluateExtractionQuality({ inputText: request.text, canonicalContent: canonical });
    const memoryType = this.inferMemoryType(request.text);
    const topic = this.inferTopic(canonical);
    const memory: ExtractedMemory = {
      content: canonical,
      canonical_content: canonical,
      memory_type: memoryType,
      topic,
      title: this.defaultTitle(memoryType, topic),
      confidence: 0.78,
      dedupe_key: computeDedupeKey(scopeType, scopeId, memoryType, topic),
      scope_type: scopeType,
      scope_id: scopeId,
      conflict_action: "create",
      operation: "add",
      quality_gate: qualityGate,
    };

    return {
      ok: true,
      should_write: true,
      confidence: Math.max(previous.confidence || 0, 0.78),
      memories: [memory],
      provider: previous.provider ?? this.config.provider,
      mem0_used: previous.mem0_used ?? false,
      mem0_attempted: previous.mem0_attempted,
      mem0_success: previous.mem0_success,
      mem0_attempted_mode: previous.mem0_attempted_mode,
      mem0_mode: previous.mem0_mode,
      mem0_official_attempted: previous.mem0_official_attempted,
      mem0_official_success: previous.mem0_official_success,
      mem0_fallback_reason: previous.mem0_fallback_reason,
      model: previous.model ?? modelTrace(this.config.model, this.config.model),
      mem0_strategy_version: previous.mem0_strategy_version,
      strategy: previous.strategy,
      operation: previous.operation ?? "add",
      quality_flags: previous.quality_flags,
      quality_gate: qualityGate,
      schema_repair_applied: previous.schema_repair_applied,
      fallback_used: previous.fallback_used,
      fallback_reason: previous.fallback_reason,
    };
  }

  private inferMemoryType(text: string): MemoryType {
    if (/必须|不能|不超过|至少|限制|must|never|limit/i.test(text)) return "constraint";
    if (/决定|决策|策略选择|默认仍保持|默认保持|先用|decision|decided/i.test(text)) return "decision";
    if (/我以后|我的偏好|偏好|优先|倾向|prefer|preference/i.test(text)) return "preference";
    if (/应该|should/i.test(text)) return "constraint";
    if (/步骤|流程|先.+再|最后|procedure|workflow|step/i.test(text)) return "procedure";
    return "fact";
  }

  private validateMemoryType(type: string): MemoryType {
    const valid: MemoryType[] = ["preference", "fact", "decision", "procedure", "constraint"];
    return valid.includes(type as MemoryType) ? (type as MemoryType) : "fact";
  }

  private validateConflictAction(action: string, fallback: ConflictAction): ConflictAction {
    const valid: ConflictAction[] = ["create", "merge", "supersede", "skip"];
    return valid.includes(action as ConflictAction) ? (action as ConflictAction) : fallback;
  }

  private validateOperation(operation: string, fallback: MemoryOperation): MemoryOperation {
    const normalized = operation.toLowerCase();
    const valid: MemoryOperation[] = ["add", "update", "merge", "no_change", "delete_candidate"];
    return valid.includes(normalized as MemoryOperation) ? (normalized as MemoryOperation) : fallback;
  }

  private validateFailureReason(reason: string, fallback: FailureReason): FailureReason {
    const valid: FailureReason[] = [
      "timeout",
      "network_error",
      "http_error",
      "llm_http_429",
      "llm_http_5xx",
      "parse_error",
      "schema_invalid",
      "empty_memory",
      "low_confidence",
      "fallback_config_missing",
      "mem0_error",
      "unknown",
    ];
    return valid.includes(reason as FailureReason) ? (reason as FailureReason) : fallback;
  }

  private operationToConflictAction(operation: MemoryOperation, memoryType: MemoryType): ConflictAction {
    if (operation === "no_change" || operation === "delete_candidate") return "skip";
    if (operation === "merge") return "merge";
    if (operation === "update") {
      return memoryType === "preference" || memoryType === "procedure" ? "merge" : "supersede";
    }
    return "create";
  }

  private inferTopic(content: string): string {
    return content.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "general";
  }

  private defaultTitle(type: MemoryType, topic: string): string {
    return type + ":" + topic;
  }

  private mergeContents(existing: string, next: string, allowLowOverlapSupersede: boolean): { action: ConflictAction; content: string; reason: string } {
    if (existing.includes(next)) return { action: "merge", content: existing, reason: "fallback_contains_new" };
    if (next.includes(existing)) return { action: "merge", content: next, reason: "fallback_contains_existing" };
    if (lexicalOverlap(existing, next) >= 0.65) {
      return { action: "merge", content: existing.trim() + "\n" + next.trim(), reason: "fallback_high_lexical_overlap" };
    }
    return allowLowOverlapSupersede
      ? { action: "supersede", content: next, reason: "fallback_low_overlap_supersede" }
      : { action: "merge", content: existing.trim() + "\n" + next.trim(), reason: "fallback_legacy_merge_no_llm" };
  }
}

function lexicalOverlap(left: string, right: string): number {
  const leftTerms = new Set(left.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((term) => term.length >= 2));
  const rightTerms = new Set(right.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((term) => term.length >= 2));
  if (leftTerms.size === 0 || rightTerms.size === 0) return 0;
  let shared = 0;
  for (const term of leftTerms) {
    if (rightTerms.has(term)) shared += 1;
  }
  return shared / Math.min(leftTerms.size, rightTerms.size);
}
