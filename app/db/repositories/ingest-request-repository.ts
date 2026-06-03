import type {
  IngestRequestRow
} from "../schema/tables";
import {
  type InMemoryWriteTransactionContext,
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import {
  IngestRequestStatus,
  type RegisteredIngestRequest,
  type StoredIngestResult
} from "../../shared/contracts/write";
import { mapIngestRequestRow } from "../adapters/postgres-row-mappers";

export interface InsertIngestRequestInput extends RegisteredIngestRequest {}

export interface RecoverExpiredAcceptedInput {
  readonly leaseTtlSeconds?: number;
  readonly recoverableDelaySeconds?: number;
}

const DEFAULT_INGEST_LEASE_TTL_SECONDS = 120;

function defaultLeaseOwner(): string {
  return process.env.MEMORY_V2_WORKER_ID?.trim() || `pid-${process.pid}`;
}

function addSecondsIso(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

export class IngestRequestRepository {
  async findByRequestId(
    tx: WriteTransactionContext,
    requestId: string
  ): Promise<IngestRequestRow | undefined> {
    if (isInMemoryTransactionContext(tx)) {
      return tx.state.ingestRequests.find((row) => row.requestId === requestId);
    }

    const [row] = await tx.query(
      "SELECT * FROM ingest_requests WHERE request_id = $1",
      [requestId]
    );
    return row ? mapIngestRequestRow(row) : undefined;
  }

  async insertAccepted(
    tx: WriteTransactionContext,
    input: InsertIngestRequestInput
  ): Promise<IngestRequestRow | undefined> {
    if (isInMemoryTransactionContext(tx)) {
      const now = tx.now();
      const row: IngestRequestRow = {
        requestId: input.requestId,
        commandType: input.commandType,
        payloadHash: input.payloadHash,
        payloadJson: input.payloadJson,
        actorId: input.actorId,
        status: IngestRequestStatus.Accepted,
        firstSeenAt: now,
        lastSeenAt: now,
        completedAt: null,
        result: null,
        errorCode: null,
        errorMessage: null,
        leaseOwner: defaultLeaseOwner(),
        leaseExpiresAt: addSecondsIso(now, DEFAULT_INGEST_LEASE_TTL_SECONDS),
        lastHeartbeatAt: now,
        recoverableAfter: null,
        recoverable: false
      };
      tx.state.ingestRequests.push(row);
      return row;
    }

    const now = tx.now();
    const leaseOwner = defaultLeaseOwner();
    const leaseExpiresAt = addSecondsIso(now, DEFAULT_INGEST_LEASE_TTL_SECONDS);
    const [row] = await tx.query(
      `
        INSERT INTO ingest_requests (
          request_id,
          command_type,
          payload_hash,
          payload_json,
          actor_id,
          status,
          first_seen_at,
          last_seen_at,
          completed_at,
          result_json,
          error_code,
          error_message,
          lease_owner,
          lease_expires_at,
          last_heartbeat_at,
          recoverable_after,
          recoverable
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::timestamptz, $8::timestamptz, NULL, NULL, NULL, NULL,
          $9, $10::timestamptz, $11::timestamptz, NULL, FALSE)
        ON CONFLICT (request_id) DO NOTHING
        RETURNING *
      `,
      [
        input.requestId,
        input.commandType,
        input.payloadHash,
        input.payloadJson,
        input.actorId,
        IngestRequestStatus.Accepted,
        now,
        now,
        leaseOwner,
        leaseExpiresAt,
        now
      ]
    );

    return row ? mapIngestRequestRow(row) : undefined;
  }

  async markCompleted(
    tx: WriteTransactionContext,
    requestId: string,
    result: StoredIngestResult
  ): Promise<IngestRequestRow> {
    if (isInMemoryTransactionContext(tx)) {
      return this.updateInMemory(tx, requestId, (row) => ({
        ...row,
        status: IngestRequestStatus.Completed,
        lastSeenAt: tx.now(),
        completedAt: tx.now(),
        result,
        errorCode: null,
        errorMessage: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: row.lastHeartbeatAt,
        recoverableAfter: null,
        recoverable: false
      }));
    }

    const now = tx.now();
    const [row] = await tx.query(
      `
        UPDATE ingest_requests
        SET status = $2,
            last_seen_at = $3::timestamptz,
            completed_at = $4::timestamptz,
            result_json = $5::jsonb,
            error_code = NULL,
            error_message = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            recoverable_after = NULL,
            recoverable = FALSE
        WHERE request_id = $1
        RETURNING *
      `,
      [requestId, IngestRequestStatus.Completed, now, now, JSON.stringify(result)]
    );

    if (!row) {
      throw new Error(`Request ${requestId} not found.`);
    }

    return mapIngestRequestRow(row);
  }

  async markFailed(
    tx: WriteTransactionContext,
    requestId: string,
    errorCode: string,
    errorMessage: string
  ): Promise<IngestRequestRow> {
    if (isInMemoryTransactionContext(tx)) {
      return this.updateInMemory(tx, requestId, (row) => ({
        ...row,
        status: IngestRequestStatus.Failed,
        lastSeenAt: tx.now(),
        completedAt: null,
        errorCode,
        errorMessage,
        leaseOwner: null,
        leaseExpiresAt: null,
        recoverableAfter: null,
        recoverable: false
      }));
    }

    const [row] = await tx.query(
      `
        UPDATE ingest_requests
        SET status = $2,
            last_seen_at = $3::timestamptz,
            completed_at = NULL,
            error_code = $4,
            error_message = $5,
            lease_owner = NULL,
            lease_expires_at = NULL,
            recoverable_after = NULL,
            recoverable = FALSE
        WHERE request_id = $1
        RETURNING *
      `,
      [requestId, IngestRequestStatus.Failed, tx.now(), errorCode, errorMessage]
    );

    if (!row) {
      throw new Error(`Request ${requestId} not found.`);
    }

    return mapIngestRequestRow(row);
  }

  async touch(
    tx: WriteTransactionContext,
    requestId: string
  ): Promise<IngestRequestRow> {
    if (isInMemoryTransactionContext(tx)) {
      return this.updateInMemory(tx, requestId, (row) => ({
        ...row,
        lastSeenAt: tx.now()
      }));
    }

    const [row] = await tx.query(
      `
        UPDATE ingest_requests
        SET last_seen_at = $2::timestamptz
        WHERE request_id = $1
        RETURNING *
      `,
      [requestId, tx.now()]
    );

    if (!row) {
      throw new Error(`Request ${requestId} not found.`);
    }

    return mapIngestRequestRow(row);
  }

  async heartbeat(
    tx: WriteTransactionContext,
    requestId: string,
    leaseTtlSeconds = DEFAULT_INGEST_LEASE_TTL_SECONDS
  ): Promise<IngestRequestRow> {
    const now = tx.now();
    const leaseOwner = defaultLeaseOwner();
    const leaseExpiresAt = addSecondsIso(now, leaseTtlSeconds);
    if (isInMemoryTransactionContext(tx)) {
      return this.updateInMemory(tx, requestId, (row) => ({
        ...row,
        leaseOwner,
        leaseExpiresAt,
        lastHeartbeatAt: now,
        lastSeenAt: now
      }));
    }

    const [row] = await tx.query(
      `
        UPDATE ingest_requests
        SET lease_owner = $2,
            lease_expires_at = $3::timestamptz,
            last_heartbeat_at = $4::timestamptz,
            last_seen_at = $4::timestamptz
        WHERE request_id = $1 AND status = 'accepted'
        RETURNING *
      `,
      [requestId, leaseOwner, leaseExpiresAt, now]
    );

    if (!row) throw new Error(`Request ${requestId} not found.`);
    return mapIngestRequestRow(row);
  }

  async recoverAccepted(
    tx: WriteTransactionContext,
    requestId: string,
    leaseTtlSeconds = DEFAULT_INGEST_LEASE_TTL_SECONDS
  ): Promise<IngestRequestRow | undefined> {
    const now = tx.now();
    const leaseOwner = defaultLeaseOwner();
    const leaseExpiresAt = addSecondsIso(now, leaseTtlSeconds);
    if (isInMemoryTransactionContext(tx)) {
      const index = tx.state.ingestRequests.findIndex((row) => row.requestId === requestId);
      if (index === -1) return undefined;
      const current = tx.state.ingestRequests[index];
      if (
        current.status !== IngestRequestStatus.Failed ||
        !current.recoverable ||
        (current.recoverableAfter !== null && current.recoverableAfter > now)
      ) {
        return undefined;
      }
      const row: IngestRequestRow = {
        ...current,
        status: IngestRequestStatus.Accepted,
        lastSeenAt: now,
        completedAt: null,
        result: null,
        errorCode: null,
        errorMessage: null,
        leaseOwner,
        leaseExpiresAt,
        lastHeartbeatAt: now,
        recoverableAfter: null,
        recoverable: false
      };
      tx.state.ingestRequests[index] = row;
      return row;
    }

    const [row] = await tx.query(
      `
        UPDATE ingest_requests
        SET status = 'accepted',
            last_seen_at = $2::timestamptz,
            completed_at = NULL,
            result_json = NULL,
            error_code = NULL,
            error_message = NULL,
            lease_owner = $3,
            lease_expires_at = $4::timestamptz,
            last_heartbeat_at = $2::timestamptz,
            recoverable_after = NULL,
            recoverable = FALSE
        WHERE request_id = $1
          AND status = 'failed'
          AND recoverable = TRUE
          AND (recoverable_after IS NULL OR recoverable_after <= $2::timestamptz)
        RETURNING *
      `,
      [requestId, now, leaseOwner, leaseExpiresAt]
    );
    return row ? mapIngestRequestRow(row) : undefined;
  }

  async recoverExpiredAccepted(
    tx: WriteTransactionContext,
    input: RecoverExpiredAcceptedInput = {}
  ): Promise<number> {
    const now = tx.now();
    const recoverableAfter = addSecondsIso(now, input.recoverableDelaySeconds ?? 0);
    if (isInMemoryTransactionContext(tx)) {
      let count = 0;
      const nextRows = tx.state.ingestRequests.map((row) => {
        if (
          row.status !== IngestRequestStatus.Accepted ||
          row.leaseExpiresAt === null ||
          row.leaseExpiresAt > now
        ) {
          return row;
        }
        count += 1;
        return {
          ...row,
          status: IngestRequestStatus.Failed,
          lastSeenAt: now,
          completedAt: null,
          errorCode: "accepted_lease_expired",
          errorMessage: "Accepted request lease expired before completion.",
          leaseOwner: null,
          leaseExpiresAt: null,
          recoverableAfter,
          recoverable: true
        };
      });
      tx.state.ingestRequests.splice(0, tx.state.ingestRequests.length, ...nextRows);
      return count;
    }

    const rows = await tx.query(
      `
        UPDATE ingest_requests
        SET status = 'failed',
            last_seen_at = $1::timestamptz,
            completed_at = NULL,
            error_code = 'accepted_lease_expired',
            error_message = 'Accepted request lease expired before completion.',
            lease_owner = NULL,
            lease_expires_at = NULL,
            recoverable_after = $2::timestamptz,
            recoverable = TRUE
        WHERE status = 'accepted'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= $1::timestamptz
        RETURNING request_id
      `,
      [now, recoverableAfter]
    );
    return rows.length;
  }

  private updateInMemory(
    tx: InMemoryWriteTransactionContext,
    requestId: string,
    mutate: (row: IngestRequestRow) => IngestRequestRow
  ): IngestRequestRow {
    const index = tx.state.ingestRequests.findIndex((row) => row.requestId === requestId);
    if (index === -1) {
      throw new Error(`Request ${requestId} not found.`);
    }

    const nextRow = mutate(tx.state.ingestRequests[index]);
    tx.state.ingestRequests[index] = nextRow;
    return nextRow;
  }
}
