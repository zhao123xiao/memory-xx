import { RecallError, RecallErrorCode } from "../errors";
import { readRuntimeControlNumberSync } from "../../runtime-control-settings";
import {
  buildRecallSqlWhereClause,
  collectMatchedTerms,
  mapPostgresRecallRecord,
  PostgresRecallRetrieverBase,
  type PostgresRecallOptions
} from "./postgres-support";
import {
  type GraphEntityEvidence,
  type GraphPathSegment,
  type GraphRelationEvidence,
  type GraphSourceEvidence,
  type QueryConstraints,
  type RetrieverCandidate
} from "../types";

export interface GraphRetriever {
  retrieve(input: QueryConstraints): Promise<RetrieverCandidate[]>;
}

interface GraphRecallRow {
  readonly graph_score: number | string;
  readonly graph_relation_types: string[] | null;
  readonly graph_why: string[] | null;
  readonly graph_source_uris: string[] | null;
  readonly graph_text: string | null;
  readonly graph_rank_reason: string | null;
  readonly graph_entity_evidence: GraphEntityEvidence[] | string | null;
  readonly graph_relation_evidence: GraphRelationEvidence[] | string | null;
  readonly graph_source_evidence: GraphSourceEvidence[] | string | null;
  readonly graph_path_evidence: GraphPathSegment[] | string | null;
}

interface GraphCandidateIdRow {
  readonly id: string;
  readonly graph_score: number | string;
  readonly graph_text: string | null;
  readonly graph_rank_reason: string | null;
}

export interface GraphRetrieverRuntimeConfig {
  readonly timeoutMs: number;
}

function readPositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadGraphRetrieverRuntimeConfig(env: NodeJS.ProcessEnv = process.env): GraphRetrieverRuntimeConfig {
  const envTimeoutMs = readPositiveInt(env, "MEMORY_XX_GRAPH_RETRIEVER_TIMEOUT_MS", 2000);
  const runtimeTimeoutMs = readRuntimeControlNumberSync("recall.graph_retriever.timeout_ms", envTimeoutMs);
  return {
    timeoutMs: Number.isFinite(runtimeTimeoutMs) && runtimeTimeoutMs > 0
      ? Math.trunc(runtimeTimeoutMs)
      : envTimeoutMs
  };
}

function isStatementTimeout(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "57014"
  );
}

function wildcardTerms(terms: readonly string[]): string[] {
  return terms
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length >= 2)
    .map((term) => `%${term}%`);
}

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return [];
}

function graphEvidenceLimit(): number {
  const raw = process.env.MEMORY_XX_GRAPH_EVIDENCE_LIMIT?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : 20;
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("MEMORY_XX_GRAPH_EVIDENCE_LIMIT（图谱证据数量限制）必须在 1 到 100 之间。");
  }
  return parsed;
}

export class PostgresGraphRetriever extends PostgresRecallRetrieverBase implements GraphRetriever {
  constructor(options: PostgresRecallOptions) {
    super(options);
  }

