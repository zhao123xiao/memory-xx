import type { JsonObject } from "../shared/types";

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isFixtureMetadata(metadata: JsonObject | null | undefined): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const source = normalize(metadata.source);
  return metadata.fixture === true ||
    source === "l18-graph-recall" ||
    source.includes("test-fixture") ||
    source.includes("test-harness");
}

export function isGraphTestFixture(input: {
  readonly sourceMetadata?: JsonObject | null;
  readonly targetMetadata?: JsonObject | null;
  readonly relationMetadata?: JsonObject | null;
  readonly sourceCreatedBy?: string | null;
  readonly sourceAgentId?: string | null;
  readonly targetCreatedBy?: string | null;
  readonly targetAgentId?: string | null;
  readonly relationId?: string | null;
  readonly sourceTitle?: string | null;
  readonly targetTitle?: string | null;
  readonly sourceLifecycleStatus?: string | null;
  readonly sourceIsCurrent?: boolean | null;
  readonly targetLifecycleStatus?: string | null;
  readonly targetIsCurrent?: boolean | null;
}): boolean {
  const text = [
    input.sourceCreatedBy,
    input.sourceAgentId,
    input.targetCreatedBy,
    input.targetAgentId,
    input.relationId,
    input.sourceTitle,
    input.targetTitle,
  ].map(normalize).join("\n");
  const sourceTombstoned = normalize(input.sourceLifecycleStatus) === "tombstone" || input.sourceIsCurrent === false;
  const targetTombstoned = normalize(input.targetLifecycleStatus) === "tombstone" || input.targetIsCurrent === false;
  return isFixtureMetadata(input.sourceMetadata) ||
    isFixtureMetadata(input.targetMetadata) ||
    isFixtureMetadata(input.relationMetadata) ||
    text.includes("l18-graph-recall") ||
    text.includes("cross-layer e2e test") ||
    text.includes("[l18 graph fixture]") ||
    text.includes("test-harness") ||
    (text.includes("main") && sourceTombstoned && targetTombstoned && text.includes("e2e"));
}
