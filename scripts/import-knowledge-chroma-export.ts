import fs from "node:fs";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { loadMemoryV2PostgresConfig, createPostgresPoolConfig } from "../app/db/adapters/postgres-config";
import { buildKnowledgeDocumentId, mapKnowledgeChunkIdToPointId } from "../app/knowledge/service";

interface ExportLine {
  id: string;
  collection: string;
  document: string;
  metadata: Record<string, unknown>;
  embedding: number[];
}

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("Usage: node --import tsx scripts/import-knowledge-chroma-export.ts <chroma-export.jsonl>");
}

const qdrantBase = process.env.MEMORY_V2_QDRANT_BASE_URL?.replace(/\/+$/, "");
const qdrantCollection = process.env.MEMORY_V2_KNOWLEDGE_QDRANT_COLLECTION?.trim() || "knowledge-v1";
const qdrantApiKey = process.env.MEMORY_V2_QDRANT_API_KEY?.trim();
const batchSize = Number.parseInt(process.env.MEMORY_V2_KNOWLEDGE_IMPORT_BATCH_SIZE || "64", 10);

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashEmbedding(values: readonly number[]): string {
  return createHash("sha256").update(values.map((value) => Number(value).toPrecision(8)).join(",")).digest("hex");
}

async function ensureQdrantCollection(): Promise<void> {
  if (!qdrantBase) throw new Error("MEMORY_V2_QDRANT_BASE_URL is not configured.");
  const get = await fetch(`${qdrantBase}/collections/${encodeURIComponent(qdrantCollection)}`, {
    headers: qdrantApiKey ? { "api-key": qdrantApiKey } : undefined
  });
  if (get.ok) return;
  const create = await fetch(`${qdrantBase}/collections/${encodeURIComponent(qdrantCollection)}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(qdrantApiKey ? { "api-key": qdrantApiKey } : {})
    },
    body: JSON.stringify({
      vectors: { size: 4096, distance: "Cosine" },
      on_disk_payload: true
    })
  });
  if (!create.ok) throw new Error(`Qdrant collection create failed: ${create.status} ${await create.text()}`);
}

async function upsertQdrant(points: unknown[]): Promise<void> {
  if (points.length === 0) return;
  const response = await fetch(`${qdrantBase}/collections/${encodeURIComponent(qdrantCollection)}/points?wait=true`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(qdrantApiKey ? { "api-key": qdrantApiKey } : {})
    },
    body: JSON.stringify({ points })
  });
  if (!response.ok) throw new Error(`Qdrant upsert failed: ${response.status} ${await response.text()}`);
}

async function main(): Promise<void> {
  await ensureQdrantCollection();
  const pgConfig = loadMemoryV2PostgresConfig();
  const pool = new Pool(createPostgresPoolConfig(pgConfig));
  const client = await pool.connect();
  let processed = 0;
  let qdrantBatch: unknown[] = [];

  try {
    await client.query("BEGIN");
    const rl = readline.createInterface({
      input: fs.createReadStream(inputPath, { encoding: "utf8" }),
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      const item = JSON.parse(line) as ExportLine;
      if (!Array.isArray(item.embedding) || item.embedding.length !== 4096) {
        throw new Error(`Invalid embedding dimension for ${item.id}`);
      }

      const metadata = item.metadata ?? {};
      const repo = readString(metadata.repo, item.collection);
      const sourcePath = readString(metadata.source, item.id);
      const sourceRoot = readString(metadata.source_root);
      const chunkIndex = readNumber(metadata.chunk_index);
      const startLine = readNumber(metadata.start_line);
      const endLine = readNumber(metadata.end_line);
      const documentId = buildKnowledgeDocumentId(item.collection, sourcePath);
      const pointId = mapKnowledgeChunkIdToPointId(item.id);
      const contentHash = hashString(item.document);
      const embeddingHash = hashEmbedding(item.embedding);

      await client.query(
        `INSERT INTO knowledge_v1.documents (id, collection, repo, source_root, source_path, metadata, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET
           collection = EXCLUDED.collection,
           repo = EXCLUDED.repo,
           source_root = EXCLUDED.source_root,
           source_path = EXCLUDED.source_path,
           metadata = EXCLUDED.metadata,
           updated_at = now()`,
        [documentId, item.collection, repo, sourceRoot || null, sourcePath, JSON.stringify({ source: "chroma_export" })]
      );

      await client.query(
        `INSERT INTO knowledge_v1.chunks (
           id, document_id, collection, repo, source_path, chunk_index, start_line, end_line,
           content, metadata, embedding_model, embedding_dimension, qdrant_point_id, content_hash, embedding_hash, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, 4096, $12, $13, $14, now())
         ON CONFLICT (id) DO UPDATE SET
           document_id = EXCLUDED.document_id,
           collection = EXCLUDED.collection,
           repo = EXCLUDED.repo,
           source_path = EXCLUDED.source_path,
           chunk_index = EXCLUDED.chunk_index,
           start_line = EXCLUDED.start_line,
           end_line = EXCLUDED.end_line,
           content = EXCLUDED.content,
           metadata = EXCLUDED.metadata,
           embedding_model = EXCLUDED.embedding_model,
           qdrant_point_id = EXCLUDED.qdrant_point_id,
           content_hash = EXCLUDED.content_hash,
           embedding_hash = EXCLUDED.embedding_hash,
           updated_at = now()`,
        [
          item.id,
          documentId,
          item.collection,
          repo,
          sourcePath,
          chunkIndex,
          startLine,
          endLine,
          item.document,
          JSON.stringify(metadata),
          "Qwen3-Embedding-8B",
          pointId,
          contentHash,
          embeddingHash
        ]
      );

      qdrantBatch.push({
        id: pointId,
        vector: item.embedding,
        payload: {
          chunk_id: item.id,
          document_id: documentId,
          collection: item.collection,
          repo,
          source_root: sourceRoot || undefined,
          source_path: sourcePath,
          chunk_index: chunkIndex ?? undefined,
          start_line: startLine ?? undefined,
          end_line: endLine ?? undefined,
          content: item.document,
          content_hash: contentHash,
          embedding_hash: embeddingHash,
          metadata
        }
      });

      processed++;
      if (qdrantBatch.length >= batchSize) {
        await upsertQdrant(qdrantBatch);
        qdrantBatch = [];
        if (processed % 512 === 0) console.log(`processed=${processed}`);
      }
    }

    await upsertQdrant(qdrantBatch);
    await client.query("COMMIT");
    console.log(JSON.stringify({ ok: true, processed, qdrant_collection: qdrantCollection }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
