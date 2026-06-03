import type { QueryType, RecallRequest, RecallScopeRef } from "./types";
import type { MemoryLayer, FactStatus } from "../shared";

export type TemporalScope = "current" | "historical" | "all";

export interface TemporalRecallOptions {
  readonly temporal_scope?: TemporalScope;
  readonly memory_layers?: readonly MemoryLayer[];
  readonly valid_at_range?: { readonly from: string; readonly to: string };
}

export interface TemporalQueryClassification {
  readonly query_type: QueryType;
  readonly temporal_scope: TemporalScope;
  readonly allowed_layers: readonly MemoryLayer[];
  readonly allowed_fact_statuses: readonly FactStatus[];
  readonly is_historical: boolean;
}

export interface TemporalFilterResult {
  readonly filtered: readonly string[];
  readonly total_before: number;
  readonly total_after: number;
  readonly applied_temporal_scope: TemporalScope;
  readonly applied_layers: readonly MemoryLayer[];
  readonly applied_fact_statuses: readonly FactStatus[];
  readonly filtered_reasons: Readonly<Record<string, number>>;
}
