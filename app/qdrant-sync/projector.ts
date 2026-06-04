import type {
  MemoryRecordRow,
  MemoryRelationRow,
  MemorySourceRow,
  WriteDatabaseState
} from "../db/schema/tables";
import { createHash } from "node:crypto";

/** Fallback embedding dimension when no env/manifest-derived dimension is configured. */
export const EXPECTED_VECTOR_DIMENSION = 4096 as const;
import type { WriteTransactionRunner } from "../db/tx/write-transaction";
import { projectionLifecycleOperation } from "../governance";
import { recordQdrantTimeout } from "../observability/qdrant-health";
import type { StoredWriteResult } from "../shared/contracts/write";
import type { JsonObject, JsonValue } from "../shared/types";

export interface QdrantPointPayloadRelation {
  readonly related_memory_id: string;
  readonly relation_type: string;
  readonly direction: "outbound" | "bidirectional";
  readonly weight?: number;
}

export interface QdrantPointPayloadSource {
  readonly source_type: string;
  readonly uri?: string;
  readonly excerpt?: string;
  readonly confidence?: number;
  readonly captured_at?: string;
}

export interface MemoryQdrantPointPayload {
  readonly memory_id: string;
  readonly request_id: string;
  readonly title?: string;
  readonly content: string;
  readonly summary?: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly project_id?: string;
  readonly workspace_id?: string;
  readonly source_path?: string;
  readonly source_type?: string;
  readonly trust_level?: string;
  readonly section?: string;
  readonly canonical_section?: string;
  readonly canonical_source_path?: string;
  readonly category?: string;
  readonly memory_type?: string;
  readonly memory_class?: string;
  readonly recall_policy?: string;
  readonly policy_action?: string;
  readonly memory_layer?: string;
  readonly fact_status?: string;
  readonly valid_at?: string;
  readonly invalid_at?: string;
  readonly observed_at?: string;
  readonly expires_at?: string;
  readonly episode_id?: string;
  readonly importance?: number;
  readonly memory_strength?: number;
  readonly decay_policy?: string;
  readonly tags?: readonly string[];
  readonly entity_names?: readonly string[];
  readonly lexical_terms?: readonly string[];
  readonly semantic_terms?: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly lifecycle_status: string;
  readonly review_state: string;
  readonly is_current: boolean;
  readonly recallable: boolean;
  readonly archived?: boolean;
  readonly superseded?: boolean;
  readonly version: number;
  readonly source_count: number;
  readonly relation_count: number;
  readonly sources?: readonly QdrantPointPayloadSource[];
  readonly relations?: readonly QdrantPointPayloadRelation[];
  readonly projection_hash?: string;
  readonly embedding_provider?: string;
  readonly embedding_model?: string;
  readonly embedding_precision?: string;
  readonly embedding_dimension?: number;
  readonly embedding_generation?: string;
  readonly embedding_text_strategy?: string;
}

export interface QdrantPointUpsert {
  readonly id: string;
  readonly vector: readonly number[];
  readonly payload: MemoryQdrantPointPayload;
}

export interface QdrantProjectionSyncResultItem {
  readonly memoryId: string;
  readonly operation: "upsert" | "delete" | "skip";
  readonly reason:
    | "effective_recallable"
    | "record_missing"
    | "not_effective_recallable"
    | "tombstone"
    | "superseded"
    | "embedding_missing"
    | "projection_idempotent"
    | "projection_verify_failed";
}

export interface QdrantProjectionSyncResult {
  readonly items: readonly QdrantProjectionSyncResultItem[];
}

function normalizeUuidLike(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function uuidFromBytes(bytes: Iterable<number>): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export function mapMemoryIdToQdrantPointId(memoryId: string): string {
  const direct = normalizeUuidLike(memoryId);
  if (direct) {
    return direct;
  }

  const suffixMatch = memoryId.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/);
  if (suffixMatch) {
    const suffix = normalizeUuidLike(suffixMatch[1] ?? "");
    if (suffix) {
      return suffix;
    }
  }

  const source = Buffer.from(memoryId, "utf8");
  const digest = new Uint8Array(16);
  for (let index = 0; index < source.length; index += 1) {
    digest[index % 16] = digest[index % 16] ^ source[index]!;
  }
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  return uuidFromBytes(digest);
}

export interface QdrantPointWriter {
  upsert(points: readonly QdrantPointUpsert[]): Promise<void>;
  delete(pointIds: readonly string[]): Promise<void>;
  retrieve?(pointIds: readonly string[]): Promise<ReadonlyMap<string, { readonly payload?: Record<string, unknown> }>>;
}

export interface QdrantProjectionEmbeddingResolver {
  resolve(input: {
    readonly memory: MemoryRecordRow;
    readonly snapshot: WriteDatabaseState;
  }): Promise<readonly number[] | null> | readonly number[] | null;
}

