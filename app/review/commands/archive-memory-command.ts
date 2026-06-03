import {
  type BaseMemoryLifecycleCommand,
  type NormalizedBaseMemoryLifecycleCommand,
  hashReviewCommand,
  normalizeBaseMemoryLifecycleCommand,
  serializeReviewCommand
} from "./review-command-utils";

export interface ArchiveMemoryCommand extends BaseMemoryLifecycleCommand {}

export interface NormalizedArchiveMemoryCommand extends NormalizedBaseMemoryLifecycleCommand {}

export function normalizeArchiveMemoryCommand(
  command: ArchiveMemoryCommand
): NormalizedArchiveMemoryCommand {
  return normalizeBaseMemoryLifecycleCommand(command);
}

export function serializeArchiveMemoryCommand(
  command: NormalizedArchiveMemoryCommand
): string {
  return serializeReviewCommand(command);
}

export function hashArchiveMemoryCommand(command: NormalizedArchiveMemoryCommand): string {
  return hashReviewCommand(command);
}
