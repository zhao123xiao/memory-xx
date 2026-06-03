import type { OutboxEventType, ScopeType, JsonObject } from "../../shared";
import type { BumpGenerationInput } from "../ports";
import { GenerationKind, PriorityLane, type CoordinationScopeRef } from "../types";
import { CoordinationTaskType } from "../task-types";

export interface CoordinationDispatchEvent {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly requestId: string;
  readonly eventType: OutboxEventType;
  readonly payloadVersion: number;
  readonly createdAt: string;
  readonly payload: JsonObject;
}

export interface PlannedCoordinationTask {
  readonly taskId: string;
  readonly taskType: CoordinationTaskType;
  readonly priority: PriorityLane;
  readonly scopes: readonly CoordinationScopeRef[];
  readonly payload?: unknown;
  readonly dedupeKey?: string;
  readonly idempotencyKey?: string;
  readonly singleFlightKey?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CoordinationDispatchPlan {
  readonly generationBumps: readonly BumpGenerationInput[];
  readonly tasks: readonly PlannedCoordinationTask[];
}

const SCOPE_GENERATION_EVENTS = new Set<string>([
  "memory.created",
  "memory.updated",
  "memory.feedback.recorded",
  "memory.lifecycle.changed",
  "memory.review.changed",
  "memory.superseded",
  "memory.tombstoned",
  "memory.relation.changed",
  "memory.source.changed",
  "cache.invalidate.requested"
]);

function asObjectArray(value: JsonObject[keyof JsonObject] | undefined): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is JsonObject => {
    return typeof item === "object" && item !== null && !Array.isArray(item);
  });
}

function asString(value: JsonObject[keyof JsonObject] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asPriorityLane(
  value: JsonObject[keyof JsonObject] | undefined,
  fallback: PriorityLane
): PriorityLane {
  if (typeof value !== "string") {
    return fallback;
  }

  return (Object.values(PriorityLane) as string[]).includes(value)
    ? (value as PriorityLane)
    : fallback;
}

function uniqueScopes(scopes: readonly CoordinationScopeRef[]): CoordinationScopeRef[] {
  const seen = new Set<string>();
  const unique: CoordinationScopeRef[] = [];

  for (const scope of scopes) {
    const key = `${scope.type}:${scope.id}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(scope);
  }

  return unique;
}

function parseScopes(payload: JsonObject): CoordinationScopeRef[] {
  const scopes = asObjectArray(payload.scopes).flatMap((scope): CoordinationScopeRef[] => {
    const type = asString(scope.type);
    const id = asString(scope.id);
    if (type === undefined || id === undefined) {
      return [];
    }

    return [{ type: type as ScopeType, id }];
  });

  const directType = asString(payload.scopeType);
  const directId = asString(payload.scopeId);
  if (directType !== undefined && directId !== undefined) {
    scopes.push({
      type: directType as ScopeType,
      id: directId
    });
  }

  return uniqueScopes(scopes);
}

function buildScopeToken(scopes: readonly CoordinationScopeRef[]): string {
  return scopes
    .map((scope) => `${scope.type}:${scope.id}`)
    .sort((left, right) => left.localeCompare(right))
    .join("|");
}

function buildTaskMetadata(
  event: CoordinationDispatchEvent
): Readonly<Record<string, string | number | boolean | null>> {
  return {
    sourceEventId: event.eventId,
    sourceEventType: event.eventType,
    requestId: event.requestId
  };
}

export function buildCoordinationDispatchPlan(
  event: CoordinationDispatchEvent,
  now: number
): CoordinationDispatchPlan {
  const scopes = parseScopes(event.payload);
  const generationBumps: BumpGenerationInput[] = [];
  const tasks: PlannedCoordinationTask[] = [];

  if (event.eventType === "memory.embedding.refreshed") {
    for (const scope of scopes) {
      generationBumps.push({
        key: {
          kind: GenerationKind.Vector,
          scopeType: scope.type,
          scopeId: scope.id
        },
        now,
        reason: event.eventType,
        sourceEventId: event.eventId
      });
    }
  } else if (SCOPE_GENERATION_EVENTS.has(event.eventType)) {
    for (const scope of scopes) {
      generationBumps.push({
        key: {
          kind: GenerationKind.Scope,
          scopeType: scope.type,
          scopeId: scope.id
        },
        now,
        reason: event.eventType,
        sourceEventId: event.eventId
      });
    }
  }

  if (event.eventType === "projection.rebuild.requested" && scopes.length > 0) {
    const scopeToken = buildScopeToken(scopes);
    tasks.push({
      taskId: `${event.eventId}:${CoordinationTaskType.ProjectionExport}`,
      taskType: CoordinationTaskType.ProjectionExport,
      priority: asPriorityLane(event.payload.priority, PriorityLane.P2Normal),
      scopes,
      payload: event.payload,
      dedupeKey: `projection.export:${scopeToken}`,
      idempotencyKey: `projection.export:event:${event.eventId}`,
      singleFlightKey: `projection.export:${scopeToken}`,
      metadata: buildTaskMetadata(event)
    });
  }

  if (event.eventType === "cache.invalidate.requested" && scopes.length > 0) {
    const scopeToken = buildScopeToken(scopes);
    tasks.push({
      taskId: `${event.eventId}:${CoordinationTaskType.CacheInvalidate}`,
      taskType: CoordinationTaskType.CacheInvalidate,
      priority: asPriorityLane(event.payload.priority, PriorityLane.P1High),
      scopes,
      payload: event.payload,
      dedupeKey: `cache.invalidate:${scopeToken}`,
      idempotencyKey: `cache.invalidate:event:${event.eventId}`,
      singleFlightKey: `cache.invalidate:${scopeToken}`,
      metadata: buildTaskMetadata(event)
    });
  }

  return {
    generationBumps,
    tasks
  };
}
