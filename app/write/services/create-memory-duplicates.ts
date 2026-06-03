import type { JsonObject } from "../../shared/types";

export function readMetadataString(metadata: JsonObject | undefined, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function sourceIdentity(input: {
  readonly metadata?: JsonObject;
  readonly sources?: readonly { readonly uri?: string | null }[];
  readonly sourceRef?: string | null;
}): { source: string; block: string } {
  const metadata = input.metadata ?? {};
  const source = readMetadataString(metadata, "canonical_source_path", "source_path", "source_ref", "uri") ||
    (typeof input.sourceRef === "string" ? input.sourceRef.trim() : "") ||
    (input.sources?.[0]?.uri?.trim() ?? "");
  const block = readMetadataString(metadata, "canonical_section", "section", "block_id");
  return { source, block };
}

export function textSimilarity(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return (2 * overlap) / (leftTokens.size + rightTokens.size);
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

export function readDedupeEmbeddingThreshold(): number {
  const raw = process.env.MEMORY_V2_INTELLIGENCE_DEDUPE_EMBEDDING_THRESHOLD?.trim();
  if (!raw) return 0.92;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 1) {
    throw new Error("MEMORY_V2_INTELLIGENCE_DEDUPE_EMBEDDING_THRESHOLD 必须在 0.5 到 1 之间。");
  }
  return parsed;
}
