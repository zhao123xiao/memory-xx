import { RecallError, RecallErrorCode } from "../errors";
import { matchesMetadataConstraints } from "../metadata-filter-builder";
import {
  type BackendStatus,
  type QueryConstraints,
  type QueryEmbeddingAudit,
  type RecallRecord,
  type RetrieverCandidate
} from "../types";
import {
  PostgresRecallRetrieverBase,
  buildRecallSqlWhereClause,
  buildSemanticSearchDocumentSql,
  collectMatchedTerms,
  mapPostgresRecallRecord,
  type PostgresRecallOptions
} from "./postgres-support";

export interface VectorRetriever {
  get_backend_status(): Promise<BackendStatus> | BackendStatus;
  retrieve(input: QueryConstraints): Promise<RetrieverCandidate[]>;
  get_last_query_embedding_audit?(): QueryEmbeddingAudit | undefined;
}

export interface EmbedQueryResult {
  readonly embedding: readonly number[] | null;
  readonly audit: QueryEmbeddingAudit;
}

export interface QueryEmbeddingProvider {
  embed_query(input: {
    query: string;
    query_terms: string[];
  }): Promise<EmbedQueryResult> | EmbedQueryResult;
}

function matchesScope(record: RecallRecord, allowedScopeKeys: Set<string>): boolean {
  return allowedScopeKeys.has(`${record.scope_type}:${record.scope_id}`);
}

function tokenSet(record: RecallRecord): Set<string> {
  return new Set(
    [
      record.title,
      record.content,
      ...(record.semantic_terms ?? []),
      ...(record.entity_names ?? []),
      ...(record.tags ?? [])
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9_\u4e00-\u9fff]+/u)
      .filter((term) => term.length >= 2)
  );
}

export class StubVectorRetriever implements VectorRetriever {
  private readonly records: RecallRecord[];
  private readonly simulateFailure?: "timeout" | "unavailable";
  private readonly minimumScore: number;

  constructor(input?: {
    records?: RecallRecord[];
    simulate_failure?: "timeout" | "unavailable";
    minimum_score?: number;
  }) {
    this.records = input?.records ?? [];
    this.simulateFailure = input?.simulate_failure;
    this.minimumScore = input?.minimum_score ?? 0.2;
  }

  get_backend_status(): BackendStatus {
    if (this.simulateFailure === "timeout") {
      return {
        name: "vector",
        available: false,
        reason: "vector_backend_timeout",
        backend: "stub-vector"
      };
    }

    if (this.simulateFailure === "unavailable") {
      return {
        name: "vector",
        available: false,
        reason: "vector_backend_unavailable",
        backend: "stub-vector"
      };
    }

    return { name: "vector", available: true, backend: "stub-vector" };
  }

  async retrieve(input: QueryConstraints): Promise<RetrieverCandidate[]> {
    if (this.simulateFailure === "timeout") {
      throw new RecallError(
        RecallErrorCode.BackendTimeout,
        "vector backend timed out"
      );
    }

    if (this.simulateFailure === "unavailable") {
      throw new RecallError(
        RecallErrorCode.BackendUnavailable,
        "vector backend is unavailable"
      );
    }

    const scopeKeys = new Set(
      input.allowed_scope_set.map((scope) => `${scope.type}:${scope.id}`)
    );
    const queryTerms = new Set(input.query_terms);

    return this.records
      .filter((record) => matchesScope(record, scopeKeys))
      .filter((record) => !input.memory_ids || input.memory_ids.length === 0 || input.memory_ids.includes(record.memory_id))
      .filter((record) => input.filter_plan.evaluate(record))
      .filter((record) => matchesMetadataConstraints(record, input.metadata))
      .map((record) => {
        const tokens = tokenSet(record);
        const overlap = input.query_terms.filter((term) => tokens.has(term));
        const vectorScore = overlap.length / Math.max(queryTerms.size, 1);
        return {
          memory_id: record.memory_id,
          record,
          score: vectorScore,
          vector_score: vectorScore,
          matched_terms: overlap,
          why_matched:
            overlap.length > 0
              ? [`semantic token overlap: ${overlap.join(", ")}`]
              : ["semantic retriever found no overlap"],
          source_retrievers: ["vector"]
        };
      })
      .filter(
        (candidate) =>
          candidate.vector_score !== undefined &&
          candidate.vector_score >= this.minimumScore
      )
      .sort((left, right) => right.score - left.score)
      .slice(input.offset, input.offset + input.limit);
  }
}

interface VectorCapabilityStatus {
  readonly available: boolean;
  readonly reason?: string;
}

interface PostgresVectorRow {
  readonly searchable_text: string;
  readonly vector_distance: number;
}

export interface PostgresVectorRetrieverOptions extends PostgresRecallOptions {
  readonly query_embedding_provider?: QueryEmbeddingProvider;
  readonly vector_column_name?: string;
}

