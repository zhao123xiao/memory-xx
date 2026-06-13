#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";

import { createClient } from "redis";

export interface ProviderMatrixSurface {
  readonly name: string;
  readonly env: readonly string[];
  readonly docs: readonly string[];
  readonly static_ok: boolean;
  readonly live_status: "pass" | "skipped" | "missing_env" | "failed";
  readonly evidence: readonly string[];
  readonly blockers: readonly string[];
}

export interface ProviderMatrixEvidence {
  readonly ok: boolean;
  readonly generated_at: string;
  readonly live_required: boolean;
  readonly surfaces: readonly ProviderMatrixSurface[];
  readonly blockers: readonly string[];
}

const providerSurfaces = [
  {
    name: "OpenAI-compatible embedding",
    env: ["EMBEDDING_API_BASE", "EMBEDDING_MODEL", "EMBEDDING_DIMS", "OPENAI_API_KEY"],
    docs: ["README.md", "docs/quickstart.zh-CN.md", "docs/vector-runtime.zh-CN.md", "docs/release-checklist.md"],
  },
  {
    name: "OpenAI-compatible LLM",
    env: ["MEMORY_INTELLIGENCE_BASE_URL", "MEMORY_XX_LLM_UPSTREAM_HEALTH_URL"],
    docs: ["docs/release-checklist.md", "docs/runtime-profiles.md", "docker-compose.yml"],
  },
  {
    name: "OpenAI-compatible reranker",
    env: ["MEMORY_XX_RERANKER_DOWNSTREAM_URL", "MEMORY_XX_RERANKER_DOWNSTREAM_MODELS_URL"],
    docs: ["docs/release-checklist.md", "docs/vector-runtime.zh-CN.md", "docker-compose.yml"],
  },
  {
    name: "Qdrant",
    env: ["MEMORY_XX_QDRANT_BASE_URL", "MEMORY_XX_QDRANT_COLLECTION"],
    docs: ["README.md", "docs/quickstart.zh-CN.md", "docs/release-checklist.md", "docker-compose.yml"],
  },
  {
    name: "Redis",
    env: ["MEMORY_XX_REDIS_URL", "MEMORY_XX_REDIS_PREFIX"],
    docs: ["README.md", "docs/quickstart.zh-CN.md", "docs/release-checklist.md", "docker-compose.yml"],
  },
] as const;

