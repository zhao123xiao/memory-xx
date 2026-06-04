import { IntelligenceService } from "../../intelligence/service";
import type { ExtractedMemory } from "../../intelligence/types";
import { cosineSimilarity } from "../../intelligence/semantic-write-lock";
import { MemoryRecordRepository } from "../../db/repositories/memory-record-repository";
import { withWriteTransaction } from "../../db/tx/write-transaction";
import { LifecycleStatus, type JsonObject } from "../../shared";
import { loadMemoryXXQdrantConfig } from "../../recall/qdrant-config";
import { readRuntimeControlNumberSync } from "../../runtime-control-settings";
import * as runtime from "../../server/runtime";
import { resolveScopeType } from "./request-parsing";

function recordTopic(record: { metadata?: JsonObject | null }): string | null {
  const value = record.metadata?.topic;
  return typeof value === "string" ? value : null;
}

function recordMemoryType(record: { metadata?: JsonObject | null; memoryType?: string | null }): string | null {
  const value = record.metadata?.memory_type;
  return typeof value === "string" ? value : record.memoryType ?? null;
}

function isVisibleCurrent(record: { lifecycleStatus: string; isCurrent: boolean }): boolean {
  return record.isCurrent && !["tombstone", "rejected", "archived", "superseded"].includes(record.lifecycleStatus);
}

function tokenizeContext(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/u)) {
    if (token.length >= 2) tokens.add(token);
  }
  return tokens;
}

