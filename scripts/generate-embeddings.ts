/**
 * Generate embeddings for shadow_r3_20260414.memory_records
 *
 * Reads all approved + is_current records, generates 4096-dim embeddings
 * via Qwen3-Embedding-8B (OpenAI-compatible API), and writes them to
 * the content_embedding column.
 *
 * Usage:
 *   EMBEDDING_API_KEY=<set-private-key> \
 *   EMBEDDING_API_BASE=https://api.scnet.cn/api/llm/v1 \
 *   EMBEDDING_MODEL=Qwen3-Embedding-8B \
 *   MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/memory_xx \
 *   MEMORY_XX_DATABASE_SCHEMA=shadow_r3_20260414 \
 *   node --import tsx scripts/generate-embeddings.ts
 */

import { Pool } from "pg";
import { loadMemoryXXPostgresConfig, createPostgresPoolConfig } from "../app/db/adapters/postgres-config";

// ── Embedding API helpers ──────────────────────────────────────────────────

interface EmbeddingConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  dims: number;
}

function loadEmbeddingConfig(): EmbeddingConfig {
  const apiKey = process.env.EMBEDDING_API_KEY?.trim();
  if (!apiKey) throw new Error("EMBEDDING_API_KEY is required");

  const apiBase = process.env.EMBEDDING_API_BASE?.trim() || "https://api.scnet.cn/api/llm/v1";
  const model = process.env.EMBEDDING_MODEL?.trim() || "Qwen3-Embedding-8B";
  const dims = parseInt(process.env.EMBEDDING_DIMS?.trim() || "4096", 10);

  return { apiKey, apiBase, model, dims };
}

async function fetchEmbeddings(
  texts: string[],
  config: EmbeddingConfig
): Promise<number[][]> {
  const url = `${config.apiBase}/embeddings`;
  const body = {
    model: config.model,
    input: texts,
    dimensions: config.dims
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Embedding API error ${response.status}: ${text.slice(0, 500)}`
    );
  }

  const data = await response.json() as {
    data: Array<{ embedding: number[]; index: number }>;
    usage?: { prompt_tokens: number; total_tokens: number };
  };

  // Sort by index to maintain order
  const sorted = data.data.sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

// ── Main ───────────────────────────────────────────────────────────────────

const BATCH_SIZE = 5;
const SLEEP_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const pgConfig = loadMemoryXXPostgresConfig();
  const embedConfig = loadEmbeddingConfig();

  console.log("=== Generate Embeddings ===");
  console.log(`Schema:      ${pgConfig.schema}`);
  console.log(`API Base:    ${embedConfig.apiBase}`);
  console.log(`Model:       ${embedConfig.model}`);
  console.log(`Dimensions:  ${embedConfig.dims}`);
  console.log(`Batch Size:  ${BATCH_SIZE}`);
  console.log();

  const pool = new Pool(createPostgresPoolConfig(pgConfig));

  try {
    // 1. Load all approved+is_current records that don't have embeddings yet
    const { rows: records } = await pool.query<{
      id: string;
      title: string | null;
      content: string;
    }>(
      `SELECT id, title, content
       FROM ${pgConfig.schema}.memory_records
       WHERE lifecycle_status = 'approved'
         AND review_state = 'not_required'
         AND is_current = true
         AND content_embedding IS NULL
       ORDER BY id`
    );

    console.log(`Records needing embeddings: ${records.length}`);

    if (records.length === 0) {
      console.log("Nothing to do.");
      return;
    }

    // 2. Process in batches
    let processed = 0;
    let errors = 0;

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const texts = batch.map(
        (r) => `${r.title ?? ""} ${r.content}`.trim().slice(0, 8000)
      );

      try {
        const embeddings = await fetchEmbeddings(texts, embedConfig);

        // 3. Update each record
        for (let j = 0; j < batch.length; j++) {
          const record = batch[j];
          const embedding = embeddings[j];
          if (!embedding || embedding.length === 0) {
            console.error(`  ⚠ Empty embedding for record ${record.id}`);
            errors++;
            continue;
          }

          const vectorLiteral = `[${embedding.join(",")}]`;
          await pool.query(
            `UPDATE ${pgConfig.schema}.memory_records
             SET content_embedding = $1::vector
             WHERE id = $2`,
            [vectorLiteral, record.id]
          );
        }

        processed += batch.length;

        if (processed % 50 < BATCH_SIZE || i + BATCH_SIZE >= records.length) {
          console.log(
            `  Progress: ${processed}/${records.length} (${Math.round((processed / records.length) * 100)}%)`
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('429')) {
          // Rate limit: retry with exponential backoff up to 3 times
          let retried = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            const waitMs = SLEEP_MS * Math.pow(2, attempt);
            console.log(`  ⏳ Rate limited, retry ${attempt}/3 in ${waitMs}ms...`);
            await sleep(waitMs);
            try {
              const embeddings = await fetchEmbeddings(texts, embedConfig);
              for (let j = 0; j < batch.length; j++) {
                const record = batch[j];
                const embedding = embeddings[j];
                if (!embedding || embedding.length === 0) {
                  console.error(`  ⚠ Empty embedding for record ${record.id}`);
                  errors++;
                  continue;
                }
                const vectorLiteral = `[${embedding.join(",")}]`;
                await pool.query(
                  `UPDATE ${pgConfig.schema}.memory_records SET content_embedding = $1::vector WHERE id = $2`,
                  [vectorLiteral, record.id]
                );
              }
              processed += batch.length;
              retried = true;
              break;
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              console.error(`  ❌ Retry ${attempt} failed: ${retryMsg.slice(0, 200)}`);
            }
          }
          if (!retried) errors += batch.length;
        } else {
          console.error(
            `  ❌ Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${msg.slice(0, 300)}`
          );
          errors += batch.length;
        }
      }

      // Rate limit: sleep between batches
      if (i + BATCH_SIZE < records.length) {
        await sleep(SLEEP_MS);
      }
    }

    console.log();
    console.log(`Done. Processed: ${processed}, Errors: ${errors}`);

    // 4. Verify
    const { rows: verify } = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(content_embedding) AS with_embedding
       FROM ${pgConfig.schema}.memory_records
       WHERE lifecycle_status = 'approved'
         AND review_state = 'not_required'
         AND is_current = true`
    );
    console.log(
      `Verified: ${verify[0].with_embedding}/${verify[0].total} records have embeddings`
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
