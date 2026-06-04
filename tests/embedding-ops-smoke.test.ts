import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildEmbeddingOpsSmokeReport } from "../scripts/embedding-ops-smoke";

test("embedding ops smoke reports missing live configuration", async () => {
  const report = await buildEmbeddingOpsSmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
      MEMORY_XX_QDRANT_BASE_URL: "",
      EMBEDDING_API_BASE: "",
      OPENAI_API_KEY: "",
      EMBEDDING_PROXY_UPSTREAM_API_KEY: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, [
    "missing_env:MEMORY_XX_DATABASE_URL",
    "missing_env:MEMORY_XX_QDRANT_BASE_URL",
    "missing_env:EMBEDDING_API_BASE",
    "missing_env:OPENAI_API_KEY_OR_EMBEDDING_PROXY_UPSTREAM_API_KEY",
  ]);
});

test("embedding ops smoke validates manifest status and calibration report surfaces", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-embedding-ops-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "embedding-manifest-status.json"), JSON.stringify({
      ok: true,
      active_generation: {
        generation_id: "memory-xx-default-v1",
        status: "active",
        target_collection: "memory-xx",
        qdrant_alias: "memory-xx-active",
        payload_sample_verified: true,
      },
      recent_generations: [
        { generation_id: "memory-xx-default-v1", status: "active" },
      ],
      refresh_state: {
        dirty: false,
      },
    }), "utf8");
    await writeFile(path.join(runtimeDir, "embedding-calibration.json"), JSON.stringify({
      run_id: "embedding-calibration-test",
      upstream_base: "http://127.0.0.1:5221/v1",
      model: "memory-xx-dev-embedding",
      dims: 4096,
      matrix: [
        {
          concurrency: 1,
          interval_ms: 500,
          attempted: 1,
          success: 1,
          status_429: 0,
          status_503: 0,
          failed: 0,
          p95_ms: 12,
          effective_rps: 1,
        },
      ],
      recommendation: {
        selected: { concurrency: 1, interval_ms: 500 },
      },
    }), "utf8");

    const commands: string[] = [];
    const report = await buildEmbeddingOpsSmokeReport({
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
    assert.deepEqual(report.checked_capabilities, [
      "embedding_manifest",
      "embedding_calibration",
    ]);
    assert.equal(report.results.embedding_manifest?.ok, true);
    assert.equal(report.results.embedding_manifest?.degraded, false);
    assert.equal(report.results.embedding_calibration?.ok, true);
    assert.equal(report.results.embedding_calibration?.degraded, false);
    assert.equal(report.degraded, false);
    assert.deepEqual(report.blockers, []);
    assert.equal(commands.some((command) => /\b(validate|activate|rollback|refresh|generate|prepare|observe|mark-dirty)\b/u.test(command)), false);
    assert.equal(commands.some((command) => command.includes("generate-local-memory-embeddings")), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
