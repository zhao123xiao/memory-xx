import type { CoordinationFailure, IdempotencyRecord } from "../types";

export interface StartIdempotencyInput {
  readonly key: string;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly now: number;
}

export interface FinishIdempotencyInput {
  readonly key: string;
  readonly ownerId: string;
  readonly now: number;
  readonly result?: unknown;
}

export interface FailIdempotencyInput {
  readonly key: string;
  readonly ownerId: string;
  readonly now: number;
  readonly retriable: boolean;
  readonly failure: CoordinationFailure;
}

export interface IdempotencyPort {
  start(input: StartIdempotencyInput): Promise<IdempotencyRecord>;
  succeed(input: FinishIdempotencyInput): Promise<IdempotencyRecord>;
  fail(input: FailIdempotencyInput): Promise<IdempotencyRecord>;
  getIdempotency(key: string): Promise<IdempotencyRecord | null>;
}
