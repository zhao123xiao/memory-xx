import { createLogger } from "../shared/logger";

const log = createLogger("merge-engine");

export interface MergeCandidate {
  readonly memory_ids: readonly string[];
  readonly contents: readonly string[];
  readonly scope_type: string;
  readonly scope_id: string;
}

export interface MergeResult {
  readonly merged_content: string;
  readonly source_ids: readonly string[];
}

function normalizeFact(value: string): string {
  return value
    .trim()
    .replace(/^[-*]\s+/u, "")
    .replace(/\s+/g, " ")
    .replace(/[。]+$/u, ".")
    .replace(/[.;；。]+$/u, ".")
    .toLowerCase();
}

function splitContentIntoFacts(content: string): string[] {
  return content
    .split(/\r?\n|(?<=[。.!?？])\s+/u)
    .map((part) => part.trim().replace(/^[-*]\s+/u, ""))
    .filter(Boolean);
}

function normalizeDisplayFact(value: string): string {
  const trimmed = value.trim().replace(/^[-*]\s+/u, "").replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (/[。.!?？]$/u.test(trimmed)) {
    return trimmed;
  }
  return trimmed;
}

export function mergeContents(candidates: MergeCandidate): MergeResult {
  const seen = new Set<string>();
  const uniqueFacts: string[] = [];
  for (const content of candidates.contents) {
    for (const fact of splitContentIntoFacts(content)) {
      const normalized = normalizeFact(fact);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      uniqueFacts.push(normalizeDisplayFact(fact));
    }
  }
  if (uniqueFacts.length === 0) {
    return { merged_content: "", source_ids: candidates.memory_ids };
  }
  if (uniqueFacts.length === 1) {
    return { merged_content: uniqueFacts[0], source_ids: candidates.memory_ids };
  }
  const merged = [
    `Consolidated memory (${candidates.scope_type}:${candidates.scope_id})`,
    "",
    "Key points:",
    ...uniqueFacts.map((fact) => `- ${fact}`)
  ].join("\n");
  log.info("Merged memory contents", {
    scope_type: candidates.scope_type,
    scope_id: candidates.scope_id,
    source_count: candidates.memory_ids.length,
    fact_count: uniqueFacts.length
  });
  return { merged_content: merged, source_ids: candidates.memory_ids };
}
