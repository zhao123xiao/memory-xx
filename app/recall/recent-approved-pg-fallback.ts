import type { QueryResult } from "pg";

import { LifecycleStatus, ReviewState, ScopeType } from "../shared";
import type { QueryConstraints, RecallRecord, RecallScopeRef, RetrieverCandidate } from "./types";

export interface PgQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<T>>;
}

export interface RecentApprovedPgFallbackAudit {
  readonly enabled: boolean;
  readonly window_ms: number;
  readonly candidate_cap: number;
  readonly candidate_count: number;
  readonly reason?: string;
}

export interface RecentApprovedPgFallbackResult {
  readonly candidates: RetrieverCandidate[];
  readonly audit: RecentApprovedPgFallbackAudit;
}

type RecentApprovedRow = Record<string, unknown> & {
  id: string;
  scope_type: string;
  scope_id: string;
  content: string;
  title: string | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  memory_type: string | null;
  memory_layer: string | null;
  fact_status: string | null;
  valid_at: string | null;
  invalid_at: string | null;
  observed_at: string | null;
  expires_at: string | null;
  importance: number | string | null;
  memory_strength: number | string | null;
  decay_policy: string | null;
  created_at: string | null;
  updated_at: string | null;
  source_path: string | null;
  source_type: string | null;
};

function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe_identifier:${value}`);
  }
  return `"${value}"`;
}

function table(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

function allowedPersistentScopes(scopes: readonly RecallScopeRef[]): RecallScopeRef[] {
  return scopes.filter((scope) =>
    scope.type === ScopeType.User ||
    scope.type === ScopeType.Project ||
    scope.type === ScopeType.Workspace ||
    scope.type === ScopeType.Global
  );
}

function metadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const raw = metadata[key];
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

function termOverlapScore(content: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0.02;
  const haystack = content.toLowerCase();
  let matches = 0;
  for (const term of terms) {
    const normalized = term.trim().toLowerCase();
    if (normalized.length >= 2 && haystack.includes(normalized)) {
      matches += 1;
    }
  }
  return Math.min(0.18, 0.03 + matches * 0.03);
}

function toCandidate(row: RecentApprovedRow, constraints: QueryConstraints): RetrieverCandidate {
  const metadata = row.metadata ?? {};
  const content = row.content ?? "";
  const record: RecallRecord = {
    memory_id: row.id,
    title: row.title ?? undefined,
    content,
    scope_type: row.scope_type as ScopeType,
    scope_id: row.scope_id,
    source: row.source_path ? { path: row.source_path, source_type: row.source_type ?? undefined } : undefined,
    lifecycleStatus: LifecycleStatus.Approved,
    reviewState: ReviewState.Approved,
    recallPolicy: typeof metadata.recall_policy === "string" ? metadata.recall_policy : undefined,
    isCurrent: true,
    category: typeof metadata.category === "string" ? metadata.category : undefined,
    memory_type: row.memory_type ?? (typeof metadata.memory_type === "string" ? metadata.memory_type : undefined),
    memory_layer: row.memory_layer ?? undefined,
    fact_status: row.fact_status ?? undefined,
    valid_at: row.valid_at ?? undefined,
    invalid_at: row.invalid_at ?? undefined,
    observed_at: row.observed_at ?? undefined,
    expires_at: row.expires_at ?? undefined,
    importance: row.importance == null ? undefined : Number(row.importance),
    memory_strength: row.memory_strength == null ? undefined : Number(row.memory_strength),
    decay_policy: row.decay_policy ?? undefined,
    tags: metadataStringArray(metadata, "tags"),
    entity_names: metadataStringArray(metadata, "entity_names"),
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined
  };
  const score = termOverlapScore([row.title, row.summary, content].filter(Boolean).join(" "), constraints.query_terms);
  return {
    memory_id: row.id,
    record,
    score,
    lexical_score: score,
    local_score: score,
    matched_terms: constraints.query_terms.filter((term) => content.toLowerCase().includes(term.toLowerCase())).slice(0, 8),
    why_matched: ["recent_approved_pg_fallback"],
    source_retrievers: ["pg_recent"]
  };
}

export async function fetchRecentApprovedPgFallback(input: {
  readonly queryable?: PgQueryable;
  readonly schema?: string;
  readonly constraints: QueryConstraints;
  readonly enabled?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<RecentApprovedPgFallbackResult> {
  const env = input.env ?? process.env;
  const enabled = input.enabled ?? env.MEMORY_XX_RECENT_APPROVED_PG_FALLBACK !== "false";
  const windowMs = readPositiveInt(env, "MEMORY_XX_RECENT_APPROVED_PG_FALLBACK_WINDOW_MS", 30_000);
  const candidateCap = readPositiveInt(env, "MEMORY_XX_RECENT_APPROVED_PG_FALLBACK_LIMIT", 20);
  const baseAudit = {
    enabled,
    window_ms: windowMs,
    candidate_cap: candidateCap,
    candidate_count: 0
  } as const;
  if (!enabled) {
    return { candidates: [], audit: { ...baseAudit, reason: "disabled" } };
  }
  if (!input.queryable) {
    return { candidates: [], audit: { ...baseAudit, reason: "queryable_unavailable" } };
  }
  const scopes = allowedPersistentScopes(input.constraints.allowed_scope_set);
  if (scopes.length === 0) {
    return { candidates: [], audit: { ...baseAudit, reason: "no_persistent_scope" } };
  }

  const params: unknown[] = [windowMs, candidateCap];
  const scopeClauses = scopes.map((scope) => {
    params.push(scope.type, scope.id);
    return `(mr.scope_type = $${params.length - 1} AND mr.scope_id = $${params.length})`;
  });
  const schema = input.schema?.trim() || process.env.MEMORY_XX_DATABASE_SCHEMA?.trim() || "public";
  const rows = await input.queryable.query<RecentApprovedRow>(
    `
      SELECT
        mr.id, mr.scope_type, mr.scope_id, mr.content, mr.title, mr.summary, mr.metadata, mr.memory_type,
        mr.memory_layer, mr.fact_status, mr.valid_at, mr.invalid_at, mr.observed_at, mr.expires_at,
        mr.importance, mr.memory_strength, mr.decay_policy, mr.created_at, mr.updated_at,
        src.uri AS source_path, src.source_type
      FROM ${table(schema, "memory_records")} mr
      LEFT JOIN LATERAL (
        SELECT uri, source_type
        FROM ${table(schema, "memory_sources")}
        WHERE memory_id = mr.id
        ORDER BY created_at ASC
        LIMIT 1
      ) src ON TRUE
      WHERE mr.lifecycle_status = $${params.push(LifecycleStatus.Approved)}
        AND mr.review_state IN ($${params.push(ReviewState.Approved)}, $${params.push(ReviewState.NotRequired)}, $${params.push(ReviewState.SilentApproved)})
        AND mr.is_current IS TRUE
        AND COALESCE(mr.metadata->>'recall_policy', mr.metadata->'auto_approval_policy'->'memory_policy'->>'recall_policy', 'default') = 'default'
        AND mr.updated_at >= now() - ($1::int * interval '1 millisecond')
        AND (${scopeClauses.join(" OR ")})
      ORDER BY mr.updated_at DESC
      LIMIT $2
    `,
    params
  );
  const candidates = rows.rows
    .map((row) => toCandidate(row, input.constraints))
    .filter((candidate) => input.constraints.filter_plan.evaluate(candidate.record));
  return {
    candidates,
    audit: {
      ...baseAudit,
      candidate_count: candidates.length,
      ...(candidates.length === 0 ? { reason: "no_recent_approved_records" } : {})
    }
  };
}