  async retrieve(input: QueryConstraints): Promise<RetrieverCandidate[]> {
    const exactTerms = [...new Set([
      input.normalized_query,
      ...input.query_terms.map((term) => term.toLowerCase())
    ].filter((term) => term.length >= 2))];
    const likeTerms = wildcardTerms(exactTerms);
    if (exactTerms.length === 0 || likeTerms.length === 0) return [];
    const evidenceLimit = graphEvidenceLimit();
    const runtimeConfig = loadGraphRetrieverRuntimeConfig();

    try {
      return await this.withClient(async (client) => {
        await client.query("SELECT set_config('statement_timeout', $1, true)", [String(runtimeConfig.timeoutMs)]);
        const baseWhere = buildRecallSqlWhereClause({
          constraints: input,
          record_alias: "mr",
          source_alias: "src"
        });
        const exactIndex = baseWhere.next_parameter_index;
        const likeIndex = exactIndex + 1;
        const limitIndex = likeIndex + 1;
        const offsetIndex = limitIndex + 1;
        const candidateResult = await client.query(
          `
            WITH candidate_graph_ids AS (
              SELECT
                mr.id,
                concat_ws(' ', mr.title, mr.content, src.excerpt, entity_terms.text, relation_terms.text) AS graph_text,
                concat_ws(',',
                  CASE WHEN entity_stats.exact_count > 0 THEN 'entity_exact' END,
                  CASE WHEN text_stats.match_count > 0 THEN 'record_text' END,
                  CASE WHEN relation_stats.total_count > 0 THEN 'relation_path' END,
                  CASE WHEN src.excerpt IS NOT NULL THEN 'source_evidence' END
                ) AS graph_rank_reason,
                (
                  entity_stats.exact_count * 0.80
                  + entity_stats.fuzzy_count * 0.35
                  + text_stats.match_count * 0.28
                  + relation_stats.matched_count * 0.45
                  + relation_stats.total_count * 0.14
                  + CASE WHEN src.excerpt IS NOT NULL THEN 0.22 ELSE 0 END
                  + CASE WHEN entity_stats.exact_count > 0 THEN 0.45 ELSE 0 END
                )::real AS graph_score
              FROM memory_records mr
              LEFT JOIN LATERAL (
                SELECT ms.source_type, ms.uri, ms.excerpt, ms.confidence
                FROM memory_sources ms
                WHERE ms.memory_id = mr.id
                ORDER BY ms.confidence DESC NULLS LAST, ms.created_at ASC
                LIMIT 1
              ) AS src ON TRUE
              LEFT JOIN LATERAL (
                SELECT
                  count(DISTINCT e.id) AS total_count,
                  count(DISTINCT CASE
                    WHEN lower(e.name) = ANY($${exactIndex}::text[])
                      OR lower(COALESCE(e.canonical_name, '')) = ANY($${exactIndex}::text[])
                    THEN e.id END) AS exact_count,
                  count(DISTINCT CASE
                    WHEN lower(e.name) LIKE ANY($${likeIndex}::text[])
                      OR lower(COALESCE(e.canonical_name, '')) LIKE ANY($${likeIndex}::text[])
                    THEN e.id END) AS fuzzy_count,
                  count(DISTINCT CASE
                    WHEN lower(e.name) = ANY($${exactIndex}::text[])
                      OR lower(COALESCE(e.canonical_name, '')) = ANY($${exactIndex}::text[])
                      OR lower(e.name) LIKE ANY($${likeIndex}::text[])
                      OR lower(COALESCE(e.canonical_name, '')) LIKE ANY($${likeIndex}::text[])
                    THEN e.id END) AS match_count
                FROM memory_entity_links mel
                JOIN memory_entities e ON e.id = mel.entity_id
                WHERE mel.memory_id = mr.id
              ) AS entity_stats ON TRUE
              LEFT JOIN LATERAL (
                SELECT string_agg(DISTINCT e.name, ' ') AS text
                FROM memory_entity_links mel
                JOIN memory_entities e ON e.id = mel.entity_id
                WHERE mel.memory_id = mr.id
              ) AS entity_terms ON TRUE
              LEFT JOIN LATERAL (
                SELECT
                  count(DISTINCT rel.id) AS total_count,
                  count(DISTINCT CASE
                    WHEN lower(COALESCE(rel.relation_type, '')) = ANY($${exactIndex}::text[])
                      OR lower(COALESCE(rel.relation_type, '')) LIKE ANY($${likeIndex}::text[])
                    THEN rel.id END) AS matched_count
                FROM memory_relations rel
                WHERE rel.memory_id = mr.id OR rel.related_memory_id = mr.id
              ) AS relation_stats ON TRUE
              LEFT JOIN LATERAL (
                SELECT string_agg(DISTINCT rel.relation_type, ' ') AS text
                FROM memory_relations rel
                WHERE rel.memory_id = mr.id OR rel.related_memory_id = mr.id
              ) AS relation_terms ON TRUE
              LEFT JOIN LATERAL (
                SELECT count(*) AS match_count
                FROM unnest($${likeIndex}::text[]) AS term(value)
                WHERE lower(concat_ws(' ', mr.title, mr.summary, mr.content, src.excerpt, src.uri)) LIKE term.value
              ) AS text_stats ON TRUE
              WHERE ${baseWhere.sql}
                AND (entity_stats.total_count > 0 OR relation_stats.total_count > 0)
                AND (entity_stats.match_count > 0 OR relation_stats.matched_count > 0 OR text_stats.match_count > 0)
              ORDER BY graph_score DESC, mr.updated_at DESC
              LIMIT $${limitIndex}
              OFFSET $${offsetIndex}
            )
            SELECT id, graph_score, graph_text, graph_rank_reason
            FROM candidate_graph_ids
          `,
          [...baseWhere.params, exactTerms, likeTerms, input.limit, input.offset]
        );

        const candidateRows = candidateResult.rows as GraphCandidateIdRow[];
        if (candidateRows.length === 0) return [];
        const graphScoreById = new Map(candidateRows.map((row) => [String(row.id), row]));
        const candidateIds = candidateRows.map((row) => String(row.id));
        const hydrateIdsIndex = 1;
        const hydrateExactIndex = 2;
        const hydrateLikeIndex = 3;
        const hydrateEvidenceLimitIndex = 4;
        const result = await client.query(
          `
            SELECT
              mr.*,
              src.source_type,
              src.uri AS source_uri,
              src.excerpt AS source_excerpt,
              src.confidence AS source_confidence,
              COALESCE(rel_types.values, ARRAY[]::text[]) AS graph_relation_types,
              COALESCE(entity_names.values, ARRAY[]::text[]) AS graph_why,
              CASE WHEN src.uri IS NULL THEN ARRAY[]::text[] ELSE ARRAY[src.uri] END AS graph_source_uris,
              COALESCE(entity_evidence.items, '[]'::jsonb) AS graph_entity_evidence,
              COALESCE(relation_evidence.items, '[]'::jsonb) AS graph_relation_evidence,
              CASE
                WHEN src.uri IS NULL AND src.excerpt IS NULL THEN '[]'::jsonb
                ELSE jsonb_build_array(jsonb_build_object(
                  'uri', src.uri,
                  'excerpt', src.excerpt,
                  'source_type', src.source_type,
                  'confidence', src.confidence,
                  'match_reason', 'source_evidence'
                ))
              END AS graph_source_evidence,
              COALESCE(path_evidence.items, '[]'::jsonb) AS graph_path_evidence
            FROM memory_records mr
            JOIN unnest($${hydrateIdsIndex}::text[]) WITH ORDINALITY AS input_ids(id, ord)
              ON input_ids.id = mr.id
            LEFT JOIN LATERAL (
              SELECT ms.source_type, ms.uri, ms.excerpt, ms.confidence
              FROM memory_sources ms
              WHERE ms.memory_id = mr.id
              ORDER BY ms.confidence DESC NULLS LAST, ms.created_at ASC
              LIMIT 1
            ) AS src ON TRUE
            LEFT JOIN LATERAL (
              SELECT array_agg(item.name ORDER BY item.name) AS values
              FROM (
                SELECT DISTINCT e.name
                FROM memory_entity_links mel
                JOIN memory_entities e ON e.id = mel.entity_id
                WHERE mel.memory_id = mr.id
                ORDER BY e.name
                LIMIT $${hydrateEvidenceLimitIndex}
              ) item
            ) AS entity_names ON TRUE
            LEFT JOIN LATERAL (
              SELECT jsonb_agg(jsonb_build_object(
                'id', item.id::text,
                'name', item.name,
                'canonical_name', item.canonical_name,
                'entity_type', item.entity_type,
                'match_reason', item.match_reason
              )) AS items
              FROM (
                SELECT DISTINCT e.id, e.name, e.canonical_name, e.entity_type,
                  CASE
                    WHEN lower(e.name) = ANY($${hydrateExactIndex}::text[])
                      OR lower(COALESCE(e.canonical_name, '')) = ANY($${hydrateExactIndex}::text[])
                    THEN 'entity_exact'
                    WHEN lower(e.name) LIKE ANY($${hydrateLikeIndex}::text[])
                      OR lower(COALESCE(e.canonical_name, '')) LIKE ANY($${hydrateLikeIndex}::text[])
                    THEN 'entity_fuzzy'
                    ELSE 'linked_entity'
                  END AS match_reason
                FROM memory_entity_links mel
                JOIN memory_entities e ON e.id = mel.entity_id
                WHERE mel.memory_id = mr.id
                ORDER BY e.name
                LIMIT $${hydrateEvidenceLimitIndex}
              ) item
            ) AS entity_evidence ON TRUE
            LEFT JOIN LATERAL (
              SELECT array_agg(item.relation_type ORDER BY item.relation_type) AS values
              FROM (
                SELECT DISTINCT rel.relation_type
                FROM memory_relations rel
                WHERE rel.memory_id = mr.id OR rel.related_memory_id = mr.id
                ORDER BY rel.relation_type
                LIMIT $${hydrateEvidenceLimitIndex}
              ) item
            ) AS rel_types ON TRUE
            LEFT JOIN LATERAL (
              SELECT jsonb_agg(jsonb_build_object(
                'id', item.id,
                'relation_type', item.relation_type,
                'source_memory_id', item.memory_id,
                'target_memory_id', item.related_memory_id,
                'weight', item.weight,
                'match_reason', item.match_reason
              )) AS items
              FROM (
                SELECT DISTINCT rel.id, rel.relation_type, rel.memory_id, rel.related_memory_id, rel.weight,
                  CASE
                    WHEN lower(COALESCE(rel.relation_type, '')) = ANY($${hydrateExactIndex}::text[])
                      OR lower(COALESCE(rel.relation_type, '')) LIKE ANY($${hydrateLikeIndex}::text[])
                    THEN 'relation_type'
                    ELSE 'relation_path'
                  END AS match_reason
                FROM memory_relations rel
                WHERE rel.memory_id = mr.id OR rel.related_memory_id = mr.id
                ORDER BY rel.relation_type
                LIMIT $${hydrateEvidenceLimitIndex}
              ) item
            ) AS relation_evidence ON TRUE
            LEFT JOIN LATERAL (
              SELECT jsonb_agg(jsonb_build_object(
                'from', item.memory_id,
                'to', item.related_memory_id,
                'relation_type', COALESCE(item.relation_type, 'mentions'),
                'evidence', COALESCE(src.uri, item.relation_type)
              )) AS items
              FROM (
                SELECT DISTINCT rel.memory_id, rel.related_memory_id, rel.relation_type
                FROM memory_relations rel
                WHERE rel.memory_id = mr.id OR rel.related_memory_id = mr.id
                ORDER BY rel.relation_type
                LIMIT $${hydrateEvidenceLimitIndex}
              ) item
            ) AS path_evidence ON TRUE
            WHERE mr.id = ANY($${hydrateIdsIndex}::text[])
            ORDER BY input_ids.ord
          `,
          [candidateIds, exactTerms, likeTerms, evidenceLimit]
        );

        return result.rows.map((row: GraphRecallRow) => {
          const meta = graphScoreById.get(String((row as { id?: unknown }).id));
          const hydratedRow = meta
            ? {
                ...row,
                graph_score: meta.graph_score,
                graph_text: meta.graph_text,
                graph_rank_reason: meta.graph_rank_reason
              }
            : row;
          const record = mapPostgresRecallRecord(hydratedRow);
          const score = Number(hydratedRow.graph_score) || 0;
          const relationTypes = hydratedRow.graph_relation_types ?? [];
          const entities = hydratedRow.graph_why ?? [];
          const evidenceSources = hydratedRow.graph_source_uris ?? [];
          const entityEvidence = jsonArray<GraphEntityEvidence>(hydratedRow.graph_entity_evidence).slice(0, evidenceLimit);
          const relationEvidence = jsonArray<GraphRelationEvidence>(hydratedRow.graph_relation_evidence).slice(0, evidenceLimit);
          const sourceEvidence = jsonArray<GraphSourceEvidence>(hydratedRow.graph_source_evidence).slice(0, evidenceLimit);
          const pathEvidence = jsonArray<GraphPathSegment>(hydratedRow.graph_path_evidence).slice(0, evidenceLimit);
          const rankReason = hydratedRow.graph_rank_reason ?? "";
          return {
            memory_id: record.memory_id,
            record,
            score,
            graph_score: score,
            graph_path_score: score,
            graph_entities: entities,
            graph_relations: relationTypes,
            graph_evidence_sources: evidenceSources,
            graph_rank_reason: rankReason,
            graph_entity_evidence: entityEvidence,
            graph_relation_evidence: relationEvidence,
            graph_source_evidence: sourceEvidence,
            graph_path_evidence: pathEvidence,
            graph_path: [
              ...entities.slice(0, 3),
              ...relationTypes.slice(0, 3),
              record.memory_id
            ],
            matched_terms: collectMatchedTerms(hydratedRow.graph_text ?? "", input.query_terms),
            why_matched: [
              entities.length > 0 ? `graph_entities:${entities.slice(0, 5).join(",")}` : "graph_entity_match",
              relationTypes.length > 0 ? `graph_relations:${relationTypes.slice(0, 5).join(",")}` : "",
              evidenceSources.length > 0 ? `graph_evidence_sources:${evidenceSources.slice(0, 3).join(",")}` : "",
              entityEvidence.length > 0 ? `graph_entity_evidence:${entityEvidence.slice(0, 3).map((item) => `${item.name}:${item.match_reason}`).join(",")}` : "",
              relationEvidence.length > 0 ? `graph_relation_evidence:${relationEvidence.slice(0, 3).map((item) => `${item.relation_type}:${item.match_reason}`).join(",")}` : "",
              rankReason ? `graph_rank:${rankReason}` : ""
            ].filter(Boolean),
            source_retrievers: ["graph"],
            cluster_key: `graph:${record.memory_id}`
          };
        });
      });
    } catch (error) {
      if (error instanceof RecallError) throw error;
      if (isStatementTimeout(error)) {
        throw new RecallError(
          RecallErrorCode.BackendTimeout,
          "PostgreSQL graph retrieval timed out.",
          { timeout_ms: runtimeConfig.timeoutMs }
        );
      }
      throw new RecallError(
        RecallErrorCode.BackendUnavailable,
        error instanceof Error ? error.message : "PostgreSQL graph retrieval failed."
      );
    }
  }
}
