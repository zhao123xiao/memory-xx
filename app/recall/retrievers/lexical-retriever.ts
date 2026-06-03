import { RecallError, RecallErrorCode } from "../errors";
import { matchesMetadataConstraints } from "../metadata-filter-builder";
import { buildRetrievalQueryPolicy } from "../retrieval-query-policy";
import {
  type BackendStatus,
  type QueryConstraints,
  type RecallRecord,
  type RetrieverCandidate
} from "../types";
import {
  PostgresRecallRetrieverBase,
  buildCanonicalSourcePathSql,
  buildLexicalSearchDocumentSql,
  buildRecallSqlWhereClause,
  collectMatchedTerms,
  mapPostgresRecallRecord,
  type PostgresRecallOptions
} from "./postgres-support";

export interface LexicalRetriever {
  get_backend_status(): Promise<BackendStatus> | BackendStatus;
  retrieve(input: QueryConstraints): Promise<RetrieverCandidate[]>;
}

function matchesScope(record: RecallRecord, allowedScopeKeys: Set<string>): boolean {
  return allowedScopeKeys.has(`${record.scope_type}:${record.scope_id}`);
}

function toSearchableText(record: RecallRecord): string {
  return [
    record.title,
    record.content,
    record.source?.path,
    record.source?.source_type,
    ...(record.tags ?? []),
    ...(record.entity_names ?? []),
    ...(record.lexical_terms ?? [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export class StubLexicalRetriever implements LexicalRetriever {
  private readonly records: RecallRecord[];
  private readonly simulateFailure?: "timeout" | "unavailable";

  constructor(input?: {
    records?: RecallRecord[];
    simulate_failure?: "timeout" | "unavailable";
  }) {
    this.records = input?.records ?? [];
    this.simulateFailure = input?.simulate_failure;
  }

  get_backend_status(): BackendStatus {
    if (this.simulateFailure === "timeout") {
      return {
        name: "lexical",
        available: false,
        reason: "lexical_backend_timeout"
      };
    }

    if (this.simulateFailure === "unavailable") {
      return {
        name: "lexical",
        available: false,
        reason: "lexical_backend_unavailable"
      };
    }

    return { name: "lexical", available: true };
  }

  async retrieve(input: QueryConstraints): Promise<RetrieverCandidate[]> {
    if (this.simulateFailure === "timeout") {
      throw new RecallError(
        RecallErrorCode.BackendTimeout,
        "lexical backend timed out"
      );
    }

    if (this.simulateFailure === "unavailable") {
      throw new RecallError(
        RecallErrorCode.BackendUnavailable,
        "lexical backend is unavailable"
      );
    }

    const scopeKeys = new Set(
      input.allowed_scope_set.map((scope) => `${scope.type}:${scope.id}`)
    );
    const explicitIds = new Set(input.memory_ids ?? []);

    return this.records
      .filter((record) => matchesScope(record, scopeKeys))
      .filter((record) => input.filter_plan.evaluate(record))
      .filter((record) => matchesMetadataConstraints(record, input.metadata))
      .filter((record) => explicitIds.size === 0 || explicitIds.has(record.memory_id))
      .map((record) => {
        const searchableText = toSearchableText(record);
        const matchedTerms = input.query_terms.filter((term) =>
          searchableText.includes(term)
        );
        const explicitMatch = explicitIds.has(record.memory_id);
        const lexicalScore = explicitMatch
          ? 10
          : matchedTerms.length / Math.max(input.query_terms.length, 1);
        return {
          memory_id: record.memory_id,
          record,
          score: lexicalScore,
          lexical_score: lexicalScore,
          matched_terms: matchedTerms,
          why_matched:
            explicitMatch
              ? ["explicit_memory_id_match"]
              : matchedTerms.length > 0
              ? [`matched lexical terms: ${matchedTerms.join(", ")}`]
              : ["passed scope/filter/metadata constraints"],
          source_retrievers: ["lexical"]
        };
      })
      .filter(
        (candidate) =>
          candidate.lexical_score !== undefined && candidate.lexical_score > 0
      )
      .sort((left, right) => right.score - left.score)
      .slice(input.offset, input.offset + input.limit);
  }
}

interface PostgresLexicalRow {
  readonly searchable_text: string;
  readonly fts_rank: number;
  readonly ilike_match: boolean;
  readonly ilike_match_count: number;
  readonly fts_match: boolean;
  readonly exact_title_match: boolean;
  readonly exact_source_path_match: boolean;
  readonly exact_source_basename_match: boolean;
  readonly exact_section_match: boolean;
}

function buildComparableSql(expr: string): string {
  return `trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(COALESCE(${expr}, '')), '[“”‘’''"` + "`" + `]', '', 'g'), '[._/\\:-]+', ' ', 'g'), '[()\\[\\]{}（）【】]+', ' ', 'g'), '\\s+', ' ', 'g'))`;
}

export class PostgresLexicalRetriever
  extends PostgresRecallRetrieverBase
  implements LexicalRetriever
{
  constructor(options: PostgresRecallOptions) {
    super(options);
  }

  async get_backend_status(): Promise<BackendStatus> {
    const available = await this.canReachDatabase();
    return {
      name: "lexical",
      available,
      reason: available ? undefined : "lexical_backend_unavailable"
    };
  }

  async retrieve(input: QueryConstraints): Promise<RetrieverCandidate[]> {
    if (input.memory_ids && input.memory_ids.length > 0) {
      return await this.retrieveExplicitMemoryIds(input);
    }

    const retrievalPolicy = buildRetrievalQueryPolicy(input);
    const likePatterns = retrievalPolicy.allow_ilike_fallback
      ? [...retrievalPolicy.ilike_patterns]
      : [];
    const exactTitleQueries = [...retrievalPolicy.exact_title_queries];
    const exactSectionQueries = [...retrievalPolicy.exact_section_queries];
    const exactSourcePathQueries = [...retrievalPolicy.exact_source_path_queries];
    const exactSourceBasenameQueries = [
      ...retrievalPolicy.exact_source_basename_queries
    ];

    try {
      return await this.withClient(async (client) => {
        const baseWhere = buildRecallSqlWhereClause({
          constraints: input,
          record_alias: "mr",
          source_alias: "src"
        });
        const queryTextIndex = baseWhere.next_parameter_index;
        const exactTitleIndex = queryTextIndex + 1;
        const exactSectionIndex = exactTitleIndex + 1;
        const exactSourcePathIndex = exactSectionIndex + 1;
        const exactSourceBasenameIndex = exactSourcePathIndex + 1;
        const allowIlikeIndex = exactSourceBasenameIndex + 1;
        const likePatternsIndex = allowIlikeIndex + 1;
        const limitIndex = likePatternsIndex + 1;
        const offsetIndex = limitIndex + 1;
        const searchDocument = buildLexicalSearchDocumentSql("mr", "src");
        const canonicalSourcePath = buildCanonicalSourcePathSql("mr", "src");
        const normalizedTitleSql = buildComparableSql("mr.title");
        const normalizedSectionSql = buildComparableSql(`COALESCE(
          mr.metadata ->> 'section',
          mr.metadata ->> 'section_path',
          mr.metadata ->> 'sectionPath',
          mr.metadata -> 'legacy' ->> 'section',
          mr.metadata -> 'legacy' ->> 'canonical_section',
          ''
        )`);

        const result = await client.query<PostgresLexicalRow>(
          `
            WITH candidate_records AS (
              SELECT
                mr.*,
                src.source_type,
                src.uri AS source_uri,
                src.excerpt AS source_excerpt,
                lower(${searchDocument}) AS searchable_text,
                to_tsvector('simple', ${searchDocument}) AS search_vector,
                ${normalizedTitleSql} AS normalized_title,
                ${normalizedSectionSql} AS normalized_section,
                lower(trim(${canonicalSourcePath})) AS normalized_source_uri,
                regexp_replace(lower(trim(${canonicalSourcePath})), '^.*/', '') AS normalized_source_basename
              FROM memory_records mr
              LEFT JOIN LATERAL (
                SELECT
                  ms.source_type,
                  ms.uri,
                  ms.excerpt
                FROM memory_sources ms
                WHERE ms.memory_id = mr.id
                ORDER BY ms.confidence DESC NULLS LAST, ms.created_at ASC
                LIMIT 1
              ) AS src ON TRUE
              WHERE ${baseWhere.sql}
            )
            SELECT
              *,
              normalized_title = ANY($${exactTitleIndex}::text[]) AS exact_title_match,
              normalized_section = ANY($${exactSectionIndex}::text[]) AS exact_section_match,
              normalized_source_uri = ANY($${exactSourcePathIndex}::text[]) AS exact_source_path_match,
              normalized_source_basename = ANY($${exactSourceBasenameIndex}::text[]) AS exact_source_basename_match,
              ts_rank_cd(search_vector, websearch_to_tsquery('simple', $${queryTextIndex})) AS fts_rank,
              search_vector @@ websearch_to_tsquery('simple', $${queryTextIndex}) AS fts_match,
              CASE
                WHEN $${allowIlikeIndex}::boolean THEN searchable_text LIKE ANY($${likePatternsIndex}::text[])
                ELSE FALSE
              END AS ilike_match,
              CASE
                WHEN $${allowIlikeIndex}::boolean THEN (
                  SELECT count(*)::int
                  FROM unnest($${likePatternsIndex}::text[]) pattern
                  WHERE searchable_text LIKE pattern
                )
                ELSE 0
              END AS ilike_match_count
            FROM candidate_records
              WHERE (cardinality($${exactTitleIndex}::text[]) > 0 AND normalized_title = ANY($${exactTitleIndex}::text[]))
               OR (cardinality($${exactSectionIndex}::text[]) > 0 AND normalized_section = ANY($${exactSectionIndex}::text[]))
               OR (cardinality($${exactSourcePathIndex}::text[]) > 0 AND normalized_source_uri = ANY($${exactSourcePathIndex}::text[]))
               OR (cardinality($${exactSourceBasenameIndex}::text[]) > 0 AND normalized_source_basename = ANY($${exactSourceBasenameIndex}::text[]))
               OR search_vector @@ websearch_to_tsquery('simple', $${queryTextIndex})
               OR CASE
                    WHEN $${allowIlikeIndex}::boolean THEN searchable_text LIKE ANY($${likePatternsIndex}::text[])
                    ELSE FALSE
                  END
            ORDER BY
              CASE WHEN normalized_title = ANY($${exactTitleIndex}::text[]) THEN 1 ELSE 0 END DESC,
              CASE
                WHEN normalized_source_basename = ANY($${exactSourceBasenameIndex}::text[])
               OR normalized_source_uri = ANY($${exactSourcePathIndex}::text[])
                THEN 1 ELSE 0
              END DESC,
              CASE WHEN normalized_section = ANY($${exactSectionIndex}::text[]) THEN 1 ELSE 0 END DESC,
              GREATEST(
                ts_rank_cd(search_vector, websearch_to_tsquery('simple', $${queryTextIndex})),
                CASE
                  WHEN $${allowIlikeIndex}::boolean
                    AND searchable_text LIKE ANY($${likePatternsIndex}::text[])
                  THEN 0.15 ELSE 0
                END
              ) DESC,
              CASE
                WHEN $${allowIlikeIndex}::boolean THEN (
                  SELECT count(*)::int
                  FROM unnest($${likePatternsIndex}::text[]) pattern
                  WHERE searchable_text LIKE pattern
                )
                ELSE 0
              END DESC,
              updated_at DESC
            LIMIT $${limitIndex}
            OFFSET $${offsetIndex}
          `,
          [
            ...baseWhere.params,
            input.normalized_query,
            exactTitleQueries,
            exactSectionQueries,
            exactSourcePathQueries,
            exactSourceBasenameQueries,
            retrievalPolicy.allow_ilike_fallback,
            likePatterns,
            input.limit,
            input.offset
          ]
        );

        return result.rows.map((row) => {
          const record = mapPostgresRecallRecord(row);
          const matchedTerms = collectMatchedTerms(
            row.searchable_text,
            input.query_terms
          );
          const lexicalScore = Math.max(
            Number(row.fts_rank) || 0,
            row.exact_title_match ? 1.4 : 0,
            row.exact_source_path_match || row.exact_source_basename_match ? 1.25 : 0,
            row.exact_section_match ? 1.15 : 0,
            row.ilike_match
              ? Math.max(
                  matchedTerms.length / Math.max(input.query_terms.length, 1),
                  Math.min(Number(row.ilike_match_count ?? 0) / Math.max(likePatterns.length, 1), 1),
                  0.15
                )
              : 0
          );
          const whyMatched = [
            row.exact_title_match ? "postgres_exact_title_match" : null,
            row.exact_source_path_match ? "postgres_exact_source_path_match" : null,
            row.exact_source_basename_match ? "postgres_exact_source_basename_match" : null,
            row.exact_section_match ? "postgres_exact_section_match" : null,
            row.fts_match ? "postgres_fts_match" : null,
            row.ilike_match ? "ilike_fallback_match" : null,
            ...retrievalPolicy.reasons.map((reason) => `retrieval_policy:${reason}`)
          ].filter((value): value is string => Boolean(value));

          return {
            memory_id: record.memory_id,
            record,
            score: lexicalScore,
            lexical_score: lexicalScore,
            matched_terms: matchedTerms,
            why_matched:
              whyMatched.length > 0
                ? whyMatched
                : ["postgres_lexical_match"],
            source_retrievers: ["lexical"]
          };
        });
      });
    } catch (error) {
      if (error instanceof RecallError) {
        throw error;
      }

      throw new RecallError(
        RecallErrorCode.BackendUnavailable,
        error instanceof Error
          ? error.message
          : "PostgreSQL lexical retrieval failed."
      );
    }
  }

  private async retrieveExplicitMemoryIds(input: QueryConstraints): Promise<RetrieverCandidate[]> {
    try {
      return await this.withClient(async (client) => {
        const baseWhere = buildRecallSqlWhereClause({
          constraints: input,
          record_alias: "mr",
          source_alias: "src"
        });
        const orderIdsIndex = baseWhere.next_parameter_index;
        const limitIndex = orderIdsIndex + 1;
        const offsetIndex = limitIndex + 1;
        const searchDocument = buildLexicalSearchDocumentSql("mr", "src");

        const result = await client.query<PostgresLexicalRow>(
          `
            SELECT
              mr.*,
              src.source_type,
              src.uri AS source_uri,
              src.excerpt AS source_excerpt,
              lower(${searchDocument}) AS searchable_text,
              0::real AS fts_rank,
              FALSE AS ilike_match,
              FALSE AS fts_match,
              FALSE AS exact_title_match,
              FALSE AS exact_source_path_match,
              FALSE AS exact_source_basename_match,
              FALSE AS exact_section_match
            FROM memory_records mr
            LEFT JOIN LATERAL (
              SELECT
                ms.source_type,
                ms.uri,
                ms.excerpt
              FROM memory_sources ms
              WHERE ms.memory_id = mr.id
              ORDER BY ms.confidence DESC NULLS LAST, ms.created_at ASC
              LIMIT 1
            ) AS src ON TRUE
            WHERE ${baseWhere.sql}
            ORDER BY array_position($${orderIdsIndex}::text[], mr.id), mr.updated_at DESC
            LIMIT $${limitIndex}
            OFFSET $${offsetIndex}
          `,
          [
            ...baseWhere.params,
            [...(input.memory_ids ?? [])],
            input.limit,
            input.offset
          ]
        );

        return result.rows.map((row, index) => {
          const record = mapPostgresRecallRecord(row);
          return {
            memory_id: record.memory_id,
            record,
            score: 10 - index * 0.001,
            lexical_score: 10 - index * 0.001,
            matched_terms: collectMatchedTerms(row.searchable_text, input.query_terms),
            why_matched: ["explicit_memory_id_match"],
            source_retrievers: ["lexical"]
          };
        });
      });
    } catch (error) {
      if (error instanceof RecallError) {
        throw error;
      }

      throw new RecallError(
        RecallErrorCode.BackendUnavailable,
        error instanceof Error
          ? error.message
          : "PostgreSQL explicit memory-id retrieval failed."
      );
    }
  }
}
