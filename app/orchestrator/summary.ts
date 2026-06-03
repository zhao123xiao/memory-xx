import type { RecallResponse } from "../recall/types";
import type { SummarizeMemoryResponse } from "./types";

export function summarizeRecallResults(response: RecallResponse, maxItems: number): SummarizeMemoryResponse["summary"] {
  const used = response.results.slice(0, Math.max(1, maxItems));
  const lines = used.map((item, index) => {
    const title = item.title?.trim() || `memory ${item.memory_id}`;
    const excerpt = item.content.replace(/\s+/g, " ").trim().slice(0, 160);
    return `${index + 1}. [${item.scope.type}:${item.scope.id}] ${title} — ${excerpt}`;
  });
  return {
    text:
      lines.length > 0
        ? `Found ${response.results.length} relevant memories.\n${lines.join("\n")}`
        : "No matching memories found.",
    total_results: response.results.length,
    used_results: used.length,
    memory_ids: used.map((item) => item.memory_id),
    audit_ref: response.audit_ref,
    degraded: response.degraded,
  };
}
