import {
  type BaseMemoryLifecycleCommand,
  type NormalizedBaseMemoryLifecycleCommand,
  hashReviewCommand,
  normalizeBaseMemoryLifecycleCommand,
  serializeReviewCommand
} from "./review-command-utils";

export interface RejectMemoryCommand extends BaseMemoryLifecycleCommand {}

export interface NormalizedRejectMemoryCommand extends NormalizedBaseMemoryLifecycleCommand {}

export function normalizeRejectMemoryCommand(
  command: RejectMemoryCommand
): NormalizedRejectMemoryCommand {
  return normalizeBaseMemoryLifecycleCommand(command);
}

export function serializeRejectMemoryCommand(
  command: NormalizedRejectMemoryCommand
): string {
  return serializeReviewCommand(command);
}

export function hashRejectMemoryCommand(command: NormalizedRejectMemoryCommand): string {
  return hashReviewCommand(command);
}
