import { FilterMode, ScopeType, type MemoryGovernanceFields } from "../shared";
import type { RecallCacheAudit } from "../cache/types";
import type { CognitiveType } from "../shared/cognitive-type";
import type { TemporalFilterResult } from "./temporal-types";
import type { RecallContextPagingContractAudit } from "./context-bundle";

export enum QueryType {
  ExactLookup = "exact_lookup",
  PreferenceLookup = "preference_lookup",
  DecisionLookup = "decision_lookup",
  ProjectContext = "project_context",
  TimelineHistory = "timeline_history",
  TodoCommitment = "todo_commitment",
  EntityProfile = "entity_profile",
  ExploratorySemantic = "exploratory_semantic",
  SourceAudit = "source_audit",
  DebugRecall = "debug_recall",
  CurrentStateQuery = "current_state_query",
  HistoricalQuery = "historical_query",
  ProcedureQuery = "procedure_query",
  PreferenceQuery = "preference_query",
  EpisodeLookup = "episode_lookup",
  DebugAuditQuery = "debug_audit_query"
}

export enum RetrievalStrategy {
  MetadataOnly = "metadata_only",
  LexicalOnly = "lexical_only",
  VectorOnly = "vector_only",
  Hybrid = "hybrid"
}

export interface RecallRuntimeContext {
  run_id?: string;
  task_id?: string;
  session_id?: string;
}

export interface RecallScopeContext {
  user_id?: string;
  project_ids?: string[];
  workspace_id?: string;
  include_global?: boolean;
  runtime?: RecallRuntimeContext;
  /** Exact memory IDs to recall — bypasses scope and semantic search when non-empty. */
  memory_ids?: readonly string[];
}

export interface RecallDebugOptions {
  enabled?: boolean;
  include_strategy_plan?: boolean;
  allow_privileged_filter_modes?: boolean;
  scope_context_source?: "caller_explicit" | "defaulted";
  default_scope_injected?: boolean;
}

export interface RecallRequest {
  query: string;
  scope_context: RecallScopeContext;
  filter_mode?: FilterMode;
  query_type_hint?: QueryType;
  debug?: RecallDebugOptions;
  explain?: boolean;
  limit?: number;
  offset?: number;
  rerank?: boolean;
  temporal_scope?: "current" | "historical" | "all";
  memory_layers?: readonly string[];
  session_id?: string;
  turn_id?: string;
  context_queries?: readonly string[];
  current_goal?: string;
  task_id?: string;
  scope_conflict_policy?: "more_specific_wins" | "higher_scope_wins" | "latest_wins";
  hybrid_mode?: "separate" | "rrf" | "model_rerank";
  include_knowledge?: boolean;
  knowledge_collections?: readonly string[];
  knowledge_repos?: readonly string[];
  knowledge_budget?: number;
  context_bundle?: false | "summary" | "full";
  context_bundle_budget?: RecallContextBundleBudget;
}

export interface RecallScopeRef {
  type: ScopeType;
  id: string;
}

export interface ResolvedScopeSet {
  long_term_scopes: RecallScopeRef[];
  runtime_scopes: RecallScopeRef[];
  allowed_scope_set: RecallScopeRef[];
  degraded: boolean;
  degrade_reasons: string[];
}

export interface QueryClassificationProfile {
  default_strategy: RetrievalStrategy;
  default_top_k: number;
  rerank_enabled: boolean;
  explain_detail: "basic" | "full";
}

export interface QueryClassification {
  query_type: QueryType;
  confidence: number;
  strategy_hint: RetrievalStrategy;
  top_k: number;
  rerank_enabled: boolean;
  explain_detail: "basic" | "full";
  reasons: string[];
  used_hint: boolean;
  strategy_weights?: StrategyWeights;
}

export interface StrategyWeights {
  lexical: number;
  vector: number;
  metadata: number;
  temporal: number;
  knowledge: number;
}

export interface RecallFilterPlan {
  requested_mode: FilterMode;
  applied_mode: FilterMode;
  predicate_id: string;
  expression: string;
  sql_where_clause: string;
  evaluate: (record: RecallRecord) => boolean;
}

