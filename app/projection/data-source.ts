/**
 * Read-only data source for projection runtime.
 *
 * This abstracts over PostgreSQL / in-memory so the projection
 * chain does not depend on the write transaction runner.
 */
import { Pool } from "pg";

import { createPostgresPoolConfig, type MemoryXXPostgresConfig } from "../db/adapters/postgres-config";
import { LifecycleStatus, ReviewState, ScopeType, type JsonObject } from "../shared";
import type { ProjectionRecord, ProjectionView } from "./types";
import { classifyRecordToViews } from "./mapper/classify-record";

export interface ProjectionDataSource {
  /** Load a single record by ID. */
  getRecord(recordId: string): Promise<ProjectionRecord | undefined>;

  /** Load all records visible in a given view (full scan for rebuild). */
  getRecordsForView(view: ProjectionView): Promise<ProjectionRecord[]>;

  /** Load all records (for full rebuild). */
  getAllRecords(): Promise<ProjectionRecord[]>;

  /** Load records by IDs (for incremental export). */
  getRecordsByIds(ids: readonly string[]): Promise<ProjectionRecord[]>;
}

/**
 * In-memory data source backed by an array of ProjectionRecords.
 * Used for testing and in-memory mode.
 */
export class InMemoryProjectionDataSource implements ProjectionDataSource {
  constructor(private readonly records: ProjectionRecord[] = []) {}

  async getRecord(recordId: string): Promise<ProjectionRecord | undefined> {
    return this.records.find((r) => r.recordId === recordId);
  }

  async getRecordsForView(view: ProjectionView): Promise<ProjectionRecord[]> {
    return this.records.filter((record) => classifyRecordToViews(record).includes(view));
  }

  async getAllRecords(): Promise<ProjectionRecord[]> {
    return [...this.records];
  }

  async getRecordsByIds(ids: readonly string[]): Promise<ProjectionRecord[]> {
    const idSet = new Set(ids);
    return this.records.filter((r) => idSet.has(r.recordId));
  }
}

interface PostgresProjectionRecordRow {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly content: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly metadata: JsonObject | null;
  readonly lifecycle_status: string;
  readonly review_state: string;
  readonly is_current: boolean;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly valid_at?: Date | string | null;
  readonly observed_at?: Date | string | null;
  readonly expires_at?: Date | string | null;
  readonly memory_type?: string | null;
  readonly importance?: number | string | null;
}

export interface PostgresProjectionDataSourceOptions {
  readonly config: MemoryXXPostgresConfig;
  readonly pool?: Pool;
  readonly includeNonCurrent?: boolean;
  readonly includePending?: boolean;
  readonly limit?: number;
}

/**
 * PostgreSQL-backed projection source used by the production Markdown exporter.
 */
export class PostgresProjectionDataSource implements ProjectionDataSource {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(private readonly options: PostgresProjectionDataSourceOptions) {
    this.pool = options.pool ?? new Pool(createPostgresPoolConfig(options.config));
    this.ownsPool = !options.pool;
  }

  async getRecord(recordId: string): Promise<ProjectionRecord | undefined> {
    const records = await this.loadRows("WHERE id = $1", [recordId]);
    return records[0];
  }

  async getRecordsForView(view: ProjectionView): Promise<ProjectionRecord[]> {
    const records = await this.getAllRecords();
    return records.filter((record) => classifyRecordToViews(record).includes(view));
  }

  async getAllRecords(): Promise<ProjectionRecord[]> {
    return this.loadRows(this.buildVisibilityWhereClause(), []);
  }

