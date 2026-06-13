export type CognitiveType = "semantic" | "episodic" | "procedural" | "audit";

export interface CognitiveTypeInput {
  readonly memory_type?: string | null;
  readonly memory_layer?: string | null;
  readonly recall_policy?: string | null;
  readonly memory_class?: string | null;
  readonly assistant_memory_kind?: string | null;
}

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function inferCognitiveType(input: CognitiveTypeInput): CognitiveType {
  const recallPolicy = normalize(input.recall_policy);
  const memoryLayer = normalize(input.memory_layer);
  const memoryType = normalize(input.memory_type);
  const memoryClass = normalize(input.memory_class);
  const assistantMemoryKind = normalize(input.assistant_memory_kind);

  if (
    recallPolicy === "never" ||
    recallPolicy === "audit_only" ||
    memoryLayer === "audit" ||
    memoryClass === "audit_evidence" ||
    memoryClass === "runtime_noise" ||
    memoryClass === "explicit_no_memory" ||
    memoryClass === "unknown_source_quarantine" ||
    memoryClass === "test_evidence"
  ) {
    return "audit";
  }
  if (
    memoryLayer === "episodic" ||
    memoryType === "episode" ||
    memoryType === "status" ||
    memoryType === "progress" ||
    memoryClass === "operational_issue" ||
    assistantMemoryKind === "proposed_plan" ||
    assistantMemoryKind === "status_snapshot" ||
    assistantMemoryKind === "completion_summary" ||
    assistantMemoryKind === "test_report"
  ) {
    return "episodic";
  }
  if (
    memoryLayer === "procedural" ||
    memoryType === "procedure" ||
    memoryType === "procedural" ||
    memoryType === "ops_learning" ||
    memoryType === "runbook" ||
    memoryClass === "procedure"
  ) {
    return "procedural";
  }
  return "semantic";
}