export interface RecallMetadataConstraints {
  project_ids: string[];
  tags: string[];
  entity_names: string[];
  source_types: string[];
  years: number[];
  date_from?: string;
  date_to?: string;
}

export interface QueryConstraints {
  normalized_query: string;
  query_terms: string[];
  allowed_scope_set: RecallScopeRef[];
  scope_conflict_policy?: "more_specific_wins" | "higher_scope_wins" | "latest_wins";
  scope_precedence?: Record<string, number>;
  filter_plan: RecallFilterPlan;
  metadata: RecallMetadataConstraints;
  classification: QueryClassification;
  memory_ids?: readonly string[];
  limit: number;
  offset: number;
  force_model_rerank?: boolean;
  query_context?: RecallQueryContext;
}

export interface RecallQueryContext {
  original_query: string;
  expanded_query?: string;
  context_queries: readonly string[];
  current_goal?: string;
  task_id?: string;
  session_id?: string;
  turn_id?: string;
  expanded: boolean;
  token_cap: number;
  char_cap: number;
  terms: readonly string[];
}

export interface RecallSourceRef {
  path: string;
  source_type?: string;
}

export interface RecallRecord extends MemoryGovernanceFields {
  memory_id: string;
  title?: string;
  content: string;
  scope_type: ScopeType;
  scope_id: string;
  project_id?: string;
  workspace_id?: string;
  source?: RecallSourceRef;
  section?: string;
  canonical_section?: string;
  canonical_source_path?: string;
  category?: string;
  memory_type?: string;
  cognitive_type?: CognitiveType;
  memory_layer?: string;
  fact_status?: string;
  valid_at?: string;
  invalid_at?: string;
  observed_at?: string;
  expires_at?: string;
  episode_id?: string;
  importance?: number;
  memory_strength?: number;
  decay_policy?: string;
  relation_count?: number;
  tags?: string[];
  entity_names?: string[];
  created_at?: string;
  updated_at?: string;
  lexical_terms?: string[];
  semantic_terms?: string[];
}

export type { CognitiveType };

export interface GraphEntityEvidence {
  id: string;
  name: string;
  canonical_name?: string;
  entity_type?: string;
  match_reason: "entity_exact" | "entity_fuzzy" | "linked_entity";
}

export interface GraphRelationEvidence {
  id: string;
  relation_type: string;
  source_memory_id: string;
  target_memory_id: string;
  weight?: number;
  match_reason: "relation_type" | "relation_path" | "neighbor_path";
}

export interface GraphSourceEvidence {
  uri?: string;
  excerpt?: string;
  source_type?: string;
  confidence?: number;
  match_reason: "source_evidence";
}

export interface GraphPathSegment {
  from: string;
  to: string;
  relation_type: string;
  evidence?: string;
}

export interface RetrieverCandidate {
  memory_id: string;
  record: RecallRecord;
  score: number;
  rerank_score?: number;
  lexical_score?: number;
  vector_score?: number;
  graph_score?: number;
  lexical_rank?: number;
  vector_rank?: number;
  graph_rank?: number;
  graph_path?: string[];
  graph_entities?: string[];
  graph_relations?: string[];
  graph_evidence_sources?: string[];
  graph_path_score?: number;
  graph_rank_reason?: string;
  graph_entity_evidence?: GraphEntityEvidence[];
  graph_relation_evidence?: GraphRelationEvidence[];
  graph_source_evidence?: GraphSourceEvidence[];
  graph_path_evidence?: GraphPathSegment[];
  rrf_score?: number;
  local_score?: number;
  final_score?: number;
  metadata_bonus_raw?: number;
  metadata_bonus_capped?: number;
  recency_scope_bonus?: number;
  low_confidence?: boolean;
  matched_terms: string[];
  why_matched: string[];
  source_retrievers: string[];
  cluster_key?: string;
}

export interface BackendStatus {
  name: "lexical" | "vector";
  available: boolean;
  reason?: string;
  backend?: string;
  primary_backend?: string;
  fallback_backend?: string;
  fallback_available?: boolean;
  qdrant_configured?: boolean;
  last_probe_available?: boolean | null;
  timeout_ms?: number;
}