export interface QdrantProjectionSyncServiceOptions {
  readonly database: WriteTransactionRunner;
  readonly pointWriter: QdrantPointWriter;
  readonly embeddingResolver?: QdrantProjectionEmbeddingResolver;
}

function asJsonObject(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function readString(metadata: JsonObject, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}

function readStringArray(metadata: JsonObject, ...keys: readonly string[]): string[] | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      const strings = value.filter((item): item is string => typeof item === "string");
      if (strings.length > 0) {
        return strings;
      }
    }
  }

  return undefined;
}

function readNumberArray(metadata: JsonObject, ...keys: readonly string[]): number[] | null {
  for (const key of keys) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      const numbers = value.filter((item): item is number => typeof item === "number");
      if (numbers.length === value.length && numbers.length > 0) {
        return numbers;
      }
    }
  }

  return null;
}

function pickProjectId(memory: MemoryRecordRow, metadata: JsonObject): string | undefined {
  return readString(metadata, "project_id", "projectId") ??
    (memory.scopeType === "project" ? memory.scopeId : undefined);
}

function pickWorkspaceId(memory: MemoryRecordRow, metadata: JsonObject): string | undefined {
  return readString(metadata, "workspace_id", "workspaceId") ??
    (memory.scopeType === "workspace" ? memory.scopeId : undefined);
}

function mapSources(rows: readonly MemorySourceRow[]): readonly QdrantPointPayloadSource[] | undefined {
  if (rows.length === 0) {
    return undefined;
  }

  return rows.map((row) => ({
    source_type: row.sourceType,
    uri: row.uri ?? undefined,
    excerpt: row.excerpt ?? undefined,
    confidence: row.confidence ?? undefined,
    captured_at: row.capturedAt ?? undefined
  }));
}

function mapRelations(rows: readonly MemoryRelationRow[]): readonly QdrantPointPayloadRelation[] | undefined {
  if (rows.length === 0) {
    return undefined;
  }

  return rows.map((row) => ({
    related_memory_id: row.relatedMemoryId,
    relation_type: row.relationType,
    direction: row.direction,
    weight: row.weight ?? undefined
  }));
}

