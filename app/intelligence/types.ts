export type MemoryType = "preference" | "fact" | "decision" | "procedure" | "constraint";
export type ExtractionMode = "draft" | "write" | "auto_approve";
export type ConflictAction = "create" | "merge" | "supersede" | "skip";
export type MemoryOperation = "add" | "update" | "merge" | "no_change" | "delete_candidate";
export type ExtractedMemoryClass =
  | "long_term_fact"
  | "preference"
  | "constraint"
  | "decision"
  | "procedure"
  | "operational_issue"
  | "test_evidence"
  | "audit_evidence"
  | "runtime_noise"
  | "ephemeral_task"
  | "explicit_no_memory"
  | "unknown_source_quarantine";
export type FailureReason =
  | "timeout"
  | "network_error"
  | "http_error"
  | "llm_http_429"
  | "llm_http_5xx"
  | "parse_error"
  | "schema_invalid"
  | "empty_memory"
  | "low_confidence"
  | "fallback_config_missing"
  | "circuit_open"
  | "mem0_error"
  | "unknown";

export interface SessionContextInput {
  readonly session_id?: string;
  readonly turn_id?: string;
  readonly run_id?: string;
  readonly contextual_followup?: boolean;
  readonly anchor_id?: string;
}

export interface ConversationMessageInput {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly created_at?: string;
  readonly name?: string;
}

export interface QualityGateResult {
  readonly score: number;
  readonly passed: boolean;
  readonly action: "continue" | "candidate_pending" | "buffer";
  readonly flags: readonly string[];
  readonly penalties: {
    readonly meta_phrase: number;
    readonly length_ratio: number;
    readonly expansion_risk: number;
  };
  readonly length_ratio: number;
  readonly boundary: "short" | "normal" | "long";
}

export interface SmartExtractionRequest {
  text: string;
  agent_id: string;
  user_id?: string;
  workspace_id?: string;
  scope_hint?: { scope_type: string; scope_id: string };
  existing_memories?: ExistingMemoryForConflict[];
  messages?: readonly ConversationMessageInput[];
  session_context?: SessionContextInput;
  mode: ExtractionMode;
}

export interface ExtractedMemory {
  content: string;
  canonical_content: string;
  memory_type: MemoryType;
  topic: string;
  title: string;
  confidence: number;
  dedupe_key: string;
  scope_type: string;
  scope_id: string;
  conflict_action: ConflictAction;
  operation?: MemoryOperation;
  existing_memory_id?: string;
  conflict_reason?: string;
  quality_gate?: QualityGateResult;
  memory_class?: ExtractedMemoryClass;
  evidence_span?: string;
  why_long_term?: string;
  temporal_validity?: string;
  source_intent?: string;
  memory_type_corrected_from?: MemoryType;
  memory_type_correction_reason?: string;
  coalesced_from_count?: number;
  coalesced_candidate_titles?: readonly string[];
  coalesced_candidate_contents?: readonly string[];
}

export interface IntelligenceModelTrace {
  primary: string;
  final: string;
}

export interface SmartExtractionResponse {
  ok: boolean;
  should_write: boolean;
  confidence: number;
  memories: ExtractedMemory[];
  model: IntelligenceModelTrace;
  provider?: "native" | "mem0";
  mem0_used?: boolean;
  mem0_mode?: "official" | "legacy_extract";
  mem0_attempted?: boolean;
  mem0_success?: boolean;
  mem0_attempted_mode?: "official" | "legacy_extract";
  mem0_official_attempted?: boolean;
  mem0_official_success?: boolean;
  mem0_fallback_reason?: FailureReason;
  mem0_strategy_version?: string;
  strategy?: string;
  operation?: MemoryOperation;
  quality_flags?: string[];
  quality_gate?: QualityGateResult;
  schema_repair_applied?: boolean;
  transport_error?: boolean;
  native_shadow_disagreement?: boolean;
  fallback_used: boolean;
  fallback_reason?: FailureReason;
  failure_reason?: FailureReason;
  error?: string;
}

export interface LLMCallResult {
  ok: boolean;
  raw: string;
  parsed: unknown;
  model: string;
  latency_ms: number;
  fallback_used: boolean;
  fallback_reason?: FailureReason;
  failure_reason?: FailureReason;
  error?: string;
  mem0_attempted_mode?: "official" | "legacy_extract";
  mem0_official_attempted?: boolean;
  mem0_official_success?: boolean;
  mem0_fallback_reason?: FailureReason;
}

export interface ConflictResult {
  action: ConflictAction;
  existing_memory_id?: string;
  merged_content?: string;
  reason: string;
}

export interface ExistingMemoryForConflict {
  id: string;
  content: string;
  title?: string | null;
  memory_type?: string | null;
  topic?: string | null;
}