export interface RetrievalPlan {
  strategy: RetrievalStrategy;
  execute_lexical: boolean;
  execute_vector: boolean;
  degraded: boolean;
  degrade_reasons: string[];
  strategy_explain: string[];
  strategy_weights?: StrategyWeights;
  primary_strategy?: "lexical" | "vector" | "metadata" | "temporal" | "knowledge";
  secondary_strategy?: "lexical" | "vector" | "metadata" | "temporal" | "knowledge";
  fallback_retry_used?: boolean;
}

export type DegradeLevel = 0 | 1 | 2 | 3;

export interface RecallFusionAudit {
  method: "none" | "rrf";
  k: number;
  lexical_weight: number;
  vector_weight: number;
  graph_weight: number;
  graph_original_weight?: number;
  graph_weight_capped?: boolean;
  graph_weight_cap_reason?: string;
  lexical_candidates: number;
  vector_candidates: number;
  graph_candidates: number;
  merged_candidates: number;
}

export interface RecallExplainPayload {
  classification: QueryClassification;
  strategy?: RetrievalPlan;
  metadata: RecallMetadataConstraints;
  filter: {
    requested_mode: FilterMode;
    applied_mode: FilterMode;
    predicate_id: string;
    sql_where_clause: string;
  };
  retrieval: {
    lexical_hits: number;
    vector_hits: number;
    graph_hits?: number;
    knowledge_hits?: number;
    recent_approved_pg_fallback?: {
      readonly enabled: boolean;
      readonly window_ms: number;
      readonly candidate_cap: number;
      readonly candidate_count: number;
      readonly reason?: string;
    };
    merged_hits: number;
    returned_hits: number;
    rerank_applied: boolean;
    rerank_backend?: "disabled" | "local" | "model";
    rerank_used_model?: boolean;
    rerank_reason?: string;
    rerank_latency_ms?: number;
    confidence_gate?: RecallConfidenceGatePayload;
    fusion?: RecallFusionAudit;
  };
  cache?: RecallCacheAudit;
  embedding?: QueryEmbeddingAudit;
  degrade_level?: DegradeLevel;
  rerank_degraded?: boolean;
  fusion?: RecallFusionAudit;
  null_guard?: RecallConfidenceGatePayload;
  query_context?: RecallQueryContext;
  temporal?: {
    applied_temporal_scope: "current" | "historical" | "all";
    total_before: number;
    total_after: number;
    applied_layers: readonly string[];
    applied_fact_statuses: readonly string[];
    filtered_reasons?: Record<string, number>;
  };
}

export interface RecallConfidenceGatePayload {
  applied: boolean;
  reason: string;
  top_model_score?: number;
  threshold?: number;
  adaptive_override?: {
    readonly applied: boolean;
    readonly source: "governance_policy_override";
    readonly override_id?: string;
  };
  candidate_count?: number;
  absolute_filtered?: number;
  margin_cutoff_rank?: number;
  min_result_policy?: "strict_null" | "allow_low_confidence";
  null_returned?: boolean;
  low_confidence_returned?: boolean;
}

/**
 * Audit record for a single query embedding resolution.
 * Exposed only in the `explain` debug path — never leaks to external HTTP contract.
 */
export interface QueryEmbeddingAudit {
  /** True when a fresh (non-stale) cache entry was found and returned. */
  readonly fresh_cache_hit: boolean;
  /** True when a stale cache entry was returned after upstream failures. */
  readonly stale_cache_hit: boolean;
  /** Total number of upstream calls made (including retries). */
  readonly attempt_count: number;
  /** Final error message string if all attempts failed, undefined otherwise. */
  readonly final_error?: string;
  /** Machine-readable error classification code, e.g. "ECONNRESET", "UPSTREAM_NULL". */
  readonly error_code?: string;
  /** Cache backend that served the embedding, or the backend attempted before upstream. */
  readonly cache_backend?: "memory" | "redis" | "none";
  /** Redis cache operation status when Redis-backed query embedding cache is configured. */
  readonly redis_cache_status?: "hit" | "miss" | "stored" | "fallback" | "skipped";
  /** Redis cache degradation reason, present only when Redis is unavailable or malformed. */
  readonly redis_cache_error?: string;
}

