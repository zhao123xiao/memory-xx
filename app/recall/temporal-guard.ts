export type { TemporalQueryClassification } from "./temporal-types";
import {
  RECALLABLE_MEMORY_LAYERS,
  ALL_MEMORY_LAYERS,
  CURRENT_FACT_STATUSES,
  type MemoryLayer,
  type FactStatus
} from "../shared";
import type {
  TemporalScope,
  TemporalQueryClassification,
  TemporalFilterResult
} from "./temporal-types";
import type { CognitiveType, QueryType, RetrieverCandidate, RecallRecord } from "./types";

const ALL_FACT_STATUSES: readonly FactStatus[] = ["current", "historical", "deprecated", "resurrected"] as const;

const PROCEDURE_LAYERS: readonly MemoryLayer[] = ["procedural", "semantic", "recall", "episodic"] as const;
const PREFERENCE_LAYERS: readonly MemoryLayer[] = ["core", "semantic"] as const;
const EPISODIC_LAYERS: readonly MemoryLayer[] = ["episodic"] as const;
const TIMELINE_LAYERS: readonly MemoryLayer[] = ["episodic", "recall", "semantic", "procedural"] as const;
const PROJECT_CONTEXT_LAYERS: readonly MemoryLayer[] = ["core", "semantic", "procedural", "recall", "episodic"] as const;

function classifyTemporalScope(queryType: QueryType): TemporalScope {
  switch (queryType) {
    case "current_state_query":
    case "procedure_query":
    case "preference_query":
      return "current";
    case "historical_query":
    case "episode_lookup":
      return "historical";
    case "debug_audit_query":
      return "all";
    default:
      return "current";
  }
}

function classifyAllowedLayers(queryType: QueryType): readonly MemoryLayer[] {
  switch (queryType) {
    case "procedure_query":
      return PROCEDURE_LAYERS;
    case "timeline_history":
    case "historical_query":
      return TIMELINE_LAYERS;
    case "project_context":
      return PROJECT_CONTEXT_LAYERS;
    case "preference_query":
      return PREFERENCE_LAYERS;
    case "episode_lookup":
      return EPISODIC_LAYERS;
    case "debug_audit_query":
      return ALL_MEMORY_LAYERS;
    default:
      return RECALLABLE_MEMORY_LAYERS;
  }
}

function classifyAllowedFactStatuses(temporalScope: TemporalScope): readonly FactStatus[] {
  switch (temporalScope) {
    case "current":
      return CURRENT_FACT_STATUSES;
    case "historical":
      return ["current", "historical", "resurrected"] as const;
    case "all":
      return ALL_FACT_STATUSES;
  }
}

export function classifyTemporalQuery(queryType: QueryType): TemporalQueryClassification {
  const temporalScope = classifyTemporalScope(queryType);
  return {
    query_type: queryType,
    temporal_scope: temporalScope,
    allowed_layers: classifyAllowedLayers(queryType),
    allowed_fact_statuses: classifyAllowedFactStatuses(temporalScope),
    is_historical: temporalScope !== "current",
  };
}

export function applyTemporalFilter(
  candidates: readonly RetrieverCandidate[],
  classification: TemporalQueryClassification,
  options?: {
    override_temporal_scope?: TemporalScope;
    override_layers?: readonly MemoryLayer[];
    as_of?: string;
    explicit_memory_ids?: readonly string[];
  }
): TemporalFilterResult {
  const temporalScope = options?.override_temporal_scope ?? classification.temporal_scope;
  const allowedLayers = options?.override_layers ?? classification.allowed_layers;
  const allowedFactStatuses = classifyAllowedFactStatuses(temporalScope);
  const asOf = options?.as_of ? new Date(options.as_of) : new Date();

  const layerSet = new Set<string>(allowedLayers);
  const statusSet = new Set<string>(allowedFactStatuses);
  const explicitMemoryIds = new Set(options?.explicit_memory_ids ?? []);
  const filteredReasons: Record<string, number> = {};
  let explicitMemoryIdExemptions = 0;

  function reject(reason: string): boolean {
    filteredReasons[reason] = (filteredReasons[reason] ?? 0) + 1;
    return false;
  }

  function hasExactStructuralMatch(candidate: RetrieverCandidate): boolean {
    return candidate.why_matched.some(
      (reason) =>
        reason === "postgres_exact_title_match" ||
        reason === "postgres_exact_source_path_match" ||
        reason === "postgres_exact_source_basename_match" ||
        reason === "postgres_exact_section_match" ||
        reason === "exact_title_match_bonus" ||
        reason === "exact_memory_id_match_bonus" ||
        reason === "source_path_match_bonus" ||
        reason === "section_header_match_bonus" ||
        reason === "explicit_memory_id_match"
    );
  }

  function cognitiveTypeAllowed(cognitiveType: CognitiveType, exactStructuralMatch: boolean): boolean {
    if (exactStructuralMatch) return true;
    if (cognitiveType === "audit") {
      return temporalScope === "all";
    }
    if (cognitiveType === "episodic") {
      return classification.query_type === "timeline_history" ||
        classification.query_type === "historical_query" ||
        classification.query_type === "episode_lookup" ||
        classification.query_type === "project_context" ||
        classification.query_type === "procedure_query" ||
        classification.query_type === "debug_recall" ||
        classification.query_type === "debug_audit_query";
    }
    if (cognitiveType === "procedural") {
      return classification.query_type !== "preference_query";
    }
    return true;
  }

  const filtered = candidates.filter((candidate) => {
    const record = candidate.record as RecallRecord & {
      memory_layer?: string;
      fact_status?: string;
      valid_at?: string;
      invalid_at?: string;
      expires_at?: string;
      cognitive_type?: CognitiveType;
    };
    const layer = record.memory_layer ?? "recall";
    const status = record.fact_status ?? "current";
    const exactStructuralMatch = hasExactStructuralMatch(candidate);

    if (explicitMemoryIds.has(candidate.memory_id)) {
      explicitMemoryIdExemptions += 1;
      return true;
    }

    if (record.cognitive_type && !cognitiveTypeAllowed(record.cognitive_type, exactStructuralMatch)) {
      return reject("cognitive_type");
    }
    if (!layerSet.has(layer) && !exactStructuralMatch) return reject("memory_layer");
    if (!statusSet.has(status)) return reject("fact_status");

    if (temporalScope === "current") {
      if (record.valid_at && new Date(record.valid_at) > asOf) {
        return reject("valid_at_future");
      }
      if (record.invalid_at && new Date(record.invalid_at) <= asOf) {
        return reject("invalid_at_past");
      }
      if (record.expires_at && new Date(record.expires_at) <= asOf) {
        return reject("expires_at_past");
      }
    }

    return true;
  });

  return {
    filtered: filtered.map((c) => c.memory_id),
    total_before: candidates.length,
    total_after: filtered.length,
    applied_temporal_scope: temporalScope,
    applied_layers: allowedLayers,
    applied_fact_statuses: allowedFactStatuses,
    filtered_reasons: filteredReasons,
    ...(explicitMemoryIdExemptions > 0
      ? { explicit_memory_id_exemptions: explicitMemoryIdExemptions }
      : {}),
  };
}
