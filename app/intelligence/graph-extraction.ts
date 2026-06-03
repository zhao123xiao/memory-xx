import type { JsonObject } from "../shared";

export interface ExtractedGraphRelation {
  readonly relation_type: string;
  readonly source: string;
  readonly target: string;
  readonly confidence: number;
  readonly evidence: string;
}

export interface ExtractedGraphHints {
  readonly entity_names: string[];
  readonly relations: ExtractedGraphRelation[];
}

const STOPWORDS = new Set([
  "memory",
  "remember",
  "write",
  "recall",
  "current",
  "default",
  "project",
  "workspace",
  "以后",
  "记住",
  "记一下",
  "控制面板",
]);

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function entityCandidates(text: string): string[] {
  const latin = text.match(/\b[A-Z][A-Za-z0-9_-]{2,}\b|\b[a-z]+(?:-[a-z0-9]+)+\b|\b(?:mem0|memory-xx|Qdrant|OVMS|Codex|reranker|fastpath|PostgreSQL|Qwen3)\b/giu) ?? [];
  const chinese = text.match(/[\u4e00-\u9fa5A-Za-z0-9_-]{2,24}(?:模型|图谱|控制面板|召回|写入|审批|记忆|服务|框架|策略|语料库|清单|投影|开关|关系|实体)/gu) ?? [];
  return unique([...latin, ...chinese])
    .filter((item) => !STOPWORDS.has(item.toLowerCase()))
    .slice(0, 12);
}

function relationCandidates(text: string, entities: readonly string[]): ExtractedGraphRelation[] {
  if (entities.length < 2) return [];
  const relations: ExtractedGraphRelation[] = [];
  const patterns: Array<{ type: string; regex: RegExp }> = [
    { type: "depends_on", regex: /(?:依赖|depends on|需要|requires)/iu },
    { type: "uses", regex: /(?:使用|uses|通过|基于)/iu },
    { type: "fixes", regex: /(?:修复|解决|fixes|resolves)/iu },
    { type: "tests", regex: /(?:测试|验证|benchmark|gate)/iu },
  ];
  for (const pattern of patterns) {
    if (!pattern.regex.test(text)) continue;
    relations.push({
      relation_type: pattern.type,
      source: entities[0]!,
      target: entities[1]!,
      confidence: 0.72,
      evidence: text.slice(0, 280),
    });
  }
  return relations.slice(0, 4);
}

export function extractGraphHints(text: string): ExtractedGraphHints {
  const entity_names = entityCandidates(text);
  return {
    entity_names,
    relations: relationCandidates(text, entity_names),
  };
}

function graphRelationMetadata(relation: ExtractedGraphRelation): JsonObject {
  return {
    relation_type: relation.relation_type,
    source: relation.source,
    target: relation.target,
    confidence: relation.confidence,
    evidence: relation.evidence,
  };
}

export function graphHintsMetadata(text: string): JsonObject {
  const hints = extractGraphHints(text);
  return {
    entity_names: hints.entity_names,
    relation_count: hints.relations.length,
    graph_extraction: {
      version: "deterministic-v1",
      confidence_policy: "metadata_only_for_relations",
      relations: hints.relations.map(graphRelationMetadata),
    } as JsonObject,
  };
}