export interface RecallAuditPayload {
  audit_ref: string;
  query_type: QueryType;
  strategy: RetrievalStrategy;
  degraded: boolean;
  degrade_level?: DegradeLevel;
  degrade_reasons: string[];
  rerank_degraded?: boolean;
  primary_backend?: "node" | "fastpath";
  fallback_used?: boolean;
  fallback_reason?: string;
  fastpath?: {
    attempted: boolean;
    used: boolean;
    reason?: string;
    scopes?: RecallScopeRef[];
    latency_ms?: number;
  };
  rerank?: {
    backend: "disabled" | "local" | "model";
    model_attempted: boolean;
    model_used: boolean;
    reason?: string;
    latency_ms?: number;
  };
  confidence_gate?: RecallConfidenceGatePayload;
  fusion?: RecallFusionAudit;
  null_guard?: RecallConfidenceGatePayload;
  query_context?: RecallQueryContext;
  temporal?: TemporalFilterResult;
  lexical_status: BackendStatus;
  vector_status: BackendStatus;
  lexical_hits: number;
  vector_hits: number;
  graph_hits?: number;
  knowledge?: {
    readonly included: boolean;
    readonly hits: number;
    readonly degraded?: boolean;
    readonly failure_reason?: string;
  };
  recent_approved_pg_fallback?: {
    readonly enabled: boolean;
    readonly window_ms: number;
    readonly candidate_cap: number;
    readonly candidate_count: number;
    readonly reason?: string;
  };
  graph_guard?: {
    readonly cap_weight?: number;
    readonly reason?: string;
  };
  merged_hits: number;
  returned_hits: number;
  session_cache_hit?: boolean;
  recent_cache_hit?: boolean;
  scope_conflict_policy?: "more_specific_wins" | "higher_scope_wins" | "latest_wins";
  scope_precedence?: Record<string, number>;
  scope_context_source?: "caller_explicit" | "defaulted";
  default_scope_injected?: boolean;
  adaptive_retrieval?: {
    readonly applied: false;
    readonly source: "runtime_observation_only";
    readonly query_type: QueryType;
    readonly scope_keys: readonly string[];
    readonly observed_returned_hits: number;
    readonly threshold_decision: {
      readonly action: "hold";
      readonly proposed_threshold_delta: "none";
      readonly sample_size_ok: false;
      readonly false_positive_guard_ok: true;
      readonly eligible_for_apply: false;
      readonly reason: "runtime_observation_not_calibration_cohort";
      readonly audit: {
        readonly sample_size: {
          readonly observed_traces: 1;
          readonly minimum_traces: number;
          readonly ok: false;
        };
        readonly feedback: {
          readonly feedback_count: 0;
          readonly negative_feedback_rate: 0;
          readonly false_positive_rate: 0;
          readonly guard_rate: number;
          readonly guard_ok: true;
        };
        readonly recall_pressure: {
          readonly empty_recall_rate: 0 | 1;
          readonly pressure_rate: number;
          readonly pressure_detected: boolean;
        };
        readonly guardrails: {
          readonly report_only: true;
        };
        readonly blockers: readonly ["report_only", "sample_size_below_minimum", "runtime_observation_only"];
      };
    };
  };
  context_bundle?: RecallContextBundleAudit;
  cache?: RecallCacheAudit;
}

export interface RecallResultItem {
  memory_id: string;
  title?: string;
  content: string;
  scope: RecallScopeRef;
  memory_type?: string;
  memory_layer?: string;
  recall_policy?: string | null;
  cognitive_type?: CognitiveType;
  score: number;
  rerank_score?: number;
  local_score?: number;
  final_score?: number;
  rrf_score?: number;
  graph_score?: number;
  graph_path_score?: number;
  graph_rank_reason?: string;
  graph_entities?: string[];
  graph_relations?: string[];
  graph_evidence_sources?: string[];
  graph_path?: string[];
  graph_entity_evidence?: GraphEntityEvidence[];
  graph_relation_evidence?: GraphRelationEvidence[];
  graph_source_evidence?: GraphSourceEvidence[];
  graph_path_evidence?: GraphPathSegment[];
  low_confidence?: boolean;
  source_retrievers: string[];
  source_path?: string;
  source_type?: string;
  matched_terms: string[];
}