function scoreExistingMemory(record: { content: string; title?: string | null; metadata?: JsonObject | null }, tokens: Set<string>): number {
  const haystack = [
    record.content,
    record.title ?? "",
    typeof record.metadata?.topic === "string" ? record.metadata.topic : "",
    typeof record.metadata?.memory_type === "string" ? record.metadata.memory_type : "",
  ].join(" ").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function normalizedMemoryText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

export function shouldTreatConversationDuplicateAsNoChange(
  memory: ExtractedMemory,
  semantic: { readonly action: string; readonly score?: number },
): boolean {
  if (memory.conflict_action !== "create" || memory.operation === "update" || memory.operation === "merge") return false;
  return semantic.action === "merge_or_supersede" && Number(semantic.score ?? 0) >= 0.92;
}

export function coalesceConversationMemories(memories: readonly ExtractedMemory[]): ExtractedMemory[] {
  const groups = new Map<string, ExtractedMemory[]>();
  for (const memory of memories) {
    const key = `${memory.scope_type}\0${memory.scope_id}\0${memory.memory_type}\0${memory.topic}`;
    const group = groups.get(key) ?? [];
    group.push(memory);
    groups.set(key, group);
  }
  const output: ExtractedMemory[] = [];
  for (const group of groups.values()) {
    if (group.length <= 1) {
      output.push(group[0]!);
      continue;
    }
    const compactGroup = group.filter((memory) => memory.canonical_content.length <= 220);
    if (compactGroup.length !== group.length) {
      output.push(...group);
      continue;
    }
    const first = group[0]!;
    const contents = [...new Set(group.map((memory) => memory.canonical_content.trim()).filter(Boolean))];
    const titles = [...new Set(group.map((memory) => memory.title).filter(Boolean))];
    output.push({
      ...first,
      canonical_content: contents.join("\n"),
      content: contents.join("\n"),
      title: titles[0] ?? first.title,
      confidence: Math.min(...group.map((memory) => memory.confidence)),
      coalesced_from_count: group.length,
      coalesced_candidate_titles: titles,
      coalesced_candidate_contents: contents,
    });
  }
  return output;
}

export async function embedCanonicalContent(content: string): Promise<readonly number[] | null> {
  try {
    const embedded = await runtime.queryEmbeddingProvider?.embed_query({
      query: content.slice(0, 2000),
      query_terms: [],
    });
    return embedded?.embedding && embedded.embedding.length > 0 ? embedded.embedding : null;
  } catch {
    return null;
  }
}

export async function semanticPreflight(memory: ExtractedMemory, embedding: readonly number[] | null): Promise<{
  readonly action: "none" | "skip" | "merge_review" | "merge_or_supersede" | "cross_scope_flag";
  readonly existing_memory_id?: string;
  readonly score?: number;
  readonly source: "qdrant" | "pg" | "embedding" | "dedupe_key";
  readonly degraded_reason?: string;
}> {
  const db = runtime.writeDatabase;
  if (!db) return { action: "none", source: "pg" };
  const qdrant = await qdrantSemanticPreflight(memory, embedding);
  if (qdrant.action !== "none") {
    if (!qdrant.existing_memory_id || await isCurrentRecallableMemoryId(qdrant.existing_memory_id)) return qdrant;
  }
  const now = Date.now();
  const recentCutoff = now - 5 * 60 * 1000;
  const sameScope = await withWriteTransaction(db, (tx) => new MemoryRecordRepository().listSmartWriteCandidates(tx, {
    scopeType: memory.scope_type,
    scopeId: memory.scope_id,
    memoryType: memory.memory_type,
    dedupeKey: memory.dedupe_key,
    topic: memory.topic,
    recentCandidateSince: new Date(recentCutoff).toISOString(),
    limit: 80
  }));

  const dedupeHit = sameScope.find((record) => record.dedupeKey === memory.dedupe_key);
  if (dedupeHit) {
    const exact = normalizedMemoryText(dedupeHit.content) === normalizedMemoryText(memory.canonical_content);
    return {
      action: exact ? "skip" : "merge_or_supersede",
      existing_memory_id: dedupeHit.id,
      score: exact ? 1 : undefined,
      source: "dedupe_key",
    };
  }

  if (embedding && embedding.length > 0) {
    let best: { id: string; score: number } | null = null;
    for (const record of sameScope) {
      const existingEmbedding = record.contentEmbedding;
      if (!existingEmbedding || existingEmbedding.length === 0) continue;
      const score = cosineSimilarity(embedding, existingEmbedding);
      if (!best || score > best.score) best = { id: record.id, score };
    }
    if (best) {
      if (best.score >= 0.95) return { action: "skip", existing_memory_id: best.id, score: best.score, source: "embedding" };
      if (best.score >= 0.85) return { action: "merge_or_supersede", existing_memory_id: best.id, score: best.score, source: "embedding" };
      if (best.score >= 0.70) return { action: "merge_review", existing_memory_id: best.id, score: best.score, source: "embedding" };
    }
  }

  return { action: "none", source: "pg", degraded_reason: qdrant.degraded_reason };
}

async function isCurrentRecallableMemoryId(memoryId: string): Promise<boolean> {
  const db = runtime.writeDatabase;
  if (!db) return false;
  const record = await withWriteTransaction(db, (tx) => new MemoryRecordRepository().findById(tx, memoryId));
  return Boolean(record && record.lifecycleStatus === LifecycleStatus.Approved && isVisibleCurrent(record));
}

async function qdrantSemanticPreflight(
  memory: ExtractedMemory,
  embedding: readonly number[] | null,
): Promise<{
  readonly action: "none" | "skip" | "merge_review" | "merge_or_supersede" | "cross_scope_flag";
  readonly existing_memory_id?: string;
  readonly score?: number;
  readonly source: "qdrant";
  readonly degraded_reason?: string;
}> {
  if (!embedding || embedding.length === 0) return { action: "none", source: "qdrant" };
  const config = loadMemoryXXQdrantConfig();
  if (!config.base_url || !config.collection_name) return { action: "none", source: "qdrant" };
  const controller = new AbortController();
  const envTimeoutMs = Number.parseInt(process.env.MEMORY_XX_SMART_WRITE_QDRANT_PREFLIGHT_TIMEOUT_MS ?? "200", 10);
  const timeoutMs = readRuntimeControlNumberSync("write.smart_write.qdrant_preflight_timeout_ms", envTimeoutMs);
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 200);
  try {
    const response = await fetch(
      `${config.base_url.replace(/\/$/, "")}/collections/${encodeURIComponent(config.collection_name)}/points/search`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(config.api_key ? { "api-key": config.api_key } : {}),
        },
        body: JSON.stringify({
          vector: embedding,
          limit: 3,
          with_payload: true,
          with_vector: false,
          filter: {
            must: [
              { key: "scope_type", match: { value: memory.scope_type } },
              { key: "scope_id", match: { value: memory.scope_id } },
              { key: "memory_type", match: { value: memory.memory_type } },
              { key: "recallable", match: { value: true } },
            ],
          },
        }),
      },
    );
    if (!response.ok) return { action: "none", source: "qdrant", degraded_reason: `qdrant_http_${response.status}` };
    const body = await response.json() as { result?: unknown; points?: unknown };
    const points = Array.isArray(body.result)
      ? body.result
      : Array.isArray(body.points)
        ? body.points
        : [];
    let best: { id: string; score: number } | null = null;
    for (const point of points) {
      if (!point || typeof point !== "object") continue;
      const raw = point as { score?: unknown; payload?: unknown };
      const score = typeof raw.score === "number" ? raw.score : 0;
      const payload = raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
        ? raw.payload as Record<string, unknown>
        : {};
      const id = typeof payload.memory_id === "string" ? payload.memory_id : "";
      if (!id) continue;
      if (!best || score > best.score) best = { id, score };
    }
    if (!best) return { action: "none", source: "qdrant" };
    if (best.score >= 0.95) return { action: "skip", existing_memory_id: best.id, score: best.score, source: "qdrant" };
    if (best.score >= 0.85) return { action: "merge_or_supersede", existing_memory_id: best.id, score: best.score, source: "qdrant" };
    if (best.score >= 0.70) return { action: "merge_review", existing_memory_id: best.id, score: best.score, source: "qdrant" };
    return { action: "none", source: "qdrant" };
  } catch (error) {
    return {
      action: "none",
      source: "qdrant",
      degraded_reason: error instanceof Error && error.name === "AbortError" ? "qdrant_timeout" : "qdrant_unavailable"
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function loadExistingMemoryContext(
  text: string,
  scopeHint: { scope_type: string; scope_id: string } | undefined,
): Promise<Array<{ id: string; content: string; title?: string | null; memory_type?: string | null; topic?: string | null }>> {
  const db = runtime.writeDatabase;
  if (!db || !scopeHint) return [];
  const scopeType = resolveScopeType(scopeHint.scope_type);
  const tokens = tokenizeContext(text);
  const candidates = await withWriteTransaction(db, (tx) => new MemoryRecordRepository().listSmartWriteCandidates(tx, {
    scopeType,
    scopeId: scopeHint.scope_id,
    limit: 80
  }));
  return candidates
    .filter((record) =>
      record.scopeType === scopeType &&
      record.scopeId === scopeHint.scope_id &&
      record.lifecycleStatus === LifecycleStatus.Approved &&
      isVisibleCurrent(record),
    )
    .map((record) => ({ record, score: scoreExistingMemory(record, tokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ record }) => ({
      id: record.id,
      content: record.content,
      title: record.title,
      memory_type: recordMemoryType(record),
      topic: recordTopic(record),
    }));
}

export async function enrichConflicts(service: IntelligenceService, memories: ExtractedMemory[]): Promise<ExtractedMemory[]> {
  const db = runtime.writeDatabase;
  if (!db || memories.length === 0) return memories;
  const enriched: ExtractedMemory[] = [];
  for (const memory of memories) {
    const candidates = await withWriteTransaction(db, (tx) => new MemoryRecordRepository().listSmartWriteCandidates(tx, {
      scopeType: memory.scope_type,
      scopeId: memory.scope_id,
      memoryType: memory.memory_type,
      dedupeKey: memory.dedupe_key,
      topic: memory.topic,
      limit: 20
    }));
    const existing = candidates.find((record) => {
      if (!isVisibleCurrent(record)) return false;
      if (record.scopeType !== memory.scope_type || record.scopeId !== memory.scope_id) return false;
      if (record.dedupeKey && record.dedupeKey === memory.dedupe_key) return true;
      return recordMemoryType(record) === memory.memory_type && recordTopic(record) === memory.topic;
    });
    if (!existing) {
      enriched.push(memory);
      continue;
    }
    enriched.push(await service.resolveConflict(memory, {
      id: existing.id,
      content: existing.content,
      title: existing.title,
      memory_type: recordMemoryType(existing),
      topic: recordTopic(existing),
    }));
  }
  return enriched;
}
