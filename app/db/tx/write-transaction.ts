import type { QueryResultRow } from "pg";

import type { SequenceName, WriteDatabaseState } from "../schema/tables";

export interface BaseWriteTransactionContext {
  now(): string;
  nextId(sequenceName: SequenceName): string;
}

export interface InMemoryWriteTransactionContext extends BaseWriteTransactionContext {
  readonly backend: "memory";
  readonly state: WriteDatabaseState;
}

export interface PostgresWriteTransactionContext extends BaseWriteTransactionContext {
  readonly backend: "postgres";
  query<TResult extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<readonly TResult[]>;
}

export type WriteTransactionContext =
  | InMemoryWriteTransactionContext
  | PostgresWriteTransactionContext;

export interface WriteTransactionRunner {
  withTransaction<TResult>(
    work: (tx: WriteTransactionContext) => TResult | Promise<TResult>
  ): Promise<TResult>;
  snapshot(): Promise<WriteDatabaseState>;
  snapshotForMemoryIds(memoryIds: readonly string[]): Promise<WriteDatabaseState>;
}

export function withWriteTransaction<TResult>(
  runner: WriteTransactionRunner,
  work: (tx: WriteTransactionContext) => TResult | Promise<TResult>
): Promise<TResult> {
  return runner.withTransaction(work);
}

export function isInMemoryTransactionContext(
  tx: WriteTransactionContext
): tx is InMemoryWriteTransactionContext {
  return tx.backend === "memory";
}

export function isPostgresTransactionContext(
  tx: WriteTransactionContext
): tx is PostgresWriteTransactionContext {
  return tx.backend === "postgres";
}
