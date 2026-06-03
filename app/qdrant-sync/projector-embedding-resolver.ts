import type { QdrantProjectionEmbeddingResolver } from "./projector";
import type { WriteTransactionRunner } from "../db/tx/write-transaction";
import { isPostgresTransactionContext } from "../db/tx/write-transaction";
import { createLogger } from "../shared/logger";

const log = createLogger("embedding-resolver");

interface EmbeddingProvider {
  embed_query(input: { query: string; query_terms: string[] }): Promise<{
    embedding: number[] | null;
    audit: Record<string, unknown>;
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ProjectorEmbeddingResolver implements QdrantProjectionEmbeddingResolver {
  private static deadLetters: Array<{memoryId: string; content: string}> = [];

  private readonly provider: EmbeddingProvider;
  private readonly database: WriteTransactionRunner;
  private readonly maxContentLength = 2000;
  private readonly retryMaxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryBackoffMultiplier: number;

  constructor(options: {
    provider: EmbeddingProvider;
    database: WriteTransactionRunner;
    retry?: {
      maxAttempts?: number;
      baseDelayMs?: number;
      backoffMultiplier?: number;
    };
  }) {
    this.provider = options.provider;
    this.database = options.database;
    this.retryMaxAttempts = options.retry?.maxAttempts ?? 3;
    this.retryBaseDelayMs = options.retry?.baseDelayMs ?? 1000;
    this.retryBackoffMultiplier = options.retry?.backoffMultiplier ?? 2;
  }

  async resolve(input: {
    readonly memory: { id: string; content: string };
    readonly snapshot: unknown;
  }): Promise<readonly number[] | null> {
    const text = input.memory.content?.trim() ?? "";
    if (!text) return null;

    const truncated = text.length > this.maxContentLength
      ? text.substring(0, this.maxContentLength)
      : text;

    let delayMs = this.retryBaseDelayMs;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retryMaxAttempts; attempt++) {
      try {
        const result = await this.provider.embed_query({
          query: truncated,
          query_terms: [],
        });

        const embedding = result.embedding;
        if (!embedding || embedding.length === 0) {
          lastError = new Error("empty_embedding");
          log.warn("embedding returned empty", { memoryId: input.memory.id, attempt });
        } else {
          void this.writeBack(input.memory.id, embedding).catch((err) => {
            log.warn("embedding write-back failed", { memoryId: input.memory.id, error: String(err) });
          });
          return embedding;
        }
      } catch (err) {
        lastError = err;
        log.warn("embedding attempt failed", { memoryId: input.memory.id, attempt, error: String(err) });
      }

      if (attempt < this.retryMaxAttempts) {
        await sleep(delayMs);
        delayMs = Math.round(delayMs * this.retryBackoffMultiplier);
      }
    }

    ProjectorEmbeddingResolver.deadLetters.push({ memoryId: input.memory.id, content: truncated });
    log.error("all embedding attempts exhausted", { memoryId: input.memory.id, error: String(lastError) });
    return null;
  }

  private async writeBack(memoryId: string, embedding: readonly number[]): Promise<void> {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.database.withTransaction(async (tx) => {
          if (isPostgresTransactionContext(tx)) {
            await tx.query(
              `UPDATE memory_records SET content_embedding = $2 WHERE id = $1 AND content_embedding IS NULL`,
              [memoryId, `[${embedding.join(",")}]`]
            );
          }
        });
        return;
      } catch (err) {
        if (attempt === maxAttempts) {
          log.warn("embedding write-back failed after retries", { memoryId, error: String(err) });
        } else {
          await sleep(500);
        }
      }
    }
  }

  static getDeadLetters(): ReadonlyArray<{memoryId: string; content: string}> {
    return ProjectorEmbeddingResolver.deadLetters;
  }

  static clearDeadLetters(): void {
    ProjectorEmbeddingResolver.deadLetters = [];
  }

  static async retryAll(
    provider: EmbeddingProvider,
    database: WriteTransactionRunner
  ): Promise<{retried: number; failed: number}> {
    let retried = 0;
    let failed = 0;
    const letters = ProjectorEmbeddingResolver.deadLetters.splice(0);
    for (const letter of letters) {
      const resolver = new ProjectorEmbeddingResolver({ provider, database });
      const result = await resolver.resolve({
        memory: { id: letter.memoryId, content: letter.content },
        snapshot: undefined
      });
      if (result !== null) {
        retried++;
      } else {
        failed++;
      }
    }
    return { retried, failed };
  }
}
