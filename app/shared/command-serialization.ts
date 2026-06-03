import { createHash } from "node:crypto";

import { InvalidInputError } from "./errors/write-errors";
import type { JsonObject, JsonValue } from "./types";

export function hashCommandPayload(payloadJson: string): string {
  return createHash("sha256").update(payloadJson).digest("hex");
}

export function requireTrimmedString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new InvalidInputError(`${fieldName} is required.`);
  }

  return trimmed;
}

export function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeJsonObject(input: JsonObject): JsonObject {
  return JSON.parse(stableStringify(input)) as JsonObject;
}

export function stableStringify(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

  const entries = Object.entries(value as Record<string, JsonValue>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}
