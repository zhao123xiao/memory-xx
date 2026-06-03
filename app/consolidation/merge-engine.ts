import { createLogger } from "../shared/logger";

const log = createLogger("merge-engine");

export interface MergeCandidate {
  readonly memory_ids: readonly string[];
  readonly contents: readonly string[];
  readonly scope_type: string;
  readonly scope_id: string;
}

export interface MergeResult {
  readonly merged_content: string;
  readonly source_ids: readonly string[];
}

export function mergeContents(candidates: MergeCandidate): MergeResult {
  const seen = new Set<string>();
  const uniqueContents: string[] = [];
  for (const content of candidates.contents) {
    const normalized = content.trim().toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      uniqueContents.push(content.trim());
    }
  }
  if (uniqueContents.length === 1) {
    return { merged_content: uniqueContents[0], source_ids: candidates.memory_ids };
  }
  const merged = uniqueContents.join(String.fromCharCode(10,10,45,45,45,10,10));
  return { merged_content: merged, source_ids: candidates.memory_ids };
}
