/**
 * Memory Relation Types
 *
 * Type definitions for memory-to-memory relations in the knowledge graph.
 * Based on memory-xx governance module.
 */

export const TEMPORAL_MEMORY_RELATION_TYPES = [
  "supports",
  "contradicts",
  "supersedes",
  "caused_by",
  "same_issue_as",
  "derived_procedure_from",
] as const;

export type TemporalMemoryRelationType = (typeof TEMPORAL_MEMORY_RELATION_TYPES)[number];

export const GENERAL_MEMORY_RELATION_TYPES = [
  "depends_on",
  "uses",
  "fixes",
  "tests",
  "refines",
  "derived_from",
  "mentions",
] as const;

export type GeneralMemoryRelationType = (typeof GENERAL_MEMORY_RELATION_TYPES)[number];

export type MemoryRelationType = TemporalMemoryRelationType | GeneralMemoryRelationType;

const TEMPORAL_RELATION_SET = new Set<string>(TEMPORAL_MEMORY_RELATION_TYPES);
const GENERAL_RELATION_SET = new Set<string>(GENERAL_MEMORY_RELATION_TYPES);

const RELATION_ALIASES: Readonly<Record<string, MemoryRelationType>> = {
  conflict: "contradicts",
  conflicts: "contradicts",
  conflicts_with: "contradicts",
  contradicted_by: "contradicts",
  superseded_by: "supersedes",
  replaces: "supersedes",
  replaced_by: "supersedes",
  caused: "caused_by",
  same_issue: "same_issue_as",
  same_as: "same_issue_as",
  same_as_issue: "same_issue_as",
  derived_from_procedure: "derived_procedure_from",
  derived_from: "derived_procedure_from",
};

export function normalizeMemoryRelationType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return RELATION_ALIASES[normalized] ?? normalized;
}

export function isTemporalMemoryRelationType(value: string): value is TemporalMemoryRelationType {
  return TEMPORAL_RELATION_SET.has(normalizeMemoryRelationType(value));
}

export function isKnownMemoryRelationType(value: string): value is MemoryRelationType {
  const normalized = normalizeMemoryRelationType(value);
  return TEMPORAL_RELATION_SET.has(normalized) || GENERAL_RELATION_SET.has(normalized);
}