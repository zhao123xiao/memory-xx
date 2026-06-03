import type {
  RequestRegistrationResult,
  RegisteredIngestRequest,
  StoredWriteResult,
  WriteCommandType
} from "../../shared/contracts/write";
import { IngestRequestStatus } from "../../shared/contracts/write";
import {
  RequestAlreadyFailedError,
  RequestAlreadyInFlightError,
  RequestPayloadConflictError,
  type WriteError
} from "../../shared/errors/write-errors";
import { IngestRequestRepository } from "../../db/repositories/ingest-request-repository";
import {
  type WriteTransactionContext,
  type WriteTransactionRunner,
  withWriteTransaction
} from "../../db/tx/write-transaction";

export interface RegisterRequestInput {
  readonly requestId: string;
  readonly commandType: WriteCommandType;
  readonly payloadHash: string;
  readonly payloadJson: string;
  readonly actorId: string;
}

export class RequestIdempotencyService {
  constructor(
    private readonly database: WriteTransactionRunner,
    private readonly ingestRequestRepository = new IngestRequestRepository()
  ) {}

  async register<TResult extends StoredWriteResult>(
    input: RegisterRequestInput
  ): Promise<RequestRegistrationResult<TResult>> {
    return withWriteTransaction(this.database, async (tx) => {
      const existing = await this.ingestRequestRepository.findByRequestId(tx, input.requestId);
      if (!existing) {
        const request: RegisteredIngestRequest = {
          requestId: input.requestId,
          commandType: input.commandType,
          payloadHash: input.payloadHash,
          payloadJson: input.payloadJson,
          actorId: input.actorId
        };

        const inserted = await this.ingestRequestRepository.insertAccepted(tx, request);
        if (inserted) {
          return {
            kind: "accepted",
            request
          };
        }

        return this.resolveExistingRequest<TResult>(tx, input.requestId, input.payloadHash);
      }

      return this.resolvePersistedRequest<TResult>(tx, existing, input.requestId, input.payloadHash);
    });
  }

  async markFailed(
    requestId: string,
    error: WriteError
  ): Promise<void> {
    await withWriteTransaction(this.database, async (tx) => {
      await this.ingestRequestRepository.markFailed(tx, requestId, error.code, error.message);
    });
  }

  private async resolveExistingRequest<TResult extends StoredWriteResult>(
    tx: WriteTransactionContext,
    requestId: string,
    payloadHash: string
  ): Promise<RequestRegistrationResult<TResult>> {
    const existing = await this.ingestRequestRepository.findByRequestId(tx, requestId);
    if (!existing) {
      throw new RequestAlreadyInFlightError(requestId);
    }

    return this.resolvePersistedRequest<TResult>(tx, existing, requestId, payloadHash);
  }

  private async resolvePersistedRequest<TResult extends StoredWriteResult>(
    tx: WriteTransactionContext,
    existing: NonNullable<Awaited<ReturnType<IngestRequestRepository["findByRequestId"]>>>,
    requestId: string,
    payloadHash: string
  ): Promise<RequestRegistrationResult<TResult>> {
    await this.ingestRequestRepository.touch(tx, requestId);

    if (existing.payloadHash !== payloadHash) {
      throw new RequestPayloadConflictError(requestId);
    }

    if (existing.status === IngestRequestStatus.Completed && existing.result) {
      return {
        kind: "replayed",
        requestId,
        storedResult: existing.result as TResult
      };
    }

    if (existing.status === IngestRequestStatus.Failed) {
      if (
        existing.recoverable &&
        (existing.recoverableAfter === null || existing.recoverableAfter <= tx.now())
      ) {
        const recovered = await this.ingestRequestRepository.recoverAccepted(tx, requestId);
        if (recovered) {
          return {
            kind: "accepted",
            request: {
              requestId: recovered.requestId,
              commandType: recovered.commandType,
              payloadHash: recovered.payloadHash,
              payloadJson: recovered.payloadJson,
              actorId: recovered.actorId
            }
          };
        }
      }
      throw new RequestAlreadyFailedError(requestId);
    }

    throw new RequestAlreadyInFlightError(requestId);
  }
}
