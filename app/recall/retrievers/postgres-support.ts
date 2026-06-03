import { Pool, type PoolClient, type QueryResultRow } from "pg";

import {
  createPostgresPoolConfig,
  type MemoryV2PostgresConfig
} from "../../db/adapters/postgres-config";
import {
  ensureSchema,
  setSearchPath
} from "../../db/adapters/postgres-write-database";
import { readPgBoolean } from "../../db/row-value-readers";
import { ScopeType, type JsonObject } from "../../shared";
import { type QueryConstraints, type RecallRecord } from "../types";

export interface PostgresRecallOptions {
  readonly config: MemoryV2PostgresConfig;
  readonly pool?: Pool;
}

export interface SqlFragment {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly next_parameter_index: number;
}

interface PostgresRecallRow extends QueryResultRow {
  readonly id: string;
  readonly scope_type: ScopeType;
  readonly scope_id: string;
  readonly content: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly metadata: JsonObject | null;
  readonly lifecycle_status: RecallRecord["lifecycleStatus"];
  readonly review_state: RecallRecord["reviewState"];
  readonly is_current: boolean;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly source_type?: string | null;
  readonly source_uri?: string | null;
  readonly source_excerpt?: string | null;
  readonly memory_layer?: string | null;
  readonly fact_status?: string | null;
  readonly valid_at?: Date | string | null;
  readonly invalid_at?: Date | string | null;
  readonly observed_at?: Date | string | null;
  readonly expires_at?: Date | string | null;
  readonly episode_id?: string | null;
  readonly importance?: number | string | null;
  readonly memory_strength?: number | string | null;
  readonly decay_policy?: string | null;
  readonly relation_count?: number | string | null;
}

export abstract class PostgresRecallRetrieverBase {
  protected readonly pool: Pool;
  private readonly ownsPool: boolean;
  protected readonly schema: string;

