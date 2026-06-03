import {
  type BaseMemoryLifecycleCommand,
  type NormalizedBaseMemoryLifecycleCommand,
  hashReviewCommand,
  normalizeBaseMemoryLifecycleCommand,
  serializeReviewCommand
} from "./review-command-utils";

export interface TombstoneMemoryCommand extends BaseMemoryLifecycleCommand {}

export interface NormalizedTombstoneMemoryCommand extends NormalizedBaseMemoryLifecycleCommand {}

export function normalizeTombstoneMemoryCommand(
  command: TombstoneMemoryCommand
): NormalizedTombstoneMemoryCommand {
  return normalizeBaseMemoryLifecycleCommand(command);
}

export function serializeTombstoneMemoryCommand(
  command: NormalizedTombstoneMemoryCommand
): string {
  return serializeReviewCommand(command);
}

export function hashTombstoneMemoryCommand(
  command: NormalizedTombstoneMemoryCommand
): string {
  return hashReviewCommand(command);
}
