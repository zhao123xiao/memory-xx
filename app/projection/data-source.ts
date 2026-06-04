/**
 * Read-only data source for projection runtime.
 *
 * This abstracts over PostgreSQL / in-memory so the projection
 * chain does not depend on the write transaction runner.
 */
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
