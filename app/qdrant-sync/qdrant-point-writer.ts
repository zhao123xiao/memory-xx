import { loadMemoryV2QdrantConfig, type MemoryV2QdrantConfig } from "../recall/qdrant-config";
import type { QdrantPointUpsert, QdrantPointWriter } from "./projector";
import { recordQdrantTimeout } from "../observability/qdrant-health";

export interface HttpQdrantPointWriterOptions {
  readonly config?: MemoryV2QdrantConfig;
  readonly base_url?: string;
  readonly api_key?: string;
  readonly collection_name?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeout_ms?: number;
}

function readPositiveInt(name: string, fallback: number): number {
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
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class HttpQdrantPointWriter implements QdrantPointWriter {
  private readonly baseUrl?: string;
  private readonly apiKey?: string;
  private readonly collectionName?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpQdrantPointWriterOptions = {}) {
    const config = options.config ?? loadMemoryV2QdrantConfig();
    this.baseUrl = options.base_url ?? config.base_url;
    this.apiKey = options.api_key ?? config.api_key;
    this.collectionName = options.collection_name ?? config.collection_name;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeout_ms ?? readPositiveInt("MEMORY_V2_QDRANT_WRITE_TIMEOUT_MS", 5000);
  }

  async upsert(points: readonly QdrantPointUpsert[]): Promise<void> {
    if (points.length === 0) {
      return;
    }

    await this.request("/points?wait=true", {
      method: "PUT",
      body: JSON.stringify({ points })
    });
  }

  async delete(pointIds: readonly string[]): Promise<void> {
    if (pointIds.length === 0) {
      return;
    }

    await this.request("/points/delete?wait=true", {
      method: "POST",
      body: JSON.stringify({ points: pointIds })
    });
  }

  async retrieve(pointIds: readonly string[]): Promise<ReadonlyMap<string, { readonly payload?: Record<string, unknown> }>> {
    if (pointIds.length === 0) return new Map();
    const raw = await this.requestJson("/points?consistency=all", {
      method: "POST",
      body: JSON.stringify({ ids: pointIds, with_payload: true, with_vector: false })
    });
    const result = raw && typeof raw === "object" && "result" in raw
      ? (raw as { result?: unknown }).result
      : undefined;
    const rows = Array.isArray(result) ? result : [];
    const map = new Map<string, { readonly payload?: Record<string, unknown> }>();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const record = row as { id?: unknown; payload?: unknown };
      if (record.id === undefined) continue;
      map.set(String(record.id), {
        payload: record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
          ? record.payload as Record<string, unknown>
          : undefined
      });
    }
    return map;
  }

  private async request(path: string, init: RequestInit): Promise<void> {
    await this.requestJson(path, init);
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    if (!this.baseUrl || !this.collectionName) {
      throw new Error("Qdrant point writer 尚未配置。");
    }

    let response: Response;
    try {
      response = await withTimeout(this.fetchImpl(
        `${this.baseUrl.replace(/\/$/, "")}/collections/${encodeURIComponent(this.collectionName)}${path}`,
        {
          ...init,
          headers: {
            "content-type": "application/json",
            ...(this.apiKey ? { "api-key": this.apiKey } : {}),
            ...(init.headers ?? {})
          },
          ...(init.signal ? {} : { signal: AbortSignal.timeout(this.timeoutMs) })
        }
      ), this.timeoutMs, "qdrant_write_timeout");
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.message === "qdrant_write_timeout")) {
        recordQdrantTimeout("write");
      }
      throw error;
    }

    if (!response.ok) {
      throw new Error(`Qdrant write failed with status ${response.status}`);
    }
    const text = typeof response.text === "function" ? await response.text() : "";
    return text ? JSON.parse(text) as unknown : null;
  }
}
