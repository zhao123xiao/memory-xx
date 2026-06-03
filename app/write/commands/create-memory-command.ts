import {
  canCreateMemoryWithState,
  isLongTermScopeType,
  type CreateMemoryCommand,
  type MemorySourceInput,
  type NormalizedCreateMemoryCommand
} from "../../shared/contracts/write";
import {
  InvalidCreateStateError,
  InvalidInputError,
  InvalidScopeTypeError
} from "../../shared/errors/write-errors";
import {
  hashCommandPayload,
  normalizeJsonObject,
  normalizeOptionalString,
  requireTrimmedString,
  stableStringify
} from "../../shared/command-serialization";
import { LifecycleStatus, ReviewState, type JsonObject, type JsonValue } from "../../shared/types";
import { createHash } from "node:crypto";

interface WriteHygieneDecision {
  readonly checked: true;
  readonly policy: "lightweight_v2";
  readonly score: number;
  readonly reasons: readonly string[];
  readonly action: "approved" | "candidate" | "rejected";
}

function extractMemoryTypeFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const match = title.match(/^\[(FACT|DECISION|LESSON|CONSTRAINT|PREFERENCE|STATUS)(?::(\w+))?\]/i);
  if (!match) return null;
  const map: Record<string, string> = {
    FACT: "fact",
    DECISION: "decision",
    LESSON: "lesson",
    CONSTRAINT: "constraint",
    PREFERENCE: "preference",
    STATUS: "status"
  };
  return map[match[1].toUpperCase()] ?? null;
}

export function normalizeCreateMemoryCommand(
  command: CreateMemoryCommand
): NormalizedCreateMemoryCommand {
  const requestId = requireTrimmedString(command.requestId, "requestId");
  const actorId = requireTrimmedString(command.actorId, "actorId");
  const scopeId = requireTrimmedString(command.scopeId, "scopeId");
  const content = requireTrimmedString(command.content, "content");

  if (!isLongTermScopeType(command.scopeType)) {
    throw new InvalidScopeTypeError(command.scopeType);
  }

  if (!canCreateMemoryWithState(command.lifecycleStatus, command.reviewState)) {
    throw new InvalidCreateStateError({
      lifecycleStatus: command.lifecycleStatus,
      reviewState: command.reviewState
    });
  }
  const metadata = normalizeJsonObject(command.metadata ?? {});
  const hygiene = evaluateWriteHygiene({
    content,
    title: command.title,
    metadata,
  });
  if (hygiene.action === "rejected") {
    throw new InvalidInputError(`content failed write hygiene: ${hygiene.reasons.join(",")}`);
  }
  const sources = normalizeMemorySources(command, requestId, actorId, scopeId, content);
  const metadataWithTrust = withTrustMetadata(metadata, sources, hygiene);
  const effectiveLifecycleStatus =
    hygiene.action === "candidate" && command.lifecycleStatus === LifecycleStatus.Approved
      ? LifecycleStatus.Candidate
      : command.lifecycleStatus;
  const effectiveReviewState =
    hygiene.action === "candidate" && command.lifecycleStatus === LifecycleStatus.Approved
      ? ReviewState.Pending
      : command.reviewState;
  const explicitDedupeKey = normalizeOptionalString(command.dedupeKey);
  if (explicitDedupeKey && explicitDedupeKey.length > 256) {
    throw new InvalidInputError("dedupeKey must not exceed 256 characters.");
  }
  const dedupeKey = explicitDedupeKey
    ? scopeDedupeKey(command.scopeType, scopeId, explicitDedupeKey)
    : generateDedupeKey(command.scopeType, scopeId, content);
  const observedAt = normalizeOptionalIsoString(command.observedAt ?? readString(metadata, "observed_at") ?? readString(metadata, "observedAt"));
  const validAt = normalizeOptionalIsoString(command.validAt ?? readString(metadata, "valid_at") ?? readString(metadata, "validAt"));
  const expiresAt = normalizeOptionalIsoString(command.expiresAt ?? readString(metadata, "expires_at") ?? readString(metadata, "expiresAt"));

  return {
    requestId,
    actorId,
    scopeType: command.scopeType,
    scopeId,
    content,
    title: normalizeOptionalString(command.title),
    summary: normalizeOptionalString(command.summary),
    metadata: metadataWithTrust,
    dedupeKey,
    tenantId: normalizeOptionalString(command.tenantId) ?? "default",
    agentId: normalizeOptionalString(command.agentId) ?? actorId,
    governanceStatus: normalizeOptionalString(command.governanceStatus) ?? "normal",
    visibility: normalizeOptionalString(command.visibility) ?? deriveVisibility(command.scopeType),
    memoryType: normalizeOptionalString(command.memoryType)
      ?? normalizeOptionalString((command.metadata ?? {}).memory_type as string | null | undefined)
      ?? extractMemoryTypeFromTitle(command.title),
    contentEmbedding: Array.isArray(command.contentEmbedding) ? [...command.contentEmbedding] : null,
    validAt,
    observedAt,
    expiresAt,
    lifecycleStatus: effectiveLifecycleStatus,
    reviewState: effectiveReviewState,
    sources,
    relations: command.relations ?? []
  };
}