function envEnabled(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function requiredEnvPresent(names: readonly string[]): boolean {
  return names.every((name) => Boolean(process.env[name]?.trim()));
}

async function readDocs(paths: readonly string[]): Promise<string> {
  const contents = await Promise.all(paths.map(async (file) => {
    try {
      return await readFile(file, "utf8");
    } catch {
      return "";
    }
  }));
  return contents.join("\n");
}

async function staticSurfaceEvidence(surface: typeof providerSurfaces[number]): Promise<{
  readonly static_ok: boolean;
  readonly evidence: readonly string[];
  readonly blockers: readonly string[];
}> {
  const content = await readDocs(surface.docs);
  const blockers: string[] = [];
  const evidence: string[] = [];

  if (!content.includes(surface.name)) blockers.push(`provider_surface_missing_doc_label:${surface.name}`);
  else evidence.push(`documented:${surface.name}`);

  for (const envName of surface.env) {
    if (!content.includes(envName)) blockers.push(`provider_surface_missing_doc_env:${surface.name}:${envName}`);
    else evidence.push(`documented_env:${envName}`);
  }

  return {
    static_ok: blockers.length === 0,
    evidence,
    blockers,
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly body?: unknown;
  readonly error?: string;
}> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

async function liveEmbeddingEvidence(): Promise<readonly string[]> {
  const base = trimSlash(process.env.EMBEDDING_API_BASE?.trim() ?? "");
  const model = process.env.EMBEDDING_MODEL?.trim() || "memory-xx-provider-matrix";
  const dims = Number.parseInt(process.env.EMBEDDING_DIMS?.trim() || "0", 10);
  const response = await fetchJson(`${base}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.OPENAI_API_KEY?.trim() ? { authorization: `Bearer ${process.env.OPENAI_API_KEY.trim()}` } : {}),
    },
    body: JSON.stringify({ model, input: "memory-xx provider matrix evidence" }),
  });
  const vector = (response.body as any)?.data?.[0]?.embedding;
  if (!response.ok || !Array.isArray(vector)) {
    throw new Error(`embedding_probe_failed:status=${response.status}:error=${response.error ?? "invalid_body"}`);
  }
  if (dims > 0 && vector.length !== dims) {
    throw new Error(`embedding_probe_dimension_mismatch:expected=${dims}:actual=${vector.length}`);
  }
  return [`embedding_status:${response.status}`, `embedding_dims:${vector.length}`];
}

async function liveLlmEvidence(): Promise<readonly string[]> {
  const base = trimSlash(process.env.MEMORY_INTELLIGENCE_BASE_URL?.trim() ?? "");
  const response = await fetchJson(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.MEMORY_INTELLIGENCE_API_KEY?.trim()
        ? { authorization: `Bearer ${process.env.MEMORY_INTELLIGENCE_API_KEY.trim()}` }
        : {}),
    },
    body: JSON.stringify({
      model: process.env.MEMORY_INTELLIGENCE_MODEL?.trim() || "memory-xx-provider-matrix",
      messages: [{ role: "user", content: "Return a short JSON object." }],
      temperature: 0,
    }),
  });
  if (!response.ok || !Array.isArray((response.body as any)?.choices)) {
    throw new Error(`llm_probe_failed:status=${response.status}:error=${response.error ?? "invalid_body"}`);
  }
  return [`llm_status:${response.status}`, `llm_choices:${(response.body as any).choices.length}`];
}

async function liveRerankerEvidence(): Promise<readonly string[]> {
  const modelsUrl = process.env.MEMORY_XX_RERANKER_DOWNSTREAM_MODELS_URL?.trim();
  const rerankUrl = process.env.MEMORY_XX_RERANKER_DOWNSTREAM_URL?.trim();
  if (!modelsUrl || !rerankUrl) throw new Error("reranker_probe_missing_url");

  const models = await fetchJson(modelsUrl);
  if (!models.ok) throw new Error(`reranker_models_probe_failed:status=${models.status}:error=${models.error ?? "invalid_body"}`);

  const rerank = await fetchJson(rerankUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.MEMORY_XX_RERANKER_API_KEY?.trim()
        ? { authorization: `Bearer ${process.env.MEMORY_XX_RERANKER_API_KEY.trim()}` }
        : {}),
    },
    body: JSON.stringify({
      model: process.env.MEMORY_XX_RERANKER_MODEL?.trim() || "memory-xx-provider-matrix",
      query: "provider matrix",
      documents: ["provider matrix evidence", "unrelated text"],
      top_n: 2,
    }),
  });
  if (!rerank.ok || !Array.isArray((rerank.body as any)?.results)) {
    throw new Error(`reranker_probe_failed:status=${rerank.status}:error=${rerank.error ?? "invalid_body"}`);
  }
  return [`reranker_models_status:${models.status}`, `reranker_status:${rerank.status}`];
}

async function liveQdrantEvidence(): Promise<readonly string[]> {
  const base = trimSlash(process.env.MEMORY_XX_QDRANT_BASE_URL?.trim() ?? "");
  const collection = process.env.MEMORY_XX_QDRANT_COLLECTION?.trim();
  if (!base || !collection) throw new Error("qdrant_probe_missing_url");
  const response = await fetchJson(`${base}/collections/${encodeURIComponent(collection)}`);
  if (!response.ok) throw new Error(`qdrant_probe_failed:status=${response.status}:error=${response.error ?? "invalid_body"}`);
  return [`qdrant_status:${response.status}`, `qdrant_collection:${collection}`];
}

async function liveRedisEvidence(): Promise<readonly string[]> {
  const url = process.env.MEMORY_XX_REDIS_URL?.trim();
  if (!url) throw new Error("redis_probe_missing_url");
  const client = createClient({ url });
  try {
    await client.connect();
    const pong = await client.ping();
    return [`redis_ping:${pong}`, `redis_prefix:${process.env.MEMORY_XX_REDIS_PREFIX?.trim() || "default"}`];
  } finally {
    await client.quit().catch(() => undefined);
  }
}

async function liveSurfaceEvidence(surfaceName: string): Promise<readonly string[]> {
  if (surfaceName === "OpenAI-compatible embedding") return liveEmbeddingEvidence();
  if (surfaceName === "OpenAI-compatible LLM") return liveLlmEvidence();
  if (surfaceName === "OpenAI-compatible reranker") return liveRerankerEvidence();
  if (surfaceName === "Qdrant") return liveQdrantEvidence();
  if (surfaceName === "Redis") return liveRedisEvidence();
  return [];
}

export async function buildProviderMatrixEvidence(): Promise<ProviderMatrixEvidence> {
  const liveRequired = envEnabled("MEMORY_XX_PROVIDER_MATRIX_LIVE");
  const surfaces: ProviderMatrixSurface[] = [];

  for (const surface of providerSurfaces) {
    const staticEvidence = await staticSurfaceEvidence(surface);
    const evidence = [...staticEvidence.evidence];
    const blockers = [...staticEvidence.blockers];
    let liveStatus: ProviderMatrixSurface["live_status"] = "skipped";

    if (liveRequired) {
      if (!requiredEnvPresent(surface.env)) {
        liveStatus = "missing_env";
        for (const envName of surface.env) {
          if (!process.env[envName]?.trim()) blockers.push(`provider_surface_missing_live_env:${surface.name}:${envName}`);
        }
      } else {
        try {
          evidence.push(...await liveSurfaceEvidence(surface.name));
          liveStatus = "pass";
        } catch (error) {
          liveStatus = "failed";
          blockers.push(`provider_surface_live_failed:${surface.name}:${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    surfaces.push({
      name: surface.name,
      env: surface.env,
      docs: surface.docs,
      static_ok: staticEvidence.static_ok,
      live_status: liveStatus,
      evidence,
      blockers,
    });
  }

  const blockers = surfaces.flatMap((surface) => surface.blockers);
  return {
    ok: blockers.length === 0,
    generated_at: new Date().toISOString(),
    live_required: liveRequired,
    surfaces,
    blockers,
  };
}

async function main(): Promise<void> {
  const report = await buildProviderMatrixEvidence();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
