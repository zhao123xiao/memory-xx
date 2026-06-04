import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRecallQualitySmokeReport } from "../scripts/recall-quality-smoke";

test("recall quality smoke reports missing live configuration", async () => {
  const report = await buildRecallQualitySmokeReport({
    env: {
      MEMORY_XX_DATABASE_URL: "",
      MEMORY_XX_QDRANT_BASE_URL: "",
      EMBEDDING_API_BASE: "",
      MEMORY_XX_WRAPPER_URL: "",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.blockers, [
    "missing_env:MEMORY_XX_DATABASE_URL",
    "missing_env:MEMORY_XX_QDRANT_BASE_URL",
    "missing_env:EMBEDDING_API_BASE",
    "missing_env:MEMORY_XX_WRAPPER_URL",
  ]);
});

test("recall quality smoke validates read-only quality, reranker, and feedback report surfaces", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "memory-xx-recall-quality-smoke-test-"));
  try {
    await writeFile(path.join(runtimeDir, "quality-trace-replay.json"), JSON.stringify({
      ok: false,
      suites: {
        "trace-replay": {
          ok: true,
          report: { totalCases: 0, note: "No positive-feedback recall traces found" },
          threshold_failures: [],
        },
      },
    }), "utf8");
    await writeFile(path.join(runtimeDir, "intelligence-quality.json"), JSON.stringify({
      ok: false,
      compare_sample_size: 20,
      observations: 3,
      write_observations: false,
    }), "utf8");
    await writeFile(path.join(runtimeDir, "trace-feedback-candidates.json"), JSON.stringify({
      ok: true,
      mode: "candidates",
      candidates: [{ recall_trace_id: "trace_1", memory_ids: ["memory_1"] }],
    }), "utf8");
    await writeFile(path.join(runtimeDir, "reranker-policy-benchmark.json"), JSON.stringify({
      ok: true,
      results: [
        { policy: "adaptive", iterations: 1, fallback_rate: 0 },
        { policy: "force_top1", iterations: 1, fallback_rate: 0 },
        { policy: "always", iterations: 1, fallback_rate: 0 },
      ],
    }), "utf8");

    const commands: string[] = [];
    const report = await buildRecallQualitySmokeReport({
      env: {
        MEMORY_XX_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/memory_xx",
        MEMORY_XX_DATABASE_SCHEMA: "memory_xx",
        MEMORY_XX_QDRANT_BASE_URL: "http://127.0.0.1:6333",
        EMBEDDING_API_BASE: "http://127.0.0.1:5221/v1",
        MEMORY_XX_WRAPPER_URL: "http://127.0.0.1:5100",
        MEMORY_XX_API_TOKEN: "test-token",
      },
      runtimeDir,
      runCommand: async (_name, args, outputFile) => {
        commands.push(args.join(" "));
        return outputFile;
      },
      allowDegraded: true,
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.checked_capabilities, ["recall_quality"]);
    assert.equal(report.results.recall_quality?.ok, false);
    assert.equal(report.results.recall_quality?.degraded, true);
    assert.equal(report.degraded, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(commands.some((command) => command.includes("--apply")), false);
    assert.equal(commands.some((command) => command.includes("--write-observations")), false);
    assert.equal(commands.some((command) => command.includes("memory-recall-repair.ts")), false);
    assert.equal(commands.some((command) => command.includes("memory-local-agent-evidence.ts")), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