function normalizeOptionalIsoString(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidInputError("temporal fields must be valid ISO date strings.");
  }
  return parsed.toISOString();
}

function evaluateWriteHygiene(input: {
  readonly content: string;
  readonly title?: string | null;
  readonly metadata: JsonObject;
}): WriteHygieneDecision {
  const normalized = input.content.replace(/\s+/g, " ").trim().toLowerCase();
  const reasons: string[] = [];
  let score = 1;

  const source = normalizeOptionalString(
    readString(input.metadata, "source") ??
    readString(input.metadata, "source_type") ??
    readString(input.metadata, "sourceType")
  )?.toLowerCase() ?? "";
  const isExplicitTestSource =
    source === "test" ||
    source.includes("test-fixture") ||
    input.metadata.fixture === true ||
    input.metadata.test_fixture === true;

  const metaOnlyPhrases = new Set([
    "记住",
    "记住这个",
    "记住这句话",
    "用户说",
    "user said",
    "the user says",
    "remember this",
  ]);
  if (metaOnlyPhrases.has(normalized)) {
    reasons.push("meta_only_phrase");
    score = Math.min(score, 0.35);
  }

  if (!isExplicitTestSource && /(?:test pollution fixture|dummy memory fixture|lorem ipsum)/iu.test(input.content)) {
    reasons.push("suspected_test_pollution");
    score = Math.min(score, 0.25);
  }

  if (normalized.length < 2) {
    reasons.push("too_short");
    score = Math.min(score, 0.05);
  } else if (normalized.length < 8) {
    reasons.push("low_information_short_content");
    score = Math.min(score, 0.45);
  }

  if (input.content.length > 200_000) {
    reasons.push("abnormally_long_content");
    score = Math.min(score, 0.05);
  }

  if (isExplicitTestSource) {
    reasons.push("explicit_test_source");
  }

  const action: WriteHygieneDecision["action"] =
    score < 0.10 || input.content.length > 200_000
      ? "rejected"
      : score < 0.60
        ? "candidate"
        : "approved";

  return {
    checked: true,
    policy: "lightweight_v2",
    score,
    reasons,
    action: isExplicitTestSource && action === "candidate" ? "approved" : action,
  };
}

export function serializeCreateMemoryCommand(
  command: NormalizedCreateMemoryCommand
): string {
  return stableStringify(command);
}

export function hashCreateMemoryCommand(
  command: NormalizedCreateMemoryCommand
): string {
  return hashCommandPayload(serializeCreateMemoryCommand(command));
}

function generateDedupeKey(scopeType: string, scopeId: string, content: string): string {
  const contentHash = createHash("sha256").update(content).digest("hex").substring(0, 16);
  return `${scopeType}:${scopeId}:${contentHash}`;
}

function scopeDedupeKey(scopeType: string, scopeId: string, dedupeKey: string): string {
  const prefix = `${scopeType}:${scopeId}:`;
  return dedupeKey.startsWith(prefix) ? dedupeKey : `${prefix}${dedupeKey}`;
}

function deriveVisibility(scopeType: string): string {
  if (scopeType === "user") return "private";
  if (scopeType === "project") return "scope_only";
  if (scopeType === "workspace") return "shared_readable";
  return "scope_only";
}

