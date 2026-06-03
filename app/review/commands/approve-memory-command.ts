import {
  type BaseMemoryLifecycleCommand,
  type NormalizedBaseMemoryLifecycleCommand,
  hashReviewCommand,
  normalizeBaseMemoryLifecycleCommand,
  serializeReviewCommand
} from "./review-command-utils";

export interface ApproveMemoryCommand extends BaseMemoryLifecycleCommand {}

export interface NormalizedApproveMemoryCommand extends NormalizedBaseMemoryLifecycleCommand {}

export function normalizeApproveMemoryCommand(
  command: ApproveMemoryCommand
): NormalizedApproveMemoryCommand {
  return normalizeBaseMemoryLifecycleCommand(command);
}

export function serializeApproveMemoryCommand(
  command: NormalizedApproveMemoryCommand
): string {
  return serializeReviewCommand(command);
}

export function hashApproveMemoryCommand(command: NormalizedApproveMemoryCommand): string {
  return hashReviewCommand(command);
}
