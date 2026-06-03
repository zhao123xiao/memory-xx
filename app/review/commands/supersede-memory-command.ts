import {
  type MemoryRelationInput,
  type MemorySourceInput
} from "../../shared/contracts/write";
import { InvalidInputError } from "../../shared/errors/write-errors";
import { ReviewState, type JsonObject } from "../../shared/types";
import {
  type NormalizedBaseMemoryLifecycleCommand,
  hashReviewCommand,
  normalizeBaseMemoryLifecycleCommand,
  normalizeJsonObject,
  normalizeOptionalString,
  requireTrimmedString,
  serializeReviewCommand
} from "./review-command-utils";

export interface SupersedeMemoryCommand {
  readonly requestId: string;
  readonly actorId: string;
  readonly memoryId: string;
  readonly content: string;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly metadata?: JsonObject | null;
  readonly dedupeKey?: string | null;
  readonly reviewState?: ReviewState.Approved | ReviewState.SilentApproved | ReviewState.NotRequired;
  readonly sources?: readonly MemorySourceInput[];
  readonly relations?: readonly MemoryRelationInput[];
}

export interface NormalizedSupersedeMemoryCommand
  extends NormalizedBaseMemoryLifecycleCommand {
  readonly content: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly metadata: JsonObject;
  readonly dedupeKey: string | null;
  readonly reviewState: ReviewState.Approved | ReviewState.SilentApproved | ReviewState.NotRequired;
  readonly sources: readonly MemorySourceInput[];
  readonly relations: readonly MemoryRelationInput[];
}

export function normalizeSupersedeMemoryCommand(
  command: SupersedeMemoryCommand
): NormalizedSupersedeMemoryCommand {
  const normalized = normalizeBaseMemoryLifecycleCommand(command);
  const reviewState = command.reviewState ?? ReviewState.Approved;

  if (reviewState !== ReviewState.Approved && reviewState !== ReviewState.SilentApproved && reviewState !== ReviewState.NotRequired) {
    throw new InvalidInputError("Supersede reviewState must be approved, silent_approved, or not_required.", {
      reviewState
    });
  }

  return {
    ...normalized,
    content: requireTrimmedString(command.content, "content"),
    title: normalizeOptionalString(command.title),
    summary: normalizeOptionalString(command.summary),
    metadata: normalizeJsonObject(command.metadata ?? {}),
    dedupeKey: normalizeOptionalString(command.dedupeKey),
    reviewState,
    sources: command.sources ?? [],
    relations: command.relations ?? []
  };
}

export function serializeSupersedeMemoryCommand(
  command: NormalizedSupersedeMemoryCommand
): string {
  return serializeReviewCommand(command);
}

export function hashSupersedeMemoryCommand(
  command: NormalizedSupersedeMemoryCommand
): string {
  return hashReviewCommand(command);
}