function buildPayload(
  memory: MemoryRecordRow,
  sources: readonly MemorySourceRow[],
  relations: readonly MemoryRelationRow[]
): MemoryQdrantPointPayload {
  const metadata = memory.metadata ?? {};
  const legacyMetadata = asJsonObject(metadata.legacy as JsonValue | undefined);
  const firstSource = sources[0];

  return {
    memory_id: memory.id,
    request_id: memory.requestId,
    title: memory.title ?? undefined,
    content: memory.content,
    summary: memory.summary ?? undefined,
    scope_type: memory.scopeType,
    scope_id: memory.scopeId,
    project_id: pickProjectId(memory, metadata),
    workspace_id: pickWorkspaceId(memory, metadata),
    source_path: firstSource?.uri ?? firstSource?.excerpt ?? `memory:${memory.id}`,
    source_type: readString(metadata, "source_type", "sourceType") ?? firstSource?.sourceType ?? undefined,
    trust_level: readString(metadata, "trust_level", "trustLevel"),
    section:
      readString(metadata, "section", "section_path", "sectionPath") ??
      readString(legacyMetadata, "section"),
    canonical_section:
      readString(metadata, "canonical_section", "canonicalSection") ??
      readString(legacyMetadata, "canonical_section", "canonicalSection"),
    canonical_source_path:
      readString(metadata, "canonical_file_path", "canonicalFilePath") ??
      readString(legacyMetadata, "canonical_file_path", "canonicalFilePath", "file_path", "filePath"),
    category: readString(metadata, "category"),
    memory_type: readString(metadata, "memory_type", "memoryType"),
    memory_class: readString(metadata, "memory_class", "memoryClass"),
    recall_policy: readString(metadata, "recall_policy", "recallPolicy"),
    policy_action: readString(metadata, "policy_action", "policyAction"),
    memory_layer: memory.memoryLayer,
    fact_status: memory.factStatus,
    valid_at: memory.validAt ?? undefined,
    invalid_at: memory.invalidAt ?? undefined,
    observed_at: memory.observedAt ?? undefined,
    expires_at: memory.expiresAt ?? undefined,
    episode_id: memory.episodeId ?? undefined,
    importance: memory.importance,
    memory_strength: memory.memoryStrength,
    decay_policy: memory.decayPolicy,
    tags: readStringArray(metadata, "tags"),
    entity_names: readStringArray(metadata, "entity_names", "entityNames"),
    lexical_terms: readStringArray(metadata, "lexical_terms", "lexicalTerms"),
    semantic_terms: readStringArray(metadata, "semantic_terms", "semanticTerms"),
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
    lifecycle_status: memory.lifecycleStatus,
    review_state: memory.reviewState,
    is_current: memory.isCurrent,
    recallable: projectionLifecycleOperation(memory) === "upsert_recallable" &&
      !["explicit_only", "audit_only", "test_only", "never"].includes(readString(metadata, "recall_policy", "recallPolicy") ?? "default"),
    archived: memory.lifecycleStatus === "archived" ? true : undefined,
    superseded: memory.lifecycleStatus === "superseded" ? true : undefined,
    version: memory.version,
    source_count: sources.length,
    relation_count: relations.length,
    sources: mapSources(sources),
    relations: mapRelations(relations),
    embedding_provider: process.env.MEMORY_XX_EMBEDDING_PROVIDER?.trim() || undefined,
    embedding_model: process.env.EMBEDDING_MODEL?.trim() || undefined,
    embedding_precision: process.env.MEMORY_XX_EMBEDDING_PRECISION?.trim() || undefined,
    embedding_dimension: Number.parseInt(process.env.EMBEDDING_DIMS?.trim() || String(EXPECTED_VECTOR_DIMENSION), 10),
    embedding_generation: memory.embeddingGeneration ?? (process.env.MEMORY_XX_EMBEDDING_GENERATION_ID?.trim() || undefined),
    embedding_text_strategy: process.env.MEMORY_XX_EMBEDDING_TEXT_STRATEGY?.trim() || undefined
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

function expectedVectorDimension(): number {
  const raw = process.env.EMBEDDING_DIMS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : EXPECTED_VECTOR_DIMENSION;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : EXPECTED_VECTOR_DIMENSION;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timeoutError(reason: string): Error {
  const error = new Error(reason);
  error.name = "TimeoutError";
  return error;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(reason)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withProjectionHash(payload: MemoryQdrantPointPayload, vector: readonly number[]): MemoryQdrantPointPayload {
  const hashInput = {
    payload: { ...payload, projection_hash: undefined },
    vector_dimension: vector.length,
    vector_head: vector.slice(0, 8),
  };
  const projectionHash = createHash("sha256").update(stableStringify(hashInput)).digest("hex");
  return { ...payload, projection_hash: projectionHash };
}

async function resolveEmbedding(
  memory: MemoryRecordRow,
  snapshot: WriteDatabaseState,
  embeddingResolver?: QdrantProjectionEmbeddingResolver
): Promise<readonly number[] | null> {
  if (memory.contentEmbedding && memory.contentEmbedding.length > 0) {
    return memory.contentEmbedding;
  }

  const resolved = await embeddingResolver?.resolve({ memory, snapshot });
  if (resolved && resolved.length > 0) {
    return resolved;
  }

  const fallback = readNumberArray(memory.metadata ?? {}, "embedding", "content_embedding", "qdrant_vector");
  // Reject wrong-dimension or degenerate (single-nonzero-value) placeholder vectors from metadata fallbacks.
  if (fallback && fallback.length > 0) {
    if (fallback.length !== expectedVectorDimension()) return null;
    // Detect placeholder / smoke-test artifacts: vectors that are 99.9%+ zero.
    const nonzeroCount = (fallback as readonly number[]).filter(v => v !== 0).length;
    if (nonzeroCount / fallback.length < 0.001) return null;
  }
  return fallback;
}

export class QdrantProjectionSyncService {
  private readonly database: WriteTransactionRunner;
  private readonly pointWriter: QdrantPointWriter;
  private readonly embeddingResolver?: QdrantProjectionEmbeddingResolver;
  private readonly verifyTimeoutMs: number;
  private readonly verifyRetries: number;
  private readonly verifyReadbackEnabled: boolean;

  constructor(options: QdrantProjectionSyncServiceOptions) {
    this.database = options.database;
    this.pointWriter = options.pointWriter;
    this.embeddingResolver = options.embeddingResolver;
    this.verifyTimeoutMs = readPositiveIntEnv("MEMORY_XX_QDRANT_VERIFY_TIMEOUT_MS", 1200);
    this.verifyRetries = readPositiveIntEnv("MEMORY_XX_QDRANT_VERIFY_RETRIES", 2);
    this.verifyReadbackEnabled = process.env.MEMORY_XX_QDRANT_VERIFY_READBACK === "true";
  }

  async syncWriteResult(result: StoredWriteResult): Promise<QdrantProjectionSyncResult> {
    const targetIds = [...new Set(result.affectedMemoryIds ?? [result.memoryId])];
    return this.syncMemoryIds(targetIds);
  }

  async syncMemoryIds(memoryIds: readonly string[]): Promise<QdrantProjectionSyncResult> {
    const snapshot = await this.database.snapshotForMemoryIds(memoryIds);
    const upserts: QdrantPointUpsert[] = [];
    const deletes: string[] = [];
    const items: QdrantProjectionSyncResultItem[] = [];

    for (const memoryId of memoryIds) {
      const memory = snapshot.memoryRecords.find((row) => row.id === memoryId);
      if (!memory) {
        deletes.push(mapMemoryIdToQdrantPointId(memoryId));
        items.push({ memoryId, operation: "delete", reason: "record_missing" });
        continue;
      }

      const lifecycleOperation = projectionLifecycleOperation(memory);
      if (lifecycleOperation === "delete_point") {
        deletes.push(mapMemoryIdToQdrantPointId(memoryId));
        items.push({
          memoryId,
          operation: "delete",
          reason: memory.lifecycleStatus === "tombstone"
            ? "tombstone"
            : memory.lifecycleStatus === "superseded"
              ? "superseded"
              : "not_effective_recallable"
        });
        continue;
      }

      if (lifecycleOperation === "skip") {
        items.push({ memoryId, operation: "skip", reason: "not_effective_recallable" });
        continue;
      }

      const embedding = await resolveEmbedding(memory, snapshot, this.embeddingResolver);
      if (!embedding || embedding.length === 0) {
        items.push({ memoryId, operation: "skip", reason: "embedding_missing" });
        continue;
      }

      const sources = snapshot.memorySources.filter((row) => row.memoryId === memoryId);
      const relations = snapshot.memoryRelations.filter((row) => row.memoryId === memoryId);
      const payload = withProjectionHash(buildPayload(memory, sources, relations), embedding);
      upserts.push({
        id: mapMemoryIdToQdrantPointId(memoryId),
        vector: embedding,
        payload
      });
      items.push({
        memoryId,
        operation: "upsert",
        reason: "effective_recallable"
      });
    }

    const idempotentMemoryIds = await this.findIdempotentUpserts(upserts);
    const upsertsToWrite = upserts.filter((point) => !idempotentMemoryIds.has(point.payload.memory_id));
    if (idempotentMemoryIds.size > 0) {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item.operation === "upsert" && idempotentMemoryIds.has(item.memoryId)) {
          items[index] = {
            memoryId: item.memoryId,
            operation: "skip",
            reason: "projection_idempotent",
          };
        }
      }
    }

    if (upsertsToWrite.length > 0) {
      await this.pointWriter.upsert(upsertsToWrite);
      const verifyFailedMemoryIds = this.verifyReadbackEnabled
        ? await this.verifyReadback(upsertsToWrite)
        : new Set<string>();
      if (verifyFailedMemoryIds.size > 0) {
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (item.operation === "upsert" && verifyFailedMemoryIds.has(item.memoryId)) {
            items[index] = {
              memoryId: item.memoryId,
              operation: "skip",
              reason: "projection_verify_failed",
            };
          }
        }
      }
    }
    if (deletes.length > 0) {
      await this.pointWriter.delete(deletes);
    }

    return { items };
  }

  private async findIdempotentUpserts(upserts: readonly QdrantPointUpsert[]): Promise<Set<string>> {
    const idempotent = new Set<string>();
    if (!this.pointWriter.retrieve || upserts.length === 0) return idempotent;
    let points: ReadonlyMap<string, { readonly payload?: Record<string, unknown> }>;
    try {
      points = await this.pointWriter.retrieve(upserts.map((point) => point.id));
    } catch {
      return idempotent;
    }
    for (const point of upserts) {
      const actual = points.get(point.id);
      if (actual?.payload?.projection_hash === point.payload.projection_hash) {
        idempotent.add(point.payload.memory_id);
      }
    }
    return idempotent;
  }

  private async verifyReadback(upserts: readonly QdrantPointUpsert[]): Promise<Set<string>> {
    const failed = new Set<string>();
    if (!this.pointWriter.retrieve || upserts.length === 0) return failed;
    const pending = new Map(upserts.map((point) => [point.id, point]));
    for (let attempt = 0; attempt <= this.verifyRetries && pending.size > 0; attempt += 1) {
      let points: ReadonlyMap<string, { readonly payload?: Record<string, unknown> }>;
      try {
        points = await withTimeout(
          this.pointWriter.retrieve([...pending.keys()]),
          this.verifyTimeoutMs,
          "qdrant_verify_timeout"
        );
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.message === "qdrant_verify_timeout")) {
          recordQdrantTimeout("write");
        }
        if (attempt >= this.verifyRetries) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * (attempt + 1), 750)));
        continue;
      }

      for (const [pointId, point] of [...pending.entries()]) {
        const actual = points.get(pointId);
        const actualHash = actual?.payload?.projection_hash;
        if (actualHash === point.payload.projection_hash) {
          pending.delete(pointId);
        }
      }

      if (pending.size > 0 && attempt < this.verifyRetries) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * (attempt + 1), 750)));
      }
    }
    for (const point of pending.values()) failed.add(point.payload.memory_id);
    return failed;
  }
}
