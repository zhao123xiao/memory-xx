import type { JsonObject } from "../../shared/types";
import {
  hashReviewCommand,
  normalizeJsonObject,
  normalizeOptionalString,
  requireTrimmedString,
  serializeReviewCommand
} from "./review-command-utils";

export interface UpdateCandidateMemoryCommand {
  readonly requestId: string;
  readonly actorId: string;
  readonly memoryId: string;
  readonly content: string;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly metadata?: JsonObject | null;
  readonly dedupeKey?: string | null;
  readonly memoryType?: string | null;
  readonly contentEmbedding?: readonly number[] | null;
}

export interface NormalizedUpdateCandidateMemoryCommand {
  readonly requestId: string;
  readonly actorId: string;
  readonly memoryId: string;
  readonly content: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly metadata: JsonObject;
  readonly dedupeKey: string | null;
  readonly memoryType: string | null;
  readonly contentEmbedding: readonly number[] | null;
}

export function normalizeUpdateCandidateMemoryCommand(
  command: UpdateCandidateMemoryCommand
): NormalizedUpdateCandidateMemoryCommand {
  return {
    requestId: requireTrimmedString(command.requestId, "requestId"),
    actorId: requireTrimmedString(command.actorId, "actorId"),
    memoryId: requireTrimmedString(command.memoryId, "memoryId"),
    content: requireTrimmedString(command.content, "content"),
    title: normalizeOptionalString(command.title),
    summary: normalizeOptionalString(command.summary),
    metadata: normalizeJsonObject(command.metadata ?? {}),
    dedupeKey: normalizeOptionalString(command.dedupeKey),
    memoryType: normalizeOptionalString(command.memoryType),
    contentEmbedding: command.contentEmbedding ?? null,
  };
}

export function serializeUpdateCandidateMemoryCommand(
  command: NormalizedUpdateCandidateMemoryCommand
): string {
  return serializeReviewCommand(command);
}

export function hashUpdateCandidateMemoryCommand(
  command: NormalizedUpdateCandidateMemoryCommand
): string {
  return hashReviewCommand(command);
}
