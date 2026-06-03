import type { JsonObject } from "../shared";

export interface MemoryTypeInference {
  readonly memory_type: "preference" | "decision" | "constraint" | "procedure" | "fact" | "legacy_unknown";
  readonly confidence: number;
  readonly reason: string;
}

function textFromMetadata(metadata: JsonObject): string {
  const values = ["memory_type", "type", "category", "topic", "tags", "entity_names"]
    .map((key) => metadata[key])
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string");
  return values.join(" ");
}

export function inferLegacyMemoryType(input: {
  readonly title?: string | null;
  readonly content: string;
  readonly metadata?: JsonObject | null;
}): MemoryTypeInference {
  const text = `${input.title ?? ""}\n${input.content}\n${textFromMetadata(input.metadata ?? {})}`.toLowerCase();
  if (/(必须|不能|禁止|约束|规则|requirement|constraint|must not|must\b|forbidden|always|never)/u.test(text)) {
    return { memory_type: "constraint", confidence: 0.86, reason: "constraint_keywords" };
  }
  if (/(决定|决策|策略|默认|采用|选用|先用|decision|decided|strategy|default|choose|chosen)/u.test(text)) {
    return { memory_type: "decision", confidence: 0.84, reason: "decision_keywords" };
  }
  if (/(偏好|优先|倾向|喜欢|不喜欢|prefer|preference|favorite|style)/u.test(text)) {
    return { memory_type: "preference", confidence: 0.84, reason: "preference_keywords" };
  }
  if (/(步骤|流程|操作|先.*再|procedure|workflow|step|runbook|playbook)/u.test(text)) {
    return { memory_type: "procedure", confidence: 0.78, reason: "procedure_keywords" };
  }
  if (text.trim().length >= 20) {
    return { memory_type: "fact", confidence: 0.62, reason: "default_fact" };
  }
  return { memory_type: "legacy_unknown", confidence: 0.3, reason: "insufficient_signal" };
}

export type QdrantCollectionRole = "active" | "knowledge" | "archive_candidate" | "unknown";

export function classifyQdrantCollection(input: {
  readonly name: string;
  readonly activeCollections: readonly string[];
  readonly knowledgeCollections: readonly string[];
  readonly referencedCollections: readonly string[];
}): { readonly role: QdrantCollectionRole; readonly reason: string } {
  if (input.activeCollections.includes(input.name)) {
    return { role: "active", reason: "matches_active_collection_or_alias" };
  }
  if (input.knowledgeCollections.includes(input.name)) {
    return { role: "knowledge", reason: "matches_knowledge_collection" };
  }
  if (input.referencedCollections.includes(input.name)) {
    return { role: "archive_candidate", reason: "referenced_by_legacy_config_or_manifest" };
  }
  if (/^(openclaw_mem0|mem0|memory-xx($|-next)|memory-xx-local-)/u.test(input.name)) {
    return { role: "archive_candidate", reason: "legacy_memory_collection_name" };
  }
  return { role: "unknown", reason: "no_reference_found" };
}