  async getRecordsByIds(ids: readonly string[]): Promise<ProjectionRecord[]> {
    if (ids.length === 0) return [];
    return this.loadRows(`WHERE id = ANY($1::text[]) AND ${this.buildVisibilityPredicate()}`, [ids]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async loadRows(whereClause: string, params: readonly unknown[]): Promise<ProjectionRecord[]> {
    const schema = quoteIdentifier(this.options.config.schema);
    const limit = Number.isInteger(this.options.limit) && this.options.limit && this.options.limit > 0
      ? ` LIMIT ${this.options.limit}`
      : "";
    const result = await this.pool.query<PostgresProjectionRecordRow>(
      `
        SELECT
          id,
          scope_type,
          scope_id,
          content,
          title,
          summary,
          metadata,
          lifecycle_status,
          review_state,
          is_current,
          created_at,
          updated_at,
          valid_at,
          observed_at,
          expires_at,
          memory_type,
          importance
        FROM ${schema}.memory_records
        ${whereClause}
        ORDER BY updated_at DESC, id ASC
        ${limit}
      `,
      [...params]
    );
    return result.rows.map(mapPostgresProjectionRecord);
  }

  private buildVisibilityWhereClause(): string {
    return `WHERE ${this.buildVisibilityPredicate()}`;
  }

  private buildVisibilityPredicate(): string {
    const lifecyclePredicate = this.options.includePending
      ? "lifecycle_status IN ('candidate', 'approved', 'archived', 'tombstone')"
      : "lifecycle_status IN ('approved', 'archived', 'tombstone')";
    const reviewPredicate = this.options.includePending
      ? "review_state IN ('pending', 'approved', 'silent_approved', 'not_required')"
      : "review_state IN ('approved', 'silent_approved', 'not_required')";
    const currentPredicate = this.options.includeNonCurrent ? "TRUE" : "is_current = TRUE";
    return `${lifecyclePredicate} AND ${reviewPredicate} AND ${currentPredicate}`;
  }
}

function mapPostgresProjectionRecord(row: PostgresProjectionRecordRow): ProjectionRecord {
  const metadata = row.metadata ?? {};
  const category = stringValue(metadata.category);
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.filter((item): item is string => typeof item === "string")
    : undefined;
  const primaryView = mapCategoryToPrimaryView(category);
  const updatedAt = toIso(row.updated_at);
  const createdAt = toIso(row.created_at);
  const observedAt = toOptionalIso(row.observed_at);
  const validAt = toOptionalIso(row.valid_at);

  return {
    recordId: row.id,
    scope: mapScopeType(row.scope_type),
    lifecycleStatus: mapLifecycleStatus(row.lifecycle_status),
    reviewState: mapReviewState(row.review_state),
    isCurrent: row.is_current,
    title: row.title ?? firstLine(row.content) ?? row.id,
    body: row.content,
    summary: row.summary ?? undefined,
    sourceRecordIds: [row.id],
    tags,
    primaryView,
    projectKey: row.scope_type === ScopeType.Project ? row.scope_id : stringValue(metadata.project_key),
    occurredAt: category === "daily-log" ? observedAt ?? validAt ?? createdAt : undefined,
    dueDate: category === "todos" ? toOptionalIso(row.expires_at) ?? stringValue(metadata.due_at) ?? updatedAt : undefined,
    decisionDate: category === "decisions" ? validAt ?? observedAt ?? updatedAt : undefined,
    archivedAt: row.lifecycle_status === LifecycleStatus.Archived || row.lifecycle_status === LifecycleStatus.Tombstone
      ? updatedAt
      : undefined,
    createdAt,
    updatedAt,
    weight: numberValue(row.importance) ?? numberValue(metadata.importance),
    queue: stringValue(metadata.queue),
    archiveBucket: row.lifecycle_status === LifecycleStatus.Archived || row.lifecycle_status === LifecycleStatus.Tombstone
      ? row.lifecycle_status
      : undefined,
    statePriority: category === "todos" ? numberValue(metadata.state_priority) ?? 1 : undefined
  };
}

function mapCategoryToPrimaryView(category: string | undefined): ProjectionView | undefined {
  switch (category) {
    case "decisions":
      return "decisions" as ProjectionView;
    case "projects":
      return "projects" as ProjectionView;
    case "todos":
      return "todos" as ProjectionView;
    case "daily-log":
      return "daily" as ProjectionView;
    case "governance":
      return "governance" as ProjectionView;
    case "preferences":
    case "constraints":
    case "facts":
    case "lessons":
    case "relationships":
    case "summaries":
    case "memory-index":
      return "overview" as ProjectionView;
    default:
      return undefined;
  }
}

function mapScopeType(value: string): ScopeType {
  return Object.values(ScopeType).includes(value as ScopeType) ? value as ScopeType : ScopeType.User;
}

function mapLifecycleStatus(value: string): LifecycleStatus {
  return Object.values(LifecycleStatus).includes(value as LifecycleStatus) ? value as LifecycleStatus : LifecycleStatus.Candidate;
}

function mapReviewState(value: string): ReviewState {
  return Object.values(ReviewState).includes(value as ReviewState) ? value as ReviewState : ReviewState.Pending;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toOptionalIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return toIso(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/u).find((line) => line.trim() !== "")?.trim();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
