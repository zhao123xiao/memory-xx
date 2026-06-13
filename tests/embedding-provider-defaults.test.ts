import assert from "node:assert/strict";
import test from "node:test";

import { loadEmbeddingProviderRequestConfig, resolveEmbeddingProviderMetricLabel } from "../app/server/embedding-provider";

test("embedding provider request defaults are provider-neutral", () => {
  const config = loadEmbeddingProviderRequestConfig({});

  assert.equal(config.api_base, "http://127.0.0.1:5221");
  assert.equal(config.model, "memory-xx-dev-embedding");
  assert.equal(config.dims, 4096);
  assert.equal(config.generation_id, "memory-xx-default-v1");
});

test("embedding provider request config keeps explicit local model overrides", () => {
  const config = loadEmbeddingProviderRequestConfig({
    EMBEDDING_API_BASE: "http://127.0.0.1:5221/v1",
    EMBEDDING_MODEL: "Qwen3-Embedding-8B",
    EMBEDDING_DIMS: "4096",
    MEMORY_XX_EMBEDDING_GENERATION_ID: "local-qwen8b-int4-v1",
  });

  assert.equal(config.api_base, "http://127.0.0.1:5221/v1");
  assert.equal(config.model, "Qwen3-Embedding-8B");
  assert.equal(config.dims, 4096);
  assert.equal(config.generation_id, "local-qwen8b-int4-v1");
});

test("embedding provider metric label stays provider-neutral", () => {
  assert.equal(resolveEmbeddingProviderMetricLabel("http://127.0.0.1:5221"), "local");
  assert.equal(resolveEmbeddingProviderMetricLabel("http://localhost:5221/v1"), "local");
  assert.equal(resolveEmbeddingProviderMetricLabel("https://example.invalid/v1"), "remote");
});
