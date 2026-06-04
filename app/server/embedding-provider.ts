import { createLogger } from "../shared/logger";
import { recordEmbeddingProviderCall } from "../observability/domain-metrics";

const log = createLogger("embedding-provider");

function readPositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface EmbeddingProviderRequestConfig {
  readonly model: string;
  readonly dims: number;
  readonly generation_id: string;
  readonly api_base: string;
}

export function loadEmbeddingProviderRequestConfig(
  env: NodeJS.ProcessEnv = process.env
): EmbeddingProviderRequestConfig {
  const apiBase =
    env.EMBEDDING_PROXY_URL?.trim() ??
    env.EMBEDDING_API_BASE?.trim() ??
    "http://127.0.0.1:5221";
  return {
    model: env.EMBEDDING_MODEL?.trim() || "memory-xx-dev-embedding",
    dims: readPositiveInt(env, "EMBEDDING_DIMS", 4096),
    generation_id: env.MEMORY_XX_EMBEDDING_GENERATION_ID?.trim() || "memory-xx-default-v1",
    api_base: apiBase,
  };
}

export class QwenEmbeddingProviderWrapper {
  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly model: string;
  private readonly dims: number;
  private readonly generationId: string;

  constructor() {
    const requestConfig = loadEmbeddingProviderRequestConfig();
    this.apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
    this.apiBase = requestConfig.api_base;
    this.model = requestConfig.model;
    this.dims = requestConfig.dims;
    this.generationId = requestConfig.generation_id;
    this.timeoutMs = readPositiveInt(
      process.env,
      "MEMORY_XX_QUERY_EMBEDDING_TIMEOUT_MS",
      readPositiveInt(process.env, "EMBEDDING_TIMEOUT_MS", 5000)
    );
    const isLocalProxy = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/u.test(this.apiBase);
    if (!this.apiKey && !isLocalProxy) {
      log.warn("Warning: OPENAI_API_KEY not set, vector retrieval will be unavailable");
    }
  }

  getRequestConfig(): EmbeddingProviderRequestConfig {
    return {
      model: this.model,
      dims: this.dims,
      generation_id: this.generationId,
      api_base: this.apiBase,
    };
  }

  async embed_query(input: {
    query: string;
    query_terms: string[];
  }) {
    const started = Date.now();
    const provider = this.apiBase.includes("127.0.0.1") || this.apiBase.includes("localhost") ? "local-ovms" : "remote";
    const isLocalProxy = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/u.test(this.apiBase);
    if (!this.apiKey && !isLocalProxy) {
      recordEmbeddingProviderCall({ provider, status: "missing_api_key", latencyMs: Date.now() - started });
      return {
        embedding: null,
        audit: {
          fresh_cache_hit: false,
          stale_cache_hit: false,
          attempt_count: 1,
          final_error: "missing_api_key",
          error_code: "CONFIG_MISSING"
        }
      };
    }
    try {
      const url = `${this.apiBase}/embeddings`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          input: [input.query],
          dimensions: this.dims,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        log.warn(`Embedding API error: ${resp.status}`);
        recordEmbeddingProviderCall({ provider, status: `http_${resp.status}`, httpStatus: resp.status, latencyMs: Date.now() - started });
        return {
          embedding: null,
          audit: {
            fresh_cache_hit: false,
            stale_cache_hit: false,
            attempt_count: 1,
            final_error: `embedding_api_${resp.status}`,
            error_code: `HTTP_${resp.status}`
          }
        };
      }
      const data = (await resp.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      const embedding = data.data?.[0]?.embedding ?? null;
      recordEmbeddingProviderCall({ provider, status: embedding ? "ok" : "empty_embedding", latencyMs: Date.now() - started });
      return {
        embedding,
        audit: {
          fresh_cache_hit: false,
          stale_cache_hit: false,
          attempt_count: 1,
          ...(embedding ? {} : { final_error: "empty_embedding", error_code: "UPSTREAM_NULL" })
        }
      };
    } catch (err) {
      log.warn("Embedding API failed", { error: err instanceof Error ? err.message : String(err) });
      recordEmbeddingProviderCall({ provider, status: "error", latencyMs: Date.now() - started });
      return {
        embedding: null,
        audit: {
          fresh_cache_hit: false,
          stale_cache_hit: false,
          attempt_count: 1,
          final_error: err instanceof Error ? err.message : "embedding_api_failed",
          error_code:
            err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string"
              ? (err as { code: string }).code
              : "UPSTREAM_ERROR"
        }
      };
    }
  }
}
