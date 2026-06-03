import type { CacheInvalidationRequestRow } from "../schema/tables";
import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import { mapCacheInvalidationRequestRow } from "./support-row-mappers";
import type { ScopeType } from "../../shared";

export interface EnqueueCacheInvalidationInput {
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly reason: string;
}

export interface ClaimCacheInvalidationInput {
  readonly workerId: string;
  readonly leaseTtlSeconds?: number;
  readonly limit?: number;
  readonly maxAttempts?: number;
}

export interface ListClaimableCacheInvalidationInput {
  readonly limit?: number;
  readonly maxAttempts?: number;
}

function addSecondsIso(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

export class CacheInvalidationRequestRepository {
  async enqueue(
    tx: WriteTransactionContext,
    input: EnqueueCacheInvalidationInput
  ): Promise<CacheInvalidationRequestRow> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const row: CacheInvalidationRequestRow = {
        id: tx.nextId("cache_invalidation_request"),
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        reason: input.reason,
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now
      };
      tx.state.cacheInvalidationRequests.push(row);
      return row;
    }

    const [row] = await tx.query(
      `
        INSERT INTO cache_invalidation_requests (
          id, scope_type, scope_id, reason, status, attempts, next_attempt_at,
          last_error, lease_owner, lease_expires_at, completed_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 'pending', 0, $5::timestamptz, NULL, NULL, NULL, NULL, $5::timestamptz, $5::timestamptz)
        RETURNING *
      `,
      [
        tx.nextId("cache_invalidation_request"),
        input.scopeType,
        input.scopeId,
        input.reason,
        now
      ]
    );
    return mapCacheInvalidationRequestRow(row);
  }

  async claimNext(
    tx: WriteTransactionContext,
    input: ClaimCacheInvalidationInput
  ): Promise<CacheInvalidationRequestRow[]> {
    const now = tx.now();
    const limit = Math.max(1, Math.min(100, input.limit ?? 50));
    const maxAttempts = Math.max(1, input.maxAttempts ?? 10);
    const leaseExpiresAt = addSecondsIso(now, input.leaseTtlSeconds ?? 120);
    if (isInMemoryTransactionContext(tx)) {
      const rows = tx.state.cacheInvalidationRequests
        .filter((row) => {
          if (row.completedAt !== null) return false;
          if (row.attempts >= maxAttempts) return false;
          if (row.status === "pending" || row.status === "failed") {
            return row.nextAttemptAt === null || row.nextAttemptAt <= now;
          }
          return row.status === "processing" && (row.leaseExpiresAt === null || row.leaseExpiresAt <= now);
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
      const claimed: CacheInvalidationRequestRow[] = [];
      for (const current of rows) {
        const index = tx.state.cacheInvalidationRequests.findIndex((row) => row.id === current.id);
        if (index < 0) continue;
        const row: CacheInvalidationRequestRow = {
          ...tx.state.cacheInvalidationRequests[index],
          status: "processing",
          attempts: tx.state.cacheInvalidationRequests[index].attempts + 1,
          leaseOwner: input.workerId,
          leaseExpiresAt,
          updatedAt: now
        };
        tx.state.cacheInvalidationRequests[index] = row;
        claimed.push(row);
      }
      return claimed;
    }

    const rows = await tx.query(
      `
        WITH claimable AS (
          SELECT id
          FROM cache_invalidation_requests
          WHERE completed_at IS NULL
            AND (
              (status IN ('pending', 'failed') AND attempts < $5 AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz))
              OR
              (status = 'processing' AND attempts < $5 AND (lease_expires_at IS NULL OR lease_expires_at <= $1::timestamptz))
            )
          ORDER BY created_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        UPDATE cache_invalidation_requests
        SET status = 'processing',
            attempts = attempts + 1,
            lease_owner = $3,
            lease_expires_at = $4::timestamptz,
            updated_at = $1::timestamptz
        WHERE id IN (SELECT id FROM claimable)
        RETURNING *
      `,
      [now, limit, input.workerId, leaseExpiresAt, maxAttempts]
    );
    return rows.map(mapCacheInvalidationRequestRow);
  }

  async listClaimable(
    tx: WriteTransactionContext,
    input: ListClaimableCacheInvalidationInput = {}
  ): Promise<CacheInvalidationRequestRow[]> {
    const now = tx.now();
    const limit = Math.max(1, Math.min(100, input.limit ?? 20));
    const maxAttempts = Math.max(1, input.maxAttempts ?? 10);
    if (isInMemoryTransactionContext(tx)) {
      return tx.state.cacheInvalidationRequests
        .filter((row) => {
          if (row.completedAt !== null || row.attempts >= maxAttempts) return false;
          if (row.status === "pending" || row.status === "failed") {
            return row.nextAttemptAt === null || row.nextAttemptAt <= now;
          }
          return row.status === "processing" && (row.leaseExpiresAt === null || row.leaseExpiresAt <= now);
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
    }
    const rows = await tx.query(
      `
        SELECT *
        FROM cache_invalidation_requests
        WHERE completed_at IS NULL
          AND attempts < $3
          AND (
            (status IN ('pending', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz))
            OR
            (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= $1::timestamptz))
          )
        ORDER BY created_at ASC
        LIMIT $2
      `,
      [now, limit, maxAttempts]
    );
    return rows.map(mapCacheInvalidationRequestRow);
  }

  async markCompleted(tx: WriteTransactionContext, id: string): Promise<CacheInvalidationRequestRow> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      return this.updateInMemory(tx, id, (row) => ({
        ...row,
        status: "completed",
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now
      }));
    }
    const [row] = await tx.query(
      `
        UPDATE cache_invalidation_requests
        SET status = 'completed',
            completed_at = $2::timestamptz,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = $2::timestamptz
        WHERE id = $1
        RETURNING *
      `,
      [id, now]
    );
    if (!row) throw new Error(`Cache invalidation request not found: ${id}`);
    return mapCacheInvalidationRequestRow(row);
  }

  async markFailed(
    tx: WriteTransactionContext,
    id: string,
    error: string,
    retryDelaySeconds = 60
  ): Promise<CacheInvalidationRequestRow> {
    const now = tx.now();
    const nextAttemptAt = addSecondsIso(now, retryDelaySeconds);
    if (isInMemoryTransactionContext(tx)) {
      return this.updateInMemory(tx, id, (row) => ({
        ...row,
        status: "failed",
        lastError: error,
        nextAttemptAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now
      }));
    }
    const [row] = await tx.query(
      `
        UPDATE cache_invalidation_requests
        SET status = 'failed',
            last_error = $2,
            next_attempt_at = $3::timestamptz,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = $4::timestamptz
        WHERE id = $1
        RETURNING *
      `,
      [id, error, nextAttemptAt, now]
    );
    if (!row) throw new Error(`Cache invalidation request not found: ${id}`);
    return mapCacheInvalidationRequestRow(row);
  }

  private updateInMemory(
    tx: Extract<WriteTransactionContext, { backend: "memory" }>,
    id: string,
    mutate: (row: CacheInvalidationRequestRow) => CacheInvalidationRequestRow
  ): CacheInvalidationRequestRow {
    const index = tx.state.cacheInvalidationRequests.findIndex((row) => row.id === id);
    if (index < 0) throw new Error(`Cache invalidation request not found: ${id}`);
    const row = mutate(tx.state.cacheInvalidationRequests[index]);
    tx.state.cacheInvalidationRequests[index] = row;
    return row;
  }
}
