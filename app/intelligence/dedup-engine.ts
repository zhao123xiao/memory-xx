import type { MemoryType } from "./types";

export function computeDedupeKey(scopeType: string, scopeId: string, memoryType: MemoryType, topic: string): string {
  return `${scopeType}:${scopeId}:${memoryType}:${topic.toLowerCase().trim()}`;
}