  constructor(options: PostgresRecallOptions) {
    this.pool = options.pool ?? new Pool(createPostgresPoolConfig(options.config));
    this.ownsPool = !options.pool;
    this.schema = options.config.schema;
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  protected async withClient<TResult>(
    work: (client: PoolClient) => Promise<TResult>
  ): Promise<TResult> {
    const client = await this.pool.connect();

    try {
      await ensureSchema(client, this.schema);
      await setSearchPath(client, this.schema);
      return await work(client);
    } finally {
      client.release();
    }
  }

  protected async canReachDatabase(): Promise<boolean> {
    try {
      return await this.withClient(async (client) => {
        await client.query("SELECT 1");
        return true;
      });
    } catch {
      return false;
    }
  }
}

export function buildRecallSqlWhereClause(input: {
  readonly constraints: QueryConstraints;
  readonly record_alias: string;
  readonly source_alias?: string;
  readonly first_parameter_index?: number;
}): SqlFragment {
  const params: unknown[] = [];
  const clauses: string[] = [];
  let parameterIndex = input.first_parameter_index ?? 1;
  const recordAlias = input.record_alias;
  const sourceAlias = input.source_alias;

  const scopeTuples = input.constraints.allowed_scope_set
    .map((scope) => {
      const tuple = `($${parameterIndex}, $${parameterIndex + 1})`;
      params.push(scope.type, scope.id);
      parameterIndex += 2;
      return tuple;
    })
    .join(", ");

  clauses.push(`(${recordAlias}.scope_type, ${recordAlias}.scope_id) IN (${scopeTuples})`);
  clauses.push(input.constraints.filter_plan.sql_where_clause);

  if (input.constraints.metadata.project_ids.length > 0) {
    clauses.push(
      `COALESCE(NULLIF(${recordAlias}.metadata ->> 'project_id', ''), CASE WHEN ${recordAlias}.scope_type = 'project' THEN ${recordAlias}.scope_id ELSE NULL END) = ANY($${parameterIndex}::text[])`
    );
    params.push(input.constraints.metadata.project_ids);
    parameterIndex += 1;
  }

  if (input.constraints.metadata.tags.length > 0) {
    clauses.push(
      `COALESCE(${recordAlias}.metadata -> 'tags', '[]'::jsonb) @> to_jsonb($${parameterIndex}::text[])`
    );
    params.push(input.constraints.metadata.tags);
    parameterIndex += 1;
  }

  if (input.constraints.metadata.entity_names.length > 0) {
    clauses.push(
      `EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(COALESCE(${recordAlias}.metadata -> 'entity_names', '[]'::jsonb)) AS entity(value)
        WHERE lower(entity.value) = ANY($${parameterIndex}::text[])
      )`
    );
    params.push(
      input.constraints.metadata.entity_names.map((entityName) =>
        entityName.toLowerCase()
      )
    );
    parameterIndex += 1;
  }

  if (input.constraints.metadata.source_types.length > 0 && sourceAlias) {
    clauses.push(
      `lower(COALESCE(${sourceAlias}.source_type, '')) = ANY($${parameterIndex}::text[])`
    );
    params.push(input.constraints.metadata.source_types);
    parameterIndex += 1;
  }

  if (input.constraints.metadata.date_from) {
    clauses.push(`${recordAlias}.created_at >= $${parameterIndex}::timestamptz`);
    params.push(`${input.constraints.metadata.date_from}T00:00:00.000Z`);
    parameterIndex += 1;
  }

  if (input.constraints.metadata.date_to) {
    clauses.push(`${recordAlias}.created_at <= $${parameterIndex}::timestamptz`);
    params.push(`${input.constraints.metadata.date_to}T23:59:59.999Z`);
    parameterIndex += 1;
  }

  if (input.constraints.memory_ids && input.constraints.memory_ids.length > 0) {
    clauses.push(`${recordAlias}.id = ANY($${parameterIndex}::text[])`);
    params.push([...input.constraints.memory_ids]);
    parameterIndex += 1;
  }

  return {
    sql: clauses.join("\n      AND "),
    params,
    next_parameter_index: parameterIndex
  };
}

export function buildCanonicalSourcePathSql(
  recordAlias: string,
  sourceAlias: string
): string {
  return `COALESCE(
    ${sourceAlias}.uri,
    ${recordAlias}.metadata ->> 'canonical_file_path',
    ${recordAlias}.metadata ->> 'canonicalFilePath',
    ${recordAlias}.metadata ->> 'file_path',
    ${recordAlias}.metadata ->> 'filePath',
    ${recordAlias}.metadata -> 'legacy' ->> 'canonical_file_path',
    ${recordAlias}.metadata -> 'legacy' ->> 'canonicalFilePath',
    ${recordAlias}.metadata -> 'legacy' ->> 'file_path',
    ${recordAlias}.metadata -> 'legacy' ->> 'filePath',
    ''
  )`;
}

export function buildLexicalSearchDocumentSql(
  recordAlias: string,
  sourceAlias: string
): string {
  const normalizedSourcePath = buildCanonicalSourcePathSql(recordAlias, sourceAlias);

  return `concat_ws(' ',
    COALESCE(${recordAlias}.title, ''),
    COALESCE(${recordAlias}.summary, ''),
    COALESCE(${recordAlias}.content, ''),
    ${normalizedSourcePath},
    COALESCE(${sourceAlias}.excerpt, ''),
    COALESCE(${sourceAlias}.source_type, ''),
    COALESCE((SELECT string_agg(tag.value, ' ')
      FROM jsonb_array_elements_text(COALESCE(${recordAlias}.metadata -> 'tags', '[]'::jsonb)) AS tag(value)), ''),
    COALESCE((SELECT string_agg(entity.value, ' ')
      FROM jsonb_array_elements_text(COALESCE(${recordAlias}.metadata -> 'entity_names', '[]'::jsonb)) AS entity(value)), ''),
    COALESCE((SELECT string_agg(term.value, ' ')
      FROM jsonb_array_elements_text(COALESCE(${recordAlias}.metadata -> 'lexical_terms', '[]'::jsonb)) AS term(value)), '')
  )`;
}

export function buildSemanticSearchDocumentSql(
  recordAlias: string,
  sourceAlias: string
): string {
  return `concat_ws(' ',
    COALESCE(${recordAlias}.title, ''),
    COALESCE(${recordAlias}.summary, ''),
    COALESCE(${recordAlias}.content, ''),
    COALESCE(${sourceAlias}.uri, ''),
    COALESCE(${sourceAlias}.excerpt, ''),
    COALESCE(${sourceAlias}.source_type, ''),
    COALESCE((SELECT string_agg(tag.value, ' ')
      FROM jsonb_array_elements_text(COALESCE(${recordAlias}.metadata -> 'tags', '[]'::jsonb)) AS tag(value)), ''),
    COALESCE((SELECT string_agg(entity.value, ' ')
      FROM jsonb_array_elements_text(COALESCE(${recordAlias}.metadata -> 'entity_names', '[]'::jsonb)) AS entity(value)), ''),
    COALESCE((SELECT string_agg(term.value, ' ')
      FROM jsonb_array_elements_text(COALESCE(${recordAlias}.metadata -> 'semantic_terms', '[]'::jsonb)) AS term(value)), '')
  )`;
}

export function mapPostgresRecallRecord(row: QueryResultRow): RecallRecord {
  const typedRow = row as PostgresRecallRow;
  const metadata = asJsonObject(typedRow.metadata);
  const legacyMetadata = asJsonObject(metadata.legacy as JsonObject | undefined);
  const scopeType = typedRow.scope_type;
  const scopeId = typedRow.scope_id;

  const projectId =
    readString(metadata, "project_id", "projectId") ??
    (scopeType === ScopeType.Project ? scopeId : undefined);
  const workspaceId =
    readString(metadata, "workspace_id", "workspaceId") ??
    (scopeType === ScopeType.Workspace ? scopeId : undefined);

  return {
    memory_id: typedRow.id,
    title: typedRow.title ?? undefined,
    content: typedRow.content,
    scope_type: scopeType,
    scope_id: scopeId,
    project_id: projectId,
    workspace_id: workspaceId,
    source:
      typedRow.source_uri || typedRow.source_type
        ? {
            path: typedRow.source_uri ?? typedRow.source_excerpt ?? `memory:${typedRow.id}`,
            source_type: typedRow.source_type ?? undefined
          }
        : undefined,
    section:
      readString(metadata, "section", "section_path", "sectionPath") ??
      readString(legacyMetadata, "section"),
    canonical_section:
      readString(metadata, "canonical_section", "canonicalSection") ??
      readString(legacyMetadata, "canonical_section", "canonicalSection"),
    canonical_source_path:
      readString(metadata, "canonical_file_path", "canonicalFilePath") ??
      readString(legacyMetadata, "canonical_file_path", "canonicalFilePath") ??
      readString(legacyMetadata, "file_path", "filePath"),
    category: readString(metadata, "category"),
    memory_type: readString(metadata, "memory_type", "memoryType"),
    memory_layer: typedRow.memory_layer ?? undefined,
    fact_status: typedRow.fact_status ?? undefined,
    valid_at: typedRow.valid_at ? toIsoString(typedRow.valid_at) : undefined,
    invalid_at: typedRow.invalid_at ? toIsoString(typedRow.invalid_at) : undefined,
    observed_at: typedRow.observed_at ? toIsoString(typedRow.observed_at) : undefined,
    expires_at: typedRow.expires_at ? toIsoString(typedRow.expires_at) : undefined,
    episode_id: typedRow.episode_id ?? undefined,
    importance: typedRow.importance != null ? Number(typedRow.importance) : undefined,
    memory_strength: typedRow.memory_strength != null ? Number(typedRow.memory_strength) : undefined,
    decay_policy: typedRow.decay_policy ?? undefined,
    relation_count: typedRow.relation_count != null ? Number(typedRow.relation_count) : undefined,
    tags: readStringArray(metadata, "tags"),
    entity_names: readStringArray(metadata, "entity_names", "entityNames"),
    lexical_terms: readStringArray(metadata, "lexical_terms", "lexicalTerms"),
    semantic_terms: readStringArray(metadata, "semantic_terms", "semanticTerms"),
    lifecycleStatus: typedRow.lifecycle_status,
    reviewState: typedRow.review_state,
    recallPolicy: readString(metadata, "recall_policy") ?? readNestedString(metadata, "auto_approval_policy", "memory_policy", "recall_policy"),
    isCurrent: readPgBoolean(typedRow.is_current, "memory_records.is_current"),
    created_at: toIsoString(typedRow.created_at),
    updated_at: toIsoString(typedRow.updated_at)
  };
}

export function collectMatchedTerms(
  searchableText: string,
  queryTerms: readonly string[]
): string[] {
  const normalized = searchableText.toLowerCase();
  return [...new Set(queryTerms.filter((term) => normalized.includes(term)))];
}

function readString(
  metadata: JsonObject,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}

function readNestedString(metadata: JsonObject, ...path: readonly string[]): string | undefined {
  let current: unknown = metadata;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim() !== "" ? current : undefined;
}

function readStringArray(
  metadata: JsonObject,
  ...keys: readonly string[]
): string[] | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      const strings = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
      if (strings.length > 0) {
        return strings;
      }
    }
  }

  return undefined;
}

function asJsonObject(value: JsonObject | null | undefined): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