function normalizeMemorySources(
  command: CreateMemoryCommand,
  requestId: string,
  actorId: string,
  scopeId: string,
  content: string
): readonly MemorySourceInput[] {
  const explicitSources = (command.sources ?? [])
    .map(normalizeMemorySource)
    .filter((source): source is MemorySourceInput => source !== null);
  if (explicitSources.length > 0) {
    return explicitSources;
  }

  const metadata = normalizeJsonObject(command.metadata ?? {});
  const metadataSource = normalizeOptionalString(readString(metadata, "source"));
  const runtimeOrigin = normalizeOptionalString(readString(metadata, "runtimeOrigin") ?? readString(metadata, "runtime_origin"));
  const sessionId = normalizeOptionalString(readString(metadata, "sessionId") ?? readString(metadata, "session_id"));
  const sessionKey = normalizeOptionalString(readString(metadata, "sessionKey") ?? readString(metadata, "session_key"));
  const capturedAt = normalizeOptionalString(readString(metadata, "capturedAt") ?? readString(metadata, "captured_at"));
  const sourceType = metadataSource ?? runtimeOrigin ?? "memory-xx-write";
  const sourceIdentity = sessionId ?? sessionKey ?? requestId;

  return [
    {
      sourceType,
      uri: `${sourceType}://${sourceIdentity}`,
      excerpt: content.slice(0, 500),
      confidence: 1,
      capturedAt,
      metadata: compactJsonObject({
        synthesized: true,
        requestId,
        actorId,
        scopeType: command.scopeType,
        scopeId,
        runtimeOrigin,
        sessionId,
        sessionKey
      })
    }
  ];
}

function normalizeMemorySource(source: MemorySourceInput): MemorySourceInput | null {
  const sourceType = normalizeOptionalString(source.sourceType);
  if (!sourceType) {
    return null;
  }
  return {
    sourceType,
    uri: normalizeOptionalString(source.uri) ?? null,
    excerpt: normalizeOptionalString(source.excerpt) ?? null,
    confidence: source.confidence ?? null,
    capturedAt: normalizeOptionalString(source.capturedAt) ?? null,
    metadata: normalizeJsonObject(source.metadata ?? {})
  };
}

function withTrustMetadata(
  metadata: JsonObject,
  sources: readonly MemorySourceInput[],
  hygiene: WriteHygieneDecision
): JsonObject {
  const explicitSourceType = normalizeOptionalString(
    readString(metadata, "source_type") ?? readString(metadata, "sourceType")
  );
  const sourceType = explicitSourceType ?? classifySourceType(sources[0]?.sourceType ?? readString(metadata, "source") ?? "user_direct");
  const explicitTrustLevel = normalizeOptionalString(
    readString(metadata, "trust_level") ?? readString(metadata, "trustLevel")
  );
  const trustLevel = explicitTrustLevel ?? defaultTrustLevel(sourceType);
  return {
    ...metadata,
    write_hygiene: hygiene as unknown as JsonObject,
    source_type: sourceType,
    trust_level: trustLevel,
  };
}

function classifySourceType(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return "user_direct";
  if (value.includes("external") || value.includes("web") || value.startsWith("http")) return "external_webpage";
  if (value.includes("import") || value.includes("file")) return "imported_file";
  if (value.includes("transcript") || value.includes("chat")) return "chat_transcript";
  if (value.includes("tool")) return "tool_output";
  if (value.includes("assistant") || value.includes("inferred")) return "assistant_inferred";
  if (value.includes("memory-xx-write") || value.includes("unified-api") || value.includes("user")) return "user_direct";
  return value;
}

function defaultTrustLevel(sourceType: string): string {
  if (sourceType === "user_direct") return "trusted_user_direct";
  if (sourceType === "assistant_inferred") return "assistant_inferred";
  if (
    sourceType === "external_webpage" ||
    sourceType === "imported_file" ||
    sourceType === "chat_transcript" ||
    sourceType === "tool_output"
  ) {
    return "untrusted_external";
  }
  return "legacy_unclassified";
}

function readString(metadata: JsonObject, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

function compactJsonObject(input: Record<string, JsonValue | undefined>): JsonObject {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) {
      output[key] = value;
    }
  }
  return output;
}
