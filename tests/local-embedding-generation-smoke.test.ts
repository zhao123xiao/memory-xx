import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildLocalEmbeddingGenerationSmokeReport } from "../scripts/local-embedding-generation-smoke";

test("local embedding generation smoke reports missing live configuration", async () => {
  const report = await buildLocalEmbeddingGenerationSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
      MEMORY_XX_QDRANT_BASE_URL: "",
      EMBEDDING_API_BASE: "",
      OPENAI_API_KEY: "",
      EMBEDDING_API_KEY: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, [
    "missing_env:MEMORY_XX_DATABASE_URL",
    "missing_env:MEMORY_XX_QDRANT_BASE_URL",
    "missing_env:EMBEDDING_API_BASE",
    "missing_env:OPENAI_API_KEY_OR_EMBEDDING_API_KEY",
  ]);
});

test("local embedding generation smoke validates estimate-only report surface", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-local-embedding-generation-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "estimate.json"), JSON.stringify({
      run_id: "local-memory-embedding-test",
      estimate: {
        records: 1,
        concurrency: 1,
        batch_size: 1,
        sampled_latency_ms: {
          latencies: [11],
          p50: 11,
          p95: 11,
          avg: 11,
        },
        estimated_total_ms: 261,
        estimated_total_human: "0s",
        target_collection: "memory-xx-default-v1",
      },
    }), "utf8");

    const commands: string[] = [];
    const report = await buildLocalEmbeddingGenerationSmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
        MEMORY_XX_QDRANT_BASE_URL: "http://127.0.0.1:6333",
        EMBEDDING_API_BASE: "http://127.0.0.1:5221/v1",
        OPENAI_API_KEY: "test-key",
      },
      runtimeDir,
      runCommand: async (_name, args, outputFile) => {
        commands.push(args.join(" "));
        return outputFile;
      },
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.checked_capabilities, ["local_embedding_generation"]);
    assert.equal(report.results.local_embedding_generation?.ok, true);
    assert.equal(report.results.local_embedding_generation?.degraded, false);
    assert.equal(report.degraded, false);
    assert.deepEqual(report.blockers, []);
    assert.match(report.artifacts.local_embedding_generation ?? "", /estimate\.json$/u);
    assert.equal(commands.some((command) => command.includes("--estimate-only")), true);
    assert.equal(commands.some((command) => command.includes("--limit=1")), true);
    assert.equal(commands.some((command) => command.includes("--force-recreate")), false);
    assert.equal(commands.some((command) => command.includes("--target-collection")), false);
    assert.equal(commands.some((command) => command.includes("local-qwen8b-benchmark.ts")), false);
    assert.equal(commands.some((command) => command.includes("generate-embeddings.ts")), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
