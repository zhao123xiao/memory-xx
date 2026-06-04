import { createHash } from "node:crypto";

import type { ProjectionStableIdInput } from "../types";

function normalizeStableIdPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildStableProjectionId(input: ProjectionStableIdInput): string {
  const normalizedParts = input.keyParts.map((part) => normalizeStableIdPart(part)).filter(Boolean);

  if (normalizedParts.length === 0) {
    throw new Error("stable projection id requires at least one non-empty key part");
  }

  return [input.view, input.grain, ...normalizedParts].join(":");
}

export function hashStableProjectionId(stableId: string): string {
  return createHash("sha1").update(stableId).digest("hex").slice(0, 8);
}
