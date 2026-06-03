import type { ExtractedMemory, ConflictResult, MemoryType } from "./types";

const CONFLICT_STRATEGIES: Record<MemoryType, "merge" | "supersede" | "create"> = {
  preference: "merge",
  fact: "supersede",
  decision: "supersede",
  procedure: "create",
  constraint: "merge",
};

export function resolveConflictRules(newMemory: ExtractedMemory): ConflictResult {
  const strategy = CONFLICT_STRATEGIES[newMemory.memory_type] ?? "create";
  return {
    action: strategy,
    reason: newMemory.memory_type + " default strategy: " + strategy,
  };
}
