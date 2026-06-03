import {
  hashCommandPayload,
  normalizeJsonObject,
  normalizeOptionalString,
  requireTrimmedString,
  stableStringify
} from "../../shared/command-serialization";

export interface BaseMemoryLifecycleCommand {
  readonly requestId: string;
  readonly actorId: string;
  readonly memoryId: string;
}

export interface NormalizedBaseMemoryLifecycleCommand {
  readonly requestId: string;
  readonly actorId: string;
  readonly memoryId: string;
}

export function normalizeBaseMemoryLifecycleCommand(
  command: BaseMemoryLifecycleCommand
): NormalizedBaseMemoryLifecycleCommand {
  return {
    requestId: requireTrimmedString(command.requestId, "requestId"),
    actorId: requireTrimmedString(command.actorId, "actorId"),
    memoryId: requireTrimmedString(command.memoryId, "memoryId")
  };
}

export function serializeReviewCommand(command: unknown): string {
  return stableStringify(command);
}

export function hashReviewCommand(command: unknown): string {
  return hashCommandPayload(serializeReviewCommand(command));
}

export {
  normalizeJsonObject,
  normalizeOptionalString,
  requireTrimmedString
};
