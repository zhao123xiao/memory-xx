import { createHash } from "node:crypto";

import type { WriteTicketRow, WriteTicketStatus } from "../schema/tables";
import {
  type WriteTransactionContext,
  isInMemoryTransactionContext
} from "../tx/write-transaction";
import { mapWriteTicketRow } from "./support-row-mappers";
import type { JsonObject } from "../../shared";

export interface CreateWriteTicketInput {
  readonly idempotencyKey?: string | null;
  readonly actorId: string;
  readonly agentId: string;
  readonly requestJson: JsonObject;
  readonly payloadHash?: string | null;
  readonly ttlSeconds?: number;
}

export interface CompleteWriteTicketInput {
  readonly ticketId: string;
  readonly status: Exclude<WriteTicketStatus, "pending_extraction" | "processing_extraction">;
  readonly resultJson?: JsonObject | null;
  readonly createdMemoryId?: string | null;
  readonly candidateMemoryId?: string | null;
  readonly duplicateOfMemoryId?: string | null;
  readonly failureReason?: string | null;
}

export interface ClaimWriteTicketInput {
  readonly workerId: string;
  readonly leaseTtlSeconds?: number;
  readonly limit?: number;
}

function addSecondsIso(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function hashPayload(value: JsonObject): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class WriteTicketRepository {
  async findById(tx: WriteTransactionContext, ticketId: string): Promise<WriteTicketRow | null> {
    if (isInMemoryTransactionContext(tx)) {
      return tx.state.writeTickets.find((row) => row.id === ticketId) ?? null;
    }
    const [row] = await tx.query(`SELECT * FROM write_tickets WHERE id = $1 LIMIT 1`, [ticketId]);
    return row ? mapWriteTicketRow(row) : null;
  }

  async findByIdempotencyKey(tx: WriteTransactionContext, idempotencyKey: string): Promise<WriteTicketRow | null> {
    if (isInMemoryTransactionContext(tx)) {
      return tx.state.writeTickets.find((row) => row.idempotencyKey === idempotencyKey) ?? null;
    }
    const [row] = await tx.query(`SELECT * FROM write_tickets WHERE idempotency_key = $1 LIMIT 1`, [idempotencyKey]);
    return row ? mapWriteTicketRow(row) : null;
  }

  async create(tx: WriteTransactionContext, input: CreateWriteTicketInput): Promise<WriteTicketRow> {
    const now = tx.now();
    const ttlSeconds = input.ttlSeconds ?? 120;
    const expiresAt = new Date(Date.parse(now) + ttlSeconds * 1000).toISOString();
    if (isInMemoryTransactionContext(tx)) {
      const existing = input.idempotencyKey
        ? tx.state.writeTickets.find((row) => row.idempotencyKey === input.idempotencyKey)
        : undefined;
      if (existing) return existing;
      const row: WriteTicketRow = {
        id: tx.nextId("write_ticket"),
        idempotencyKey: input.idempotencyKey ?? null,
        actorId: input.actorId,
        agentId: input.agentId,
        status: "pending_extraction",
        requestJson: input.requestJson,
        payloadHash: input.payloadHash ?? hashPayload(input.requestJson),
        resultJson: null,
        createdMemoryId: null,
        candidateMemoryId: null,
        duplicateOfMemoryId: null,
        failureReason: null,
        expiresAt,
        terminalAt: null,
        archivedAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      };
      tx.state.writeTickets.push(row);
      return row;
    }

    const [row] = await tx.query(
      `
        INSERT INTO write_tickets (
          id, idempotency_key, actor_id, agent_id, status, request_json, payload_hash,
          result_json, created_memory_id, candidate_memory_id, duplicate_of_memory_id,
          failure_reason, expires_at, terminal_at, archived_at, lease_owner, lease_expires_at,
          attempts, next_attempt_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 'pending_extraction', $5::jsonb, $6, NULL, NULL, NULL, NULL,
          NULL, $7::timestamptz, NULL, NULL, NULL, NULL, 0, $8::timestamptz, $9::timestamptz, $10::timestamptz)
        ON CONFLICT (idempotency_key) DO UPDATE
          SET updated_at = write_tickets.updated_at
        RETURNING *
      `,
      [
        tx.nextId("write_ticket"),
        input.idempotencyKey ?? null,
        input.actorId,
        input.agentId,
        JSON.stringify(input.requestJson),
        input.payloadHash ?? hashPayload(input.requestJson),
        expiresAt,
        now,
        now,
        now,
      ]
    );
    return mapWriteTicketRow(row);
  }

  async complete(tx: WriteTransactionContext, input: CompleteWriteTicketInput): Promise<WriteTicketRow> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      const index = tx.state.writeTickets.findIndex((row) => row.id === input.ticketId);
      if (index < 0) throw new Error(`Write ticket not found: ${input.ticketId}`);
      const current = tx.state.writeTickets[index];
      const row: WriteTicketRow = {
        ...current,
        status: input.status,
        resultJson: input.resultJson ?? current.resultJson,
        createdMemoryId: input.createdMemoryId ?? current.createdMemoryId,
        candidateMemoryId: input.candidateMemoryId ?? current.candidateMemoryId,
        duplicateOfMemoryId: input.duplicateOfMemoryId ?? current.duplicateOfMemoryId,
        failureReason: input.failureReason ?? current.failureReason,
        terminalAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      };
      tx.state.writeTickets[index] = row;
      return row;
    }
    const [row] = await tx.query(
      `
        UPDATE write_tickets
        SET status = $2,
            result_json = COALESCE($3::jsonb, result_json),
            created_memory_id = COALESCE($4, created_memory_id),
            candidate_memory_id = COALESCE($5, candidate_memory_id),
            duplicate_of_memory_id = COALESCE($6, duplicate_of_memory_id),
            failure_reason = COALESCE($7, failure_reason),
            terminal_at = $8::timestamptz,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = $8::timestamptz
        WHERE id = $1
        RETURNING *
      `,
      [
        input.ticketId,
        input.status,
        input.resultJson ? JSON.stringify(input.resultJson) : null,
        input.createdMemoryId ?? null,
        input.candidateMemoryId ?? null,
        input.duplicateOfMemoryId ?? null,
        input.failureReason ?? null,
        now,
      ]
    );
    if (!row) throw new Error(`Write ticket not found: ${input.ticketId}`);
    return mapWriteTicketRow(row);
  }

  async failExpired(tx: WriteTransactionContext): Promise<number> {
    const now = tx.now();
    if (isInMemoryTransactionContext(tx)) {
      let count = 0;
      const nextRows = tx.state.writeTickets.map((row) => {
        if (
          (row.status !== "pending_extraction" && row.status !== "processing_extraction") ||
          row.expiresAt > now
        ) return row;
        count += 1;
        return {
          ...row,
          status: "failed_extraction" as const,
          failureReason: "async_ticket_timeout",
          terminalAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        };
      });
      tx.state.writeTickets.splice(0, tx.state.writeTickets.length, ...nextRows);
      return count;
    }
    const rows = await tx.query(
      `
        UPDATE write_tickets
        SET status = 'failed_extraction',
            failure_reason = 'async_ticket_timeout',
            terminal_at = $1::timestamptz,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = $1::timestamptz
        WHERE status IN ('pending_extraction', 'processing_extraction') AND expires_at <= $1::timestamptz
        RETURNING id
      `,
      [now]
    );
    return rows.length;
  }

  async claimNext(tx: WriteTransactionContext, input: ClaimWriteTicketInput): Promise<WriteTicketRow[]> {
    const now = tx.now();
    const leaseTtlSeconds = input.leaseTtlSeconds ?? 120;
    const leaseExpiresAt = addSecondsIso(now, leaseTtlSeconds);
    const limit = Math.max(1, Math.min(50, input.limit ?? 1));
    if (isInMemoryTransactionContext(tx)) {
      const claimable = tx.state.writeTickets
        .filter((row) => {
          if (row.terminalAt !== null || row.expiresAt <= now) return false;
          if (row.status === "pending_extraction") {
            return row.nextAttemptAt === null || row.nextAttemptAt <= now;
          }
          return row.status === "processing_extraction" &&
            (row.leaseExpiresAt === null || row.leaseExpiresAt <= now) &&
            (row.nextAttemptAt === null || row.nextAttemptAt <= now);
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
      const claimed: WriteTicketRow[] = [];
      for (const ticket of claimable) {
        const index = tx.state.writeTickets.findIndex((row) => row.id === ticket.id);
        if (index < 0) continue;
        const next: WriteTicketRow = {
          ...tx.state.writeTickets[index],
          status: "processing_extraction",
          leaseOwner: input.workerId,
          leaseExpiresAt,
          attempts: tx.state.writeTickets[index].attempts + 1,
          updatedAt: now
        };
        tx.state.writeTickets[index] = next;
        claimed.push(next);
      }
      return claimed;
    }

    const rows = await tx.query(
      `
        WITH claimable AS (
          SELECT id
          FROM write_tickets
          WHERE terminal_at IS NULL
            AND expires_at > $1::timestamptz
            AND (
              (status = 'pending_extraction' AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz))
              OR
              (status = 'processing_extraction'
                AND (lease_expires_at IS NULL OR lease_expires_at <= $1::timestamptz)
                AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz))
            )
          ORDER BY created_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        UPDATE write_tickets
        SET status = 'processing_extraction',
            lease_owner = $3,
            lease_expires_at = $4::timestamptz,
            attempts = attempts + 1,
            updated_at = $1::timestamptz
        WHERE id IN (SELECT id FROM claimable)
        RETURNING *
      `,
      [now, limit, input.workerId, leaseExpiresAt]
    );
    return rows.map(mapWriteTicketRow);
  }

  async heartbeat(
    tx: WriteTransactionContext,
    ticketId: string,
    workerId: string,
    leaseTtlSeconds = 120
  ): Promise<WriteTicketRow | null> {
    const now = tx.now();
    const leaseExpiresAt = addSecondsIso(now, leaseTtlSeconds);
    if (isInMemoryTransactionContext(tx)) {
      const index = tx.state.writeTickets.findIndex((row) => row.id === ticketId && row.leaseOwner === workerId);
      if (index < 0) return null;
      const row: WriteTicketRow = {
        ...tx.state.writeTickets[index],
        leaseExpiresAt,
        updatedAt: now
      };
      tx.state.writeTickets[index] = row;
      return row;
    }
    const [row] = await tx.query(
      `
        UPDATE write_tickets
        SET lease_expires_at = $3::timestamptz,
            updated_at = $4::timestamptz
        WHERE id = $1 AND lease_owner = $2 AND status = 'processing_extraction'
        RETURNING *
      `,
      [ticketId, workerId, leaseExpiresAt, now]
    );
    return row ? mapWriteTicketRow(row) : null;
  }
}
