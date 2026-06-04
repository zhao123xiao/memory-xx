import type { IntelligenceConfig } from "./config";
import type { ConversationMessageInput, FailureReason, LLMCallResult, SmartExtractionRequest } from "./types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFailureReason(value: unknown, fallback: FailureReason): FailureReason {
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
  return typeof value === "string" && valid.includes(value as FailureReason) ? (value as FailureReason) : fallback;
}

export class Mem0ExtractionClient {
  constructor(private readonly config: IntelligenceConfig) {}

  async extract(request: SmartExtractionRequest): Promise<LLMCallResult> {
    if (this.config.mem0PreferOfficial) {
      const official = await this.extractOfficial(request);
      if (official.ok || !isOfficialRouteMissing(official)) {
        return official;
      }
      const legacy = await this.extractLegacy(request);
      return {
        ...legacy,
        mem0_official_attempted: true,
        mem0_official_success: false,
        mem0_fallback_reason: official.failure_reason ?? "http_error",
      };
    }
    return await this.extractLegacy(request);
  }

  private endpoint(path: string): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${this.config.mem0Url}${normalizedPath}`;
  }

  private messagesFor(request: SmartExtractionRequest): ConversationMessageInput[] {
    const messages = (request.messages ?? [])
      .filter((message) => message && typeof message.content === "string" && message.content.trim().length > 0)
      .map((message) => ({
        role: message.role,
        content: message.content.trim(),
        ...(message.created_at ? { created_at: message.created_at } : {}),
        ...(message.name ? { name: message.name } : {}),
      }));
    if (messages.length > 0) return messages;
    return [{ role: "user", content: request.text }];
  }

  private async extractOfficial(request: SmartExtractionRequest): Promise<LLMCallResult> {
    const started = Date.now();
    try {
      const response = await fetch(this.endpoint(this.config.mem0OfficialPath), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: this.messagesFor(request),
          infer: true,
          user_id: request.user_id || request.agent_id,
          agent_id: request.agent_id,
          metadata: {
            source: "memory-xx",
            workspace_id: request.workspace_id,
            scope_hint: request.scope_hint,
            existing_memories: request.existing_memories ?? [],
            mode: request.mode,
            strategy_version: this.config.mem0StrategyVersion,
            session_context: request.session_context,
            memory_xx_policy: memoryXXPolicyInstructions(),
          },
        }),
        signal: AbortSignal.timeout(this.config.primaryTimeoutMs),
      });
      return await this.parseResponse(response, started, "official");
    } catch (error) {
      return this.failureFromError(error, started, "official");
    }
  }

  private async extractLegacy(request: SmartExtractionRequest): Promise<LLMCallResult> {
    const started = Date.now();
    try {
      const response = await fetch(this.endpoint("/extract"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: request.text,
          agent_id: request.agent_id,
          user_id: request.user_id,
          workspace_id: request.workspace_id,
          scope_hint: request.scope_hint,
          existing_memories: request.existing_memories ?? [],
          mode: request.mode,
          strategy_version: this.config.mem0StrategyVersion,
          memory_xx_policy: memoryXXPolicyInstructions(),
        }),
        signal: AbortSignal.timeout(this.config.primaryTimeoutMs),
      });
      return await this.parseResponse(response, started, "legacy_extract");
    } catch (error) {
      return this.failureFromError(error, started, "legacy_extract");
    }
  }

  private async parseResponse(
    response: Response,
    started: number,
    mode: "official" | "legacy_extract",
  ): Promise<LLMCallResult> {
    const raw = await response.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const parsedReason = isPlainObject(parsed) ? parsed.failure_reason : undefined;
      const defaultReason: FailureReason = response.status === 429
        ? "llm_http_429"
        : response.status >= 500
          ? "llm_http_5xx"
          : "http_error";
      return {
        ok: false,
        raw,
        parsed,
        model: `mem0:${this.config.model}:${mode}`,
        latency_ms: Date.now() - started,
        fallback_used: false,
        failure_reason: parseFailureReason(parsedReason, defaultReason),
        mem0_attempted_mode: mode,
        mem0_official_attempted: mode === "official",
        mem0_official_success: false,
        error: isPlainObject(parsed) && typeof parsed.error === "string"
          ? parsed.error
          : `Mem0 extractor HTTP ${response.status}`,
      };
    }

    if (!parsed) {
      return {
        ok: false,
        raw,
        parsed: null,
        model: `mem0:${this.config.model}:${mode}`,
        latency_ms: Date.now() - started,
        fallback_used: false,
        failure_reason: "parse_error",
        mem0_attempted_mode: mode,
        mem0_official_attempted: mode === "official",
        mem0_official_success: false,
        error: "Mem0 抽取器返回内容无法解析",
      };
    }

    if (isPlainObject(parsed) && parsed.ok === false) {
      return {
        ok: false,
        raw,
        parsed,
        model: `mem0:${this.config.model}:${mode}`,
        latency_ms: Date.now() - started,
        fallback_used: false,
        failure_reason: parseFailureReason(parsed.failure_reason, "mem0_error"),
        mem0_attempted_mode: mode,
        mem0_official_attempted: mode === "official",
        mem0_official_success: false,
        error: typeof parsed.error === "string" ? parsed.error : "Mem0 extractor returned ok=false",
      };
    }

    return {
      ok: true,
      raw,
      parsed: mode === "official" ? normalizeOfficialMem0Response(parsed) : parsed,
      model: `mem0:${this.config.model}:${mode}`,
      latency_ms: Date.now() - started,
      fallback_used: false,
      mem0_attempted_mode: mode,
      mem0_official_attempted: mode === "official",
      mem0_official_success: mode === "official",
    };
  }

  private failureFromError(
    error: unknown,
    started: number,
    mode: "official" | "legacy_extract",
  ): LLMCallResult {
    const name = error instanceof Error ? error.name : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    const reason: FailureReason = name === "AbortError"
      ? "timeout"
      : /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(message)
        ? "network_error"
        : "mem0_error";
    return {
      ok: false,
      raw: "",
      parsed: null,
      model: `mem0:${this.config.model}:${mode}`,
      latency_ms: Date.now() - started,
      fallback_used: false,
      failure_reason: reason,
      mem0_attempted_mode: mode,
      mem0_official_attempted: mode === "official",
      mem0_official_success: false,
      error: message,
    };
  }
}

function isOfficialRouteMissing(result: LLMCallResult): boolean {
  if (result.failure_reason !== "http_error") return false;
  if (isPlainObject(result.parsed) && result.parsed.error === "not_found") return true;
  return /HTTP 404|not_found/i.test(result.error ?? "");
}

function normalizeOfficialMem0Response(parsed: unknown): unknown {
  if (!isPlainObject(parsed)) return parsed;
  if (typeof parsed.should_write === "boolean" && Array.isArray(parsed.memories)) return parsed;
  const rawMemories = Array.isArray(parsed.memories)
    ? parsed.memories
    : Array.isArray(parsed.results)
      ? parsed.results
      : Array.isArray(parsed.data)
        ? parsed.data
        : parsed.memory !== undefined
          ? [parsed.memory]
          : [];
  const memories = rawMemories
    .filter(isPlainObject)
    .map((memory) => ({
      canonical_content: memory.canonical_content ?? memory.memory ?? memory.content ?? memory.text ?? memory.fact,
      content: memory.content ?? memory.memory ?? memory.canonical_content ?? memory.text ?? memory.fact,
      memory_type: memory.memory_type ?? memory.type,
      topic: memory.topic,
      title: memory.title,
      confidence: memory.confidence ?? memory.score,
      operation: memory.operation ?? memory.event ?? memory.action,
      existing_memory_id: memory.existing_memory_id ?? memory.previous_memory_id,
      conflict_reason: memory.conflict_reason ?? memory.reason,
      dedupe_key: memory.dedupe_key ?? memory.id,
      memory_class: memory.memory_class,
      evidence_span: memory.evidence_span,
      why_long_term: memory.why_long_term,
      temporal_validity: memory.temporal_validity,
      source_intent: memory.source_intent,
    }));
  return {
    ok: parsed.ok !== false,
    should_write: typeof parsed.should_write === "boolean" ? parsed.should_write : memories.length > 0,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : memories.length > 0 ? 0.86 : 0.96,
    strategy: typeof parsed.strategy === "string" ? parsed.strategy : "mem0_official_add",
    operation: typeof parsed.operation === "string" ? parsed.operation : memories.length > 0 ? "add" : "no_change",
    quality_flags: Array.isArray(parsed.quality_flags) ? parsed.quality_flags : [],
    memories,
    schema_repair_applied: parsed.schema_repair_applied === true,
  };
}

export function memoryXXPolicyInstructions(): Record<string, unknown> {
  return {
    policy_version: "memory-policy-v1",
    extraction_role: "candidate_extraction_only_policy_engine_decides_storage",
    memory_classes: [
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
    ],
    storage_targets: ["postgres_memory", "redis_ttl", "event_log_only", "quarantine"],
    recall_policies: ["default", "explicit_only", "audit_only", "test_only", "never"],
    rules: [
      "Extract stable user preferences, constraints, decisions, procedures, and facts as long-term candidates.",
      "Mark real runtime bugs, authenticity problems, failed gates, and resolved fixes as operational_issue instead of ordinary facts.",
      "Mark benchmark, perf, smoke, hook, and validation-only samples as test_evidence unless the text describes a real production issue.",
      "Mark audit reports and review evidence as audit_evidence when they are useful only for governance review.",
      "Mark short acknowledgements, continuation markers, listener markers, and hook acceptance markers as runtime_noise.",
      "Mark reminders or short-lived actions as ephemeral_task; do not treat them as durable memory.",
      "Mark explicit do-not-remember requests as explicit_no_memory even if they mention a fact.",
    ],
    requested_fields: ["memory_class", "evidence_span", "why_long_term", "temporal_validity", "source_intent"],
  };
}