function toPostgresVectorLiteral(embedding: readonly number[]): string {
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new RecallError(
        RecallErrorCode.BackendUnavailable,
        "PostgreSQL vector retrieval received a non-finite query embedding value."
      );
    }
  }
  return `[${embedding.join(",")}]`;
}

export class PostgresVectorRetriever
  extends PostgresRecallRetrieverBase
  implements VectorRetriever
{
  private readonly queryEmbeddingProvider?: QueryEmbeddingProvider;
  private readonly vectorColumnName: string;
  private lastQueryEmbeddingAudit?: QueryEmbeddingAudit;

  constructor(options: PostgresVectorRetrieverOptions) {
    super(options);
    this.queryEmbeddingProvider = options.query_embedding_provider;
    this.vectorColumnName = options.vector_column_name ?? "embedding";
  }

  async get_backend_status(): Promise<BackendStatus> {
    const capability = await this.resolveCapabilityStatus();
    return {
      name: "vector",
      available: capability.available,
      reason: capability.reason,
      backend: "pgvector"
    };
  }

  get_last_query_embedding_audit(): QueryEmbeddingAudit | undefined {
    return this.lastQueryEmbeddingAudit;
  }

  async retrieve(input: QueryConstraints): Promise<RetrieverCandidate[]> {
    this.lastQueryEmbeddingAudit = undefined;
    const capability = await this.resolveCapabilityStatus();
    if (!capability.available) {
      throw new RecallError(
        RecallErrorCode.BackendUnavailable,
        capability.reason ?? "Vector backend is unavailable."
      );
    }

    const embeddingResult = await this.queryEmbeddingProvider?.embed_query({
      query: input.normalized_query,
      query_terms: input.query_terms
    });
    this.lastQueryEmbeddingAudit = embeddingResult?.audit;
    const queryEmbedding = embeddingResult?.embedding;

    if (!queryEmbedding || queryEmbedding.length === 0) {
      throw new RecallError(
        RecallErrorCode.BackendUnavailable,
        "No query embedding is available for PostgreSQL vector retrieval."
      );
    }

    const vectorLiteral = toPostgresVectorLiteral(queryEmbedding);

    try {
      return await this.withClient(async (client) => {
        const baseWhere = buildRecallSqlWhereClause({
          constraints: input,
          record_alias: "mr",
          source_alias: "src"
        });
        const vectorIndex = baseWhere.next_parameter_index;
        const limitIndex = vectorIndex + 1;
        const offsetIndex = limitIndex + 1;
        const searchDocument = buildSemanticSearchDocumentSql("mr", "src");

        const result = await client.query<PostgresVectorRow>(
          `
            SELECT
              mr.*,
              src.source_type,
              src.uri AS source_uri,
              src.excerpt AS source_excerpt,
              lower(${searchDocument}) AS searchable_text,
              mr.${this.vectorColumnName} <=> $${vectorIndex}::vector AS vector_distance
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
              AND mr.${this.vectorColumnName} IS NOT NULL
            ORDER BY mr.${this.vectorColumnName} <=> $${vectorIndex}::vector ASC, mr.updated_at DESC
            LIMIT $${limitIndex}
            OFFSET $${offsetIndex}
          `,
          [...baseWhere.params, vectorLiteral, input.limit, input.offset]
        );

        return result.rows.map((row) => {
          const record = mapPostgresRecallRecord(row);
          const matchedTerms = collectMatchedTerms(
            row.searchable_text,
            input.query_terms
          );
          const vectorScore = 1 / (1 + Math.max(Number(row.vector_distance) || 0, 0));

          return {
            memory_id: record.memory_id,
            record,
            score: vectorScore,
            vector_score: vectorScore,
            matched_terms: matchedTerms,
            why_matched: ["pgvector_distance_order"],
            source_retrievers: ["vector"]
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
          : "PostgreSQL vector retrieval failed."
      );
    }
  }

  private async resolveCapabilityStatus(): Promise<VectorCapabilityStatus> {
    if (!this.queryEmbeddingProvider) {
      return {
        available: false,
        reason: "vector_embedding_unavailable"
      };
    }

    try {
      return await this.withClient(async (client) => {
        const extensionCheck = await client.query<{
          installed: boolean;
        }>(
          `
            SELECT EXISTS(
              SELECT 1
              FROM pg_extension
              WHERE extname = 'vector'
            ) AS installed
          `
        );
        if (!extensionCheck.rows[0]?.installed) {
          return {
            available: false,
            reason: "pgvector_extension_unavailable"
          };
        }

        const columnCheck = await client.query<{
          present: boolean;
        }>(
          `
            SELECT EXISTS(
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = $1
                AND table_name = 'memory_records'
                AND column_name = $2
            ) AS present
          `,
          [this.schema, this.vectorColumnName]
        );

        if (!columnCheck.rows[0]?.present) {
          return {
            available: false,
            reason: "vector_column_unavailable"
          };
        }

        return { available: true };
      });
    } catch {
      return {
        available: false,
        reason: "vector_backend_unavailable"
      };
    }
  }
}