export type RecallContextLayerId =
  | "l0_always_resident"
  | "l1_pinned_scope_facts"
  | "l2_query_working_set"
  | "l3_expandable_deep_memory";

export interface RecallContextBundleBudget {
  readonly l0AlwaysResident?: number;
  readonly l1PinnedScopeFacts?: number;
  readonly l2QueryWorkingSet?: number;
  readonly l3ExpandableDeepMemory?: number;
}

export interface RecallContextBundleTokenBudget {
  readonly total: number;
  readonly l0_always_resident: number;
  readonly l1_pinned_scope_facts: number;
  readonly l2_query_working_set: number;
  readonly l3_expandable_deep_memory: number;
}

export interface RecallContextBundleAudit {
  readonly requested_mode: false | "summary" | "full" | undefined;
  readonly mode: "disabled" | "summary" | "full";
  readonly requested_budgets: RecallContextBundleBudget;
  readonly applied_budgets: RecallContextBundleTokenBudget;
  readonly total_input_items: number;
  readonly resident_items: number;
  readonly expandable_items: number;
  readonly truncated_items: number;
  readonly redacted_items: number;
}

export interface RecallContextBundleItem {
  readonly memory_id: string;
  readonly title?: string;
  readonly content: string;
  readonly scope: RecallScopeRef;
  readonly score: number;
  readonly cognitive_type: CognitiveType;
  readonly memory_type?: string;
  readonly memory_layer?: string;
  readonly recall_policy?: string | null;
  readonly source_retrievers: readonly string[];
  readonly estimated_tokens: number;
  readonly resident: boolean;
  readonly inclusion_policy: "always" | "pinned" | "query_working_set" | "tool_expand_only";
  readonly temporal_chain?: {
    readonly relations: readonly GraphRelationEvidence[];
    readonly paths: readonly GraphPathSegment[];
    readonly relation_types: readonly string[];
  };
}

export interface RecallContextBundleLayer {
  readonly id: RecallContextLayerId;
  readonly label: string;
  readonly token_budget: number;
  readonly used_tokens: number;
  readonly resident: boolean;
  readonly invalidation_rules: readonly string[];
  readonly items: readonly RecallContextBundleItem[];
}

export interface RecallContextBundle {
  readonly version: "context-bundle-v1";
  readonly token_budget: RecallContextBundleTokenBudget;
  readonly layers: {
    readonly l0_always_resident: RecallContextBundleLayer;
    readonly l1_pinned_scope_facts: RecallContextBundleLayer;
    readonly l2_query_working_set: RecallContextBundleLayer;
    readonly l3_expandable_deep_memory: RecallContextBundleLayer;
  };
  readonly audit: {
    readonly total_input_items: number;
    readonly resident_items: number;
    readonly expandable_items: number;
    readonly truncated_items: number;
    readonly redacted_items?: number;
    readonly paging_contract?: RecallContextPagingContractAudit;
  };
}

export interface RecallContextPromptRender {
  readonly prompt: string;
  readonly expandable_references: string;
  readonly resident_memory_ids: readonly string[];
  readonly expandable_memory_ids: readonly string[];
  readonly audit: {
    readonly resident_items: number;
    readonly expandable_items: number;
    readonly prompt_chars: number;
    readonly expandable_reference_chars: number;
  };
}

export interface GateInfo {
  status: "accepted" | "empty" | "uncertain" | "degraded" | "scope_blocked" | "lifecycle_blocked";
  reason: string;
  filtered_count: number;
  original_count: number;
  top_score: number;
  thresholds: { empty_threshold: number; uncertain_gap: number };
}

export interface RecallResponse {
  results: RecallResultItem[];
  context_bundle?: RecallContextBundle;
  filter_mode_applied: FilterMode;
  allowed_scope_set: RecallScopeRef[];
  degraded: boolean;
  degrade_reason?: string;
  degrade_level?: DegradeLevel;
  audit_ref: string;
  audit: RecallAuditPayload;
  recall_trace_id?: string;
  fusion?: RecallFusionAudit;
  null_guard?: RecallConfidenceGatePayload;
  query_context?: RecallQueryContext;
  feedback_contract?: {
    expected_fields: readonly string[];
    validation_rules: readonly string[];
  };
  explain?: RecallExplainPayload;
}
